// Rib: a web from an open sketch line, filled out to the walls of the part.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { rebuild, properties } from '../src/kernel/build.js';

const root = path.dirname(fileURLToPath(import.meta.url));
setOC(await opencascade({ locateFile: () => path.join(root, '../node_modules/replicad-opencascadejs/dist/replicad_single.wasm') }));
let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };
const near = (a, b, e = 1e-3) => Math.abs(a - b) < e;

// an L bracket: wall x 0..5, base z 0..5, both 30 deep (y −15..15); 11 250 mm³
const bracket = [
  { id: 'w', type: 'box', p: { w: 5, d: 30, h: 40, x: 2.5, y: 0, z: 0, op: 'new' } },
  { id: 'b', type: 'box', p: { w: 40, d: 30, h: 5, x: 20, y: 0, z: 0, op: 'join', target: 'w' } },
];
// a sketch on the XZ plane (u = x, v = z) through the middle of the bracket
const line = (pts) => ({
  id: 'sk', type: 'sketch', p: {
    planeRef: { type: 'std', name: 'XZ' },
    points: pts.map(([x, y], i) => ({ id: `p${i}`, x, y })),
    curves: pts.slice(1).map((_, i) => ({ id: `l${i}`, type: 'line', a: `p${i}`, b: `p${i + 1}` })),
    constraints: [], dims: [],
  },
});
const rib = (extra = {}) => ({ id: 'r', type: 'rib', p: { sketch: 'sk', body: 'w', thickness: 4, thick: 'mid', side: 'auto', ...extra } });
const vol = (r) => properties(r.states.at(-1).bodies.get('w')).volume;

let r = await rebuild(bracket);
const V0 = vol(r);
check('the bracket is 11 250 mm³', near(V0, 11250));

// a diagonal gusset from the wall (x = 5, z = 30) to the base (x = 30, z = 5): a 25 × 25 triangle, 4 thick
r = await rebuild([...bracket, line([[5, 30], [30, 5]]), rib()]);
check('a gusset adds ½ · 25 · 25 · 4 = 1250 mm³', !r.errors.r && near(vol(r) - V0, 1250), r.errors.r || (vol(r) - V0).toFixed(4));
const bb = properties(r.states.at(-1).bodies.get('w')).bbox;
check('the bracket stays the same size', near(bb[1][0], 40) && near(bb[1][2], 40) && near(bb[0][1], -15) && near(bb[1][1], 15));

// a line drawn short of the walls still reaches them (its ends are extended)
r = await rebuild([...bracket, line([[10, 25], [25, 10]]), rib()]);
check('a short line is extended to the walls', !r.errors.r && near(vol(r) - V0, 1250), r.errors.r || (vol(r) - V0).toFixed(4));

// the thickness can sit on one side of the sketch plane: same volume, shifted
r = await rebuild([...bracket, line([[5, 30], [30, 5]]), rib({ thick: 'front' })]);
check('a one-sided rib has the same volume', !r.errors.r && near(vol(r) - V0, 1250), r.errors.r);

// a two-segment rib: a horizontal step then down to the base
r = await rebuild([...bracket, line([[5, 20], [20, 20], [30, 5]]), rib()]);
// region under the polyline: rectangle 5..20 × 5..20 plus triangle (20,5),(20,20),(30,5)
const A = 15 * 15 + 0.5 * 10 * 15;
check('a polyline rib fills the area under it', !r.errors.r && near(vol(r) - V0, A * 4), r.errors.r || `${(vol(r) - V0).toFixed(3)} vs ${A * 4}`);

// the other side of the line is open, so it cannot be flipped
r = await rebuild([...bracket, line([[5, 30], [30, 5]]), rib({ side: 'flip' })]);
check('flipping to the open side gives a clear error', /cannot be flipped/.test(r.errors.r || ''), r.errors.r);

// a line that misses the part
r = await rebuild([...bracket, line([[60, 60], [80, 70]]), rib()]);
check('a line away from the part gives a clear error', /does not reach the body/.test(r.errors.r || ''), r.errors.r);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
