// Smoke test of the CAD kernel in Node: `node tests/kernel.test.mjs`
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { rebuild, meshShape, properties, exportShapes } from '../src/kernel/build.js';
import { STD_PLANES } from '../src/geom2d.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const wasm = path.join(root, '../node_modules/replicad-opencascadejs/dist/replicad_single.wasm');
const OC = await opencascade({ locateFile: () => wasm });
setOC(OC);

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`);
  if (!cond) failures++;
};
const P = (o) => ({ x: 0, y: 0, z: 0, op: 'new', target: '', ...o });

const features = [
  { id: 'b1', type: 'box', p: P({ w: 50, d: 30, h: 20 }) },
  { id: 'f1', type: 'fillet', p: { edges: [{ body: 'b1', p: [25, 0, 20] }], radius: 3 } },
  { id: 'h1', type: 'hole', p: { points: [{ body: 'b1', p: [0, 0, 20], n: [0, 0, 1] }], diameter: 6, depth: 10, through: true } },
  { id: 's1', type: 'sketch', p: { plane: STD_PLANES.XY, entities: [
    { type: 'rect', a: [-10, 40], b: [10, 60] },
    { type: 'circle', c: [0, 50], r: 4 },
  ] } },
  { id: 'e1', type: 'extrude', p: { sketch: 's1', side: 'one', distance: 15, twist: 0, op: 'new' } },
  { id: 'e2', type: 'extrude', p: { sketch: 's1', side: 'symmetric', distance: -5, op: 'new' } },
  { id: 'sh', type: 'shell', p: { faces: [{ body: 'e1', p: [0, 45, 15], n: [0, 0, 1] }], thickness: 1.5, dir: 'inside' } },
  { id: 'cy', type: 'cylinder', p: P({ r: 5, h: 40, axis: 'Z', x: 60 }) },
  { id: 'cp', type: 'cpattern', p: { bodies: ['cy'], axis: 'Z', cx: 0, cy: 0, cz: 0, count: 4, angle: 360, join: false } },
  { id: 'to', type: 'torus', p: P({ R: 20, r: 4, z: 60 }) },
  { id: 'co', type: 'cone', p: P({ r1: 10, r2: 3, h: 20, x: -60 }) },
  { id: 's2', type: 'sketch', p: { plane: STD_PLANES.XZ, entities: [{ type: 'polyline', closed: true, pts: [[80, 0], [90, 0], [90, 10], [85, 15], [80, 10]] }] } },
  { id: 'rv', type: 'revolve', p: { sketch: 's2', axis: 'Z', angle: 360, op: 'new' } },
  { id: 'mv', type: 'move', p: { bodies: ['co'], dx: 0, dy: -40, dz: 0, rx: 0, ry: 0, rz: 45, pivot: 'center', copy: true } },
  { id: 'mi', type: 'mirror', p: { bodies: ['to'], plane: 'XY', offset: 0, join: false } },
  { id: 'cb', type: 'combine', p: { target: 'b1', tools: ['e2'], op: 'cut', keep: false } },
  { id: 'bad', type: 'fillet', p: { edges: [{ body: 'b1', p: [999, 999, 999] }], radius: 2 } },
];

let t = Date.now();
const { states, errors } = await rebuild(features);
console.log(`rebuild: ${Date.now() - t} ms`);
const final = states[states.length - 1];
console.log('bodies:', [...final.bodies.keys()].join(', '));
console.log('errors:', errors);

const vol = (id) => properties(final.bodies.get(id)).volume;
check('box filleted+holed volume < 30000', vol('b1') < 30000 && vol('b1') > 20000, vol('b1').toFixed(1));
const s = states[features.findIndex((f) => f.id === 'e1')];
check('extrude with hole', Math.abs(properties(s.bodies.get('e1')).volume - (400 - Math.PI * 16) * 15) < 1, properties(s.bodies.get('e1')).volume.toFixed(1));
check('shell hollowed inside', vol('e1') < (400 - Math.PI * 16) * 15 * 0.6, vol('e1').toFixed(1));
const bbE1 = properties(final.bodies.get('e1')).bbox;
check('shell inside keeps outer size', Math.abs(bbE1[1][0] - 10) < 0.01, JSON.stringify(bbE1));
check('pattern created 3 copies', ['cp#0_1', 'cp#0_2', 'cp#0_3'].every((k) => final.bodies.has(k)));
check('torus volume', Math.abs(vol('to') - 2 * Math.PI ** 2 * 20 * 16) < 5, vol('to').toFixed(1));
check('cone volume', Math.abs(vol('co') - (Math.PI * 20 / 3) * (100 + 30 + 9)) < 5, vol('co').toFixed(1));
check('revolve made a ring', vol('rv') > 1000, vol('rv').toFixed(1));
check('move copy exists', final.bodies.has('mv#0'));
check('mirror below origin', properties(final.bodies.get('mi#0')).bbox[1][2] < -50);
check('combine removed tool', !final.bodies.has('e2'));
check('bad fillet reports error', !!errors.bad, errors.bad);
const bbSym = properties(states[5].bodies.get('e2')).bbox;
check('symmetric extrude spans -5..5', Math.abs(bbSym[0][2] + 5) < 0.01 && Math.abs(bbSym[1][2] - 5) < 0.01, JSON.stringify(bbSym));
const bbBox = properties(states[0].bodies.get('b1')).bbox;
check('box base sits on z=0, centered XY', Math.abs(bbBox[0][2]) < 1e-6 && Math.abs(bbBox[0][0] + 25) < 1e-6, JSON.stringify(bbBox));

const m = meshShape(final.bodies.get('b1')).mesh;
const triCount = m.triangles.length / 3;
const lastFace = m.faceGroups[m.faceGroups.length - 1];
console.log('faceGroups sample', m.faceGroups.slice(0, 2), 'triangles idx len', m.triangles.length);
console.log('edgeGroups sample', m.edgeGroups.slice(0, 2), 'lines len', m.lines.length);
check('faceGroups cover triangle index array', lastFace.start + lastFace.count === m.triangles.length || lastFace.start + lastFace.count === triCount,
  `${lastFace.start + lastFace.count} vs idx ${m.triangles.length} / tris ${triCount}`);
const lastEdge = m.edgeGroups[m.edgeGroups.length - 1];
console.log('edge coverage', lastEdge.start + lastEdge.count, 'lines/3 =', m.lines.length / 3, 'lines/6 =', m.lines.length / 6);

// Cache: change the last feature only → fast
t = Date.now();
features[features.length - 1] = { ...features[features.length - 1], p: { ...features[features.length - 1].p, radius: 1 } };
await rebuild(features);
const dt = Date.now() - t;
check('prefix cache makes tail edit fast', dt < 500, `${dt} ms`);

const step = exportShapes([{ shape: final.bodies.get('b1'), name: 'Body1' }], 'step');
const stl = exportShapes([{ shape: final.bodies.get('b1') }, { shape: final.bodies.get('to') }], 'stl');
check('STEP export', step.size > 1000, `${step.size} bytes`);
check('STL export', stl.size > 1000, `${stl.size} bytes`);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
