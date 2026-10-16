// Variable-radius fillets and unequal chamfers (two distances, distance and angle).
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

// a 40 × 30 × 20 block; the top edge along X at y = 15
const box = { id: 'b', type: 'box', p: { w: 40, d: 30, h: 20, x: 0, y: 0, z: 0, op: 'new' } };
const V0 = 40 * 30 * 20;
const edge = [{ body: 'b', p: [0, 15, 20] }];
const removed = async (f) => { const r = await rebuild([box, { id: 'f', ...f }]); return r.errors.f ? r.errors.f : V0 - properties(r.states.at(-1).bodies.get('b')).volume; };

let v = await removed({ type: 'chamfer', p: { edges: edge, distance: 2 } });
check('an equal chamfer still works (½ · 2 · 2 · 40)', near(v, 80), v);
v = await removed({ type: 'chamfer', p: { edges: edge, mode: 'two', distance: 4, distance2: 2 } });
check('two distances: ½ · 4 · 2 · 40 = 160', near(v, 160), v);
const r1 = await rebuild([box, { id: 'f', type: 'chamfer', p: { edges: edge, mode: 'two', distance: 4, distance2: 2 } }]);
const r2 = await rebuild([box, { id: 'f', type: 'chamfer', p: { edges: edge, mode: 'two', distance: 4, distance2: 2, flip: true } }]);
const bb1 = properties(r1.states.at(-1).bodies.get('b')), bb2 = properties(r2.states.at(-1).bodies.get('b'));
check('Swap sides moves the long leg to the other face', near(bb2.volume, bb1.volume) && Math.abs(bb1.centerOfMass[1] - bb2.centerOfMass[1]) > 1e-3 && Math.abs(bb1.centerOfMass[2] - bb2.centerOfMass[2]) > 1e-3);
v = await removed({ type: 'chamfer', p: { edges: edge, mode: 'angle', distance: 3, angle: 30 } });
check('distance and angle: ½ · 3 · 3 tan 30° · 40', near(v, 0.5 * 3 * 3 * Math.tan(Math.PI / 6) * 40), v);
v = await removed({ type: 'chamfer', p: { edges: edge, mode: 'angle', distance: 3, angle: 95 } });
check('an angle over 90° is refused', /between 0° and 90°/.test(v), v);

v = await removed({ type: 'fillet', p: { edges: edge, radius: 3 } });
check('a constant fillet still works ((1 − π/4) · 9 · 40)', near(v, (1 - Math.PI / 4) * 9 * 40, 1e-2), v);
v = await removed({ type: 'fillet', p: { edges: edge, mode: 'variable', r1: 1, r2: 4 } });
// cross-section (1 − π/4) r² with r running 1 → 4 linearly: (1 − π/4) · 40 · (1 + 4 + 16) / 3
const Vv = (1 - Math.PI / 4) * 40 * 7;
check('a variable fillet 1 → 4 removes close to (1 − π/4) ∫ r²', typeof v === 'number' && Math.abs(v - Vv) / Vv < 0.04, `${v} vs ${Vv.toFixed(3)}`);
{
  // exact: the end faces lose a corner of (1 − π/4) r² with r = 1 at the start and 4 at the end
  const body = (await rebuild([box, { id: 'f', type: 'fillet', p: { edges: edge, mode: 'variable', r1: 1, r2: 4 } }])).states.at(-1).bodies.get('b');
  const end = (sx) => body.faces.find((fc) => fc.geomType === 'PLANE' && Math.abs(fc.center.x - sx * 20) < 1e-6);
  const { measureArea } = await import('replicad');
  const a0 = measureArea(end(-1)), a1 = measureArea(end(1));
  check('the radius is exactly 1 at one end and 4 at the other', near(600 - a0, (1 - Math.PI / 4) * 1, 1e-4) && near(600 - a1, (1 - Math.PI / 4) * 16, 1e-4), `${(600 - a0).toFixed(5)} ${(600 - a1).toFixed(5)}`);
}
const rv = await rebuild([box, { id: 'f', type: 'fillet', p: { edges: edge, mode: 'variable', r1: 1, r2: 4 } }]);
const rf = await rebuild([box, { id: 'f', type: 'fillet', p: { edges: edge, mode: 'variable', r1: 1, r2: 4, flip: true } }]);
const cx = (r) => properties(r.states.at(-1).bodies.get('b')).centerOfMass[0];
check('Swap ends mirrors the taper', Math.abs(cx(rv) + cx(rf)) < 1e-3 && Math.abs(cx(rv)) > 1e-3, `${cx(rv)} ${cx(rf)}`);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
