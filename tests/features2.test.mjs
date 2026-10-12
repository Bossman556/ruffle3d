// Tests for sketch-v2 features and the advanced modelling tools: `node tests/features2.test.mjs`
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { rebuild, properties, interference, projectViews } from '../src/kernel/build.js';
import { STD_PLANES } from '../src/geom2d.js';

const root = path.dirname(fileURLToPath(import.meta.url));
setOC(await opencascade({ locateFile: () => path.join(root, '../node_modules/replicad-opencascadejs/dist/replicad_single.wasm') }));

let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };
const near = (a, b, e = 1e-3) => Math.abs(a - b) < e;

function rect(pre, x0, y0, x1, y1) {
  const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y], i) => ({ id: `${pre}p${i}`, x, y }));
  return {
    points: pts,
    curves: pts.map((p, i) => ({ id: `${pre}l${i}`, type: 'line', a: p.id, b: pts[(i + 1) % 4].id })),
    constraints: [
      { id: `${pre}h0`, type: 'horizontal', line: `${pre}l0` }, { id: `${pre}h2`, type: 'horizontal', line: `${pre}l2` },
      { id: `${pre}v1`, type: 'vertical', line: `${pre}l1` }, { id: `${pre}v3`, type: 'vertical', line: `${pre}l3` },
    ],
    dims: [],
  };
}
const merge = (...s) => ({ points: s.flatMap((x) => x.points), curves: s.flatMap((x) => x.curves), constraints: s.flatMap((x) => x.constraints), dims: s.flatMap((x) => x.dims) });

// constrained rectangle 60 x 40 anchored at origin, with a Ø10 hole centred by dims
const base = rect('a', 0, 0, 55, 37);
base.constraints.push({ id: 'org', type: 'coincident', a: 'ap0', b: 'O' });
base.dims.push({ id: 'w', type: 'length', line: 'al0', value: 60 }, { id: 'h', type: 'length', line: 'al1', value: 40 });
base.points.push({ id: 'hc', x: 25, y: 18 });
base.curves.push({ id: 'hole', type: 'circle', c: 'hc', r: 4 });
base.dims.push({ id: 'hd', type: 'diameter', curve: 'hole', value: 10 }, { id: 'hx', type: 'hdist', a: 'O', b: 'hc', value: 30 }, { id: 'hy', type: 'vdist', a: 'O', b: 'hc', value: 20 });

const path2 = { points: [{ id: 'q0', x: 0, y: 0 }, { id: 'q1', x: 0, y: 40 }, { id: 'q2', x: 30, y: 40 }], curves: [{ id: 'm0', type: 'line', a: 'q0', b: 'q1' }, { id: 'm1', type: 'line', a: 'q1', b: 'q2' }], constraints: [], dims: [] };
const circ = { points: [{ id: 'cc', x: 0, y: 0 }], curves: [{ id: 'cr', type: 'circle', c: 'cc', r: 3 }, { id: 'cr2', type: 'circle', c: 'cc', r: 2 }], constraints: [], dims: [] };

const features = [
  { id: 'pl', type: 'plane', p: { mode: 'offset', base: { type: 'std', name: 'XY' }, distance: 10 } },
  { id: 'sk', type: 'sketch', p: { planeRef: { type: 'plane', id: 'pl' }, ...base } },
  { id: 'ex', type: 'extrude', p: { sketch: 'sk', profiles: [], side: 'one', distance: 8, op: 'new' } },
  { id: 'exDisc', type: 'extrude', p: { sketch: 'sk', profiles: [[30, 20]], side: 'one', distance: -5, op: 'new' } },
  // sketch on the top face of the plate (z = 18)
  { id: 'sk2', type: 'sketch', p: { planeRef: { type: 'face', body: 'ex', p: [5, 5, 18], n: [0, 0, 1] }, ...rect('b', 2, 2, 12, 12) } },
  { id: 'ex2', type: 'extrude', p: { sketch: 'sk2', profiles: [], side: 'one', distance: 5, op: 'join', target: 'ex' } },
  { id: 'pp', type: 'presspull', p: { faces: [{ body: 'ex', p: [60, 5, 14], n: [1, 0, 0], u: [1, 0.125, 4 / 13] }], distance: 6 } },
  { id: 'skP', type: 'sketch', p: { planeRef: { type: 'std', name: 'XZ' }, ...path2 } },
  { id: 'skC', type: 'sketch', p: { planeRef: { type: 'std', name: 'XY' }, ...circ } },
  { id: 'sw', type: 'sweep', p: { sketch: 'skC', profiles: [], path: 'skP', op: 'new' } },
  { id: 'bx', type: 'box', p: { w: 20, d: 20, h: 20, x: -60, y: 0, z: 0, op: 'new' } },
  { id: 'dr', type: 'draft', p: { faces: [{ body: 'bx', p: [-50, 0, 10], n: [1, 0, 0] }], angle: 5, plane: { type: 'std', name: 'XY' } } },
  { id: 'sp', type: 'split', p: { body: 'bx', plane: { type: 'std', name: 'XZ' } } },
  { id: 'cyl', type: 'cylinder', p: { r: 5, h: 10, axis: 'Z', x: 0, y: -60, z: 0, op: 'new' } },
  { id: 'jt', type: 'joint', p: { moving: [{ body: 'cyl', p: [0, -60, 0], n: [0, 0, -1] }], fixed: [{ body: 'ex', p: [10, 30, 18], n: [0, 0, 1] }], type: 'rigid', offset: 0, angle: 0 } },
  { id: 'mpl', type: 'plane', p: { mode: 'angle', base: { type: 'std', name: 'YZ' }, axis: 'x', angle: 0, distance: 100 } },
  { id: 'mi', type: 'mirror', p: { bodies: ['sw'], plane: { type: 'plane', id: 'mpl' }, offset: 0, join: false } },
  { id: 'pin', type: 'cylinder', p: { r: 4.9, h: 30, axis: 'Z', x: 200, y: 0, z: 0, op: 'new' } },
  { id: 'jt2', type: 'joint', p: { moving: [{ body: 'pin', p: [204.9, 0, 15], n: [1, 0, 0] }], fixed: [{ body: 'ex', p: [25, 20, 14], n: [1, 0, 0] }], type: 'revolute', offset: 0, angle: 0 } },
  { id: 'hl', type: 'hole', p: { points: [{ body: 'ex', p: [50, 10, 18], n: [0, 0, 1] }], diameter: 4, through: true, csink: true, csinkD: 8 } },
];

const t0 = Date.now();
const { states, errors, warnings } = await rebuild(features);
console.log(`rebuild ${Date.now() - t0} ms`, 'errors:', errors, 'warnings:', warnings);
const at = (id) => states[features.findIndex((f) => f.id === id)];
const fin = states.at(-1);
const vol = (s, id) => properties(s.bodies.get(id)).volume;
const bbox = (s, id) => properties(s.bodies.get(id)).bbox;

check('no errors', !Object.keys(errors).length);
check('constrained sketch on offset plane', near(bbox(at('ex'), 'ex')[0][2], 10) && near(bbox(at('ex'), 'ex')[1][0], 60), JSON.stringify(bbox(at('ex'), 'ex')));
check('default profile = plate with hole', near(vol(at('ex'), 'ex'), (2400 - 25 * Math.PI) * 8, 0.5), vol(at('ex'), 'ex').toFixed(1));
check('picked inner region extrudes the disc only', near(vol(at('exDisc'), 'exDisc'), 25 * Math.PI * 5, 0.1) && near(bbox(at('exDisc'), 'exDisc')[0][2], 5), vol(at('exDisc'), 'exDisc').toFixed(2));
check('sketch on face sits on top face', near(bbox(at('ex2'), 'ex')[1][2], 23), JSON.stringify(bbox(at('ex2'), 'ex')[1]));
check('press-pull extended the +X face by 6', near(bbox(at('pp'), 'ex')[1][0], 66), JSON.stringify(bbox(at('pp'), 'ex')[1]));
const tube = (9 - 4) * Math.PI * 70;
check('sweep makes a tube along an L path', vol(at('sw'), 'sw') > tube * 0.9 && vol(at('sw'), 'sw') < tube * 1.1, `${vol(at('sw'), 'sw').toFixed(1)} vs ~${tube.toFixed(1)}`);
check('draft changed the box', !near(vol(at('dr'), 'bx'), 8000, 1), vol(at('dr'), 'bx').toFixed(1));
check('split made two bodies', fin.bodies.has('sp#0') && fin.bodies.has('bx'));
const jb = bbox(fin, 'cyl');
check('joint placed cylinder on plate top', near(jb[0][2], 18, 0.01) && near((jb[0][0] + jb[1][0]) / 2, 10, 0.5) && near((jb[0][1] + jb[1][1]) / 2, 30, 0.5), JSON.stringify(jb));
const pb = bbox(fin, 'pin');
check('pin-in-hole joint is coaxial and centred', near((pb[0][0] + pb[1][0]) / 2, 30, 1e-3) && near((pb[0][1] + pb[1][1]) / 2, 20, 1e-3) && near((pb[0][2] + pb[1][2]) / 2, 14, 1e-3), JSON.stringify(pb));
check('joint info recorded', fin.joints.get('jt')?.type === 'rigid');
const mb = bbox(fin, 'mi#0'), sb = bbox(fin, 'sw');
check('mirror about construction plane x=100', near(mb[0][0], 200 - sb[1][0], 0.01), `${mb[0][0].toFixed(2)} vs ${(200 - sb[1][0]).toFixed(2)}`);
check('countersunk hole removed material', vol(fin, 'ex') < vol(at('pp'), 'ex'));

// parametric: change the sketch width dimension → plate follows
const f2 = structuredClone(features);
f2[1].p.dims.find((d) => d.id === 'w').value = 80;
const r2 = await rebuild(f2);
check('changing a sketch dimension rebuilds downstream', near(properties(r2.states[2].bodies.get('ex')).bbox[1][0], 80), JSON.stringify(properties(r2.states[2].bodies.get('ex')).bbox[1]));
check('press-pull follows (bbox-relative pick)', !r2.errors.pp, r2.errors.pp || '');

// interference + drawings
const inter = interference([['a', fin.bodies.get('ex')], ['b', fin.bodies.get('exDisc')], ['c', fin.bodies.get('cyl')]]);
check('interference finds no false overlap for touching joint', !inter.some((x) => x.b === 'c' || x.a === 'c'), JSON.stringify(inter.map((x) => [x.a, x.b, x.volume.toFixed(2)])));
const t1 = Date.now();
const views = projectViews([fin.bodies.get('ex')], ['front', 'top', 'right', 'iso']);
console.log(`projections ${Date.now() - t1} ms`, views.map((v) => `${v.view}: ${v.visible.length} paths, bbox ${JSON.stringify(v.bbox?.map((p) => p.map((x) => +x.toFixed(1))))}`));
check('drawing views have geometry', views.every((v) => v.visible.length > 0));
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
