// Threads (ISO metric, external and internal) and coil springs.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { rebuild, properties, hasSolid, meshShape } from '../src/kernel/build.js';
import { build3MF } from '../src/export3mf.js';
import { inflateRawSync } from 'node:zlib';

const root = path.dirname(fileURLToPath(import.meta.url));
setOC(await opencascade({ locateFile: () => path.join(root, '../node_modules/replicad-opencascadejs/dist/replicad_single.wasm') }));
let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };
const near = (a, b, e = 1e-3) => Math.abs(a - b) < e;

// M10 bolt shank: Ø10 × 20, thread the full length
const shank = { id: 'b', type: 'cylinder', p: { r: 5, h: 20, axis: 'Z', x: 0, y: 0, z: 0, op: 'new' } };
let r = await rebuild([shank, { id: 't', type: 'thread', p: { face: [{ body: 'b', p: [5, 0, 10], n: [1, 0, 0] }], size: 'M10', full: true, offset: 0, hand: 'right' } }]);
let b = r.states.at(-1).bodies.get('b');
const v0 = Math.PI * 25 * 20;
check('external M10 thread builds', !r.errors.t && b && hasSolid(b), r.errors.t || r.warnings.t);
const v1 = b && properties(b).volume;
// a 60° V groove of depth 0.6134·P over the length removes roughly a quarter of the outer annulus
check('thread removes material', v1 < v0 - 60 && v1 > v0 * 0.8, `${v0.toFixed(0)} → ${v1?.toFixed(0)}`);
check('no size warning for a true Ø10 shank', !r.warnings.t, r.warnings.t);

// partial length, left-hand
r = await rebuild([shank, { id: 't', type: 'thread', p: { face: [{ body: 'b', p: [5, 0, 10], n: [1, 0, 0] }], size: 'M10', full: false, length: 8, offset: 2, hand: 'left' } }]);
const vp = properties(r.states.at(-1).bodies.get('b')).volume;
check('partial left-hand thread removes less', !r.errors.t && vp > v1 && vp < v0, `${vp.toFixed(0)}`);

// internal thread in a tapped hole (Ø8.4 tap drill for M10 is not needed: we thread an Ø8.5 hole)
r = await rebuild([
  { id: 'blk', type: 'box', p: { w: 30, d: 30, h: 15, x: 0, y: 0, z: 0, op: 'new' } },
  { id: 'h', type: 'cylinder', p: { r: 4.25, h: 15, axis: 'Z', x: 0, y: 0, z: 0, op: 'cut', target: 'blk' } },
  { id: 'it', type: 'thread', p: { face: [{ body: 'blk', p: [4.25, 0, 7.5], n: [-1, 0, 0] }], size: 'M10', full: true, offset: 0 } },
]);
const blk = r.states.at(-1).bodies.get('blk');
const vh = 30 * 30 * 15 - Math.PI * 4.25 ** 2 * 15;
check('internal thread cuts outward into the block', !r.errors.it && properties(blk).volume < vh - 30, r.errors.it || properties(blk).volume.toFixed(0));
check('internal M10 on an Ø8.5 hole has no size warning', !r.warnings.it, r.warnings.it);

// size mismatch warns
r = await rebuild([{ id: 'b', type: 'cylinder', p: { r: 3, h: 10, axis: 'Z', x: 0, y: 0, z: 0, op: 'new' } }, { id: 't', type: 'thread', p: { face: [{ body: 'b', p: [3, 0, 5], n: [1, 0, 0] }], size: 'M10', full: true, offset: 0 } }]);
check('wrong size warns', !r.errors.t && /expects/.test(r.warnings.t || ''), r.warnings.t);
// non-cylindrical face errors clearly
r = await rebuild([{ id: 'bx', type: 'box', p: { w: 10, d: 10, h: 10, x: 0, y: 0, z: 0, op: 'new' } }, { id: 't', type: 'thread', p: { face: [{ body: 'bx', p: [0, 0, 10], n: [0, 0, 1] }], size: 'M10', full: true } }]);
check('thread on a flat face reports a clear error', /cylindrical/.test(r.errors.t || ''), r.errors.t);

// coil spring volume = wire area × helix length
r = await rebuild([{ id: 'c', type: 'coil', p: { radius: 10, pitch: 4, turns: 5, section: 2.4, axis: 'Z', hand: 'right', x: 0, y: 0, z: 0, op: 'new' } }]);
const cv = properties(r.states.at(-1).bodies.get('c')).volume;
const expC = Math.PI * 1.2 ** 2 * Math.hypot(2 * Math.PI * 10, 4) * 5;
check('coil spring volume matches wire × helix length', !r.errors.c && near(cv, expC, expC * 1e-3), `${cv.toFixed(1)} vs ${expC.toFixed(1)}`);
r = await rebuild([{ id: 'c', type: 'coil', p: { radius: 10, pitch: 2, turns: 5, section: 2.4, axis: 'Z', x: 0, y: 0, z: 0, op: 'new' } }]);
check('overlapping coil is rejected', /overlap/.test(r.errors.c || ''), r.errors.c);

// 3MF: a box exports as a closed, welded mesh (8 vertices, 12 triangles) inside a valid ZIP
r = await rebuild([{ id: 'bx', type: 'box', p: { w: 10, d: 20, h: 30, x: 0, y: 0, z: 0, op: 'new' } }]);
const m = meshShape(r.states.at(-1).bodies.get('bx')).mesh;
const z = Buffer.from(await build3MF([{ name: 'Box', color: '#1764c4', positions: m.vertices, index: m.triangles }], 'Test'));
const files = {};
for (let i = z.length - 22, n = z.readUInt16LE(i + 10), o = z.readUInt32LE(i + 16), k = 0; k < n; k++) {
  const nl = z.readUInt16LE(o + 28), el = z.readUInt16LE(o + 30), cl = z.readUInt16LE(o + 32), lo = z.readUInt32LE(o + 42), name = z.toString('utf8', o + 46, o + 46 + nl);
  const method = z.readUInt16LE(lo + 8), size = z.readUInt32LE(lo + 18), lnl = z.readUInt16LE(lo + 26), lel = z.readUInt16LE(lo + 28);
  const raw = z.subarray(lo + 30 + lnl + lel, lo + 30 + lnl + lel + size);
  files[name] = (method === 8 ? inflateRawSync(raw) : raw).toString('utf8');
  o += 46 + nl + el + cl;
}
const model = files['3D/3dmodel.model'] || '';
check('3MF package has content types, relationships and model', !!files['[Content_Types].xml'] && !!files['_rels/.rels'] && model.includes('unit="millimeter"'), Object.keys(files).join(', '));
check('3MF box mesh is welded: 8 vertices, 12 triangles', (model.match(/<vertex /g) || []).length === 8 && (model.match(/<triangle /g) || []).length === 12);
check('3MF carries the body colour', model.includes('displaycolor="#1764C4FF"'));

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
