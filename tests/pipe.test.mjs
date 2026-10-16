// Pipe: a round tube or bar swept along a path sketch.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { rebuild, properties } from '../src/kernel/build.js';

const root = path.dirname(fileURLToPath(import.meta.url));
setOC(await opencascade({ locateFile: () => path.join(root, '../node_modules/replicad-opencascadejs/dist/replicad_single.wasm') }));
let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };
const rel = (a, b, e) => Math.abs(a - b) / Math.abs(b) < e;

const sk = (points, curves) => ({ id: 'sk', type: 'sketch', p: { planeRef: { type: 'std', name: 'XY' }, points: points.map(([x, y], i) => ({ id: `p${i}`, x, y })), curves, constraints: [], dims: [] } });
const pipe = (extra = {}) => ({ id: 'pp', type: 'pipe', p: { sketch: 'sk', od: 20, wall: 2, op: 'new', ...extra } });
const vol = (r) => (r.errors.pp ? r.errors.pp : properties(r.states.at(-1).bodies.get('pp')).volume);
const A = Math.PI * (10 ** 2 - 8 ** 2);

// straight 100 mm tube
let r = await rebuild([sk([[0, 0], [100, 0]], [{ id: 'l', type: 'line', a: 'p0', b: 'p1' }]), pipe()]);
check('a straight tube: π(R² − r²) · 100', rel(vol(r), A * 100, 1e-6), vol(r));
r = await rebuild([sk([[0, 0], [100, 0]], [{ id: 'l', type: 'line', a: 'p0', b: 'p1' }]), pipe({ wall: 0 })]);
check('wall 0 gives a solid bar', rel(vol(r), Math.PI * 100 * 100, 1e-6), vol(r));
// an L with a 30 mm bend: by Pappus the volume is the section area times the centre-line length
r = await rebuild([sk([[0, 0], [50, 0], [50, 30], [80, 30], [80, 80]], [
  { id: 'l1', type: 'line', a: 'p0', b: 'p1' }, { id: 'a', type: 'arc', c: 'p2', a: 'p1', b: 'p3' }, { id: 'l2', type: 'line', a: 'p3', b: 'p4' }]), pipe()]);
const Lc = 50 + (Math.PI / 2) * 30 + 50;
check('a bent tube: section area × centre-line length', rel(vol(r), A * Lc, 1e-4), `${vol(r)} vs ${(A * Lc).toFixed(3)}`);
// a closed ring
r = await rebuild([sk([[0, 0]], [{ id: 'c', type: 'circle', c: 'p0', r: 40 }]), pipe()]);
check('a ring round a circle path', rel(vol(r), A * 2 * Math.PI * 40, 1e-4), vol(r));
r = await rebuild([sk([[0, 0], [100, 0]], [{ id: 'l', type: 'line', a: 'p0', b: 'p1' }]), pipe({ wall: 12 })]);
check('a wall thicker than the radius is refused', /thinner than the radius/.test(vol(r)), vol(r));

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
