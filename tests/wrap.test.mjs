// Wrap / emboss: sketch regions laid onto cylindrical and flat faces at true size, raised or cut in.
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

const R = 20, h = 2;
const cyl = { id: 'cy', type: 'cylinder', p: { r: R, h: 40, axis: 'Z', x: 0, y: 0, z: 0, op: 'new' } };
const rect = (w, H) => ({ id: 'sk', type: 'sketch', p: { planeRef: { type: 'std', name: 'XY' }, points: [[-w / 2, -H / 2], [w / 2, -H / 2], [w / 2, H / 2], [-w / 2, H / 2]].map(([x, y], i) => ({ id: `p${i}`, x, y })), curves: [0, 1, 2, 3].map((i) => ({ id: `l${i}`, type: 'line', a: `p${i}`, b: `p${(i + 1) % 4}` })), constraints: [], dims: [] } });
const circ = (r) => ({ id: 'sk', type: 'sketch', p: { planeRef: { type: 'std', name: 'XY' }, points: [{ id: 'c', x: 0, y: 0 }], curves: [{ id: 'cc', type: 'circle', c: 'c', r }], constraints: [], dims: [] } });
const wrap = (extra = {}) => ({ id: 'w', type: 'wrap', p: { sketch: 'sk', profiles: [], face: [{ body: 'cy', p: [R, 0, 20], n: [1, 0, 0] }], height: h, mode: 'emboss', rotate: 0, ...extra } });
const V0 = Math.PI * R * R * 40;
const res = (r, id = 'cy') => (r.errors.w ? null : properties(r.states.at(-1).bodies.get(id)));

// raised 10 × 6 patch on the cylinder: V = A (h + h²/2R)
let r = await rebuild([cyl, rect(10, 6), wrap()]);
let pr = res(r);
check('emboss on a cylinder adds A·(h + h²/2R) = 126 mm³', pr && near(pr.volume - V0, 126, 0.05), pr ? (pr.volume - V0).toFixed(4) : r.errors.w);
check('it stands on the clicked side, 6 mm tall along the axis', pr && near(pr.bbox[1][0], R + h, 1e-3) && near(pr.bbox[1][2], 40), pr && JSON.stringify(pr.bbox.map((p) => p.map((x) => +x.toFixed(3)))));
r = await rebuild([cyl, rect(10, 6), wrap({ mode: 'deboss' })]);
pr = res(r);
check('deboss cuts A·(h − h²/2R) = 114 mm³', pr && near(V0 - pr.volume, 114, 0.05), pr ? (V0 - pr.volume).toFixed(4) : r.errors.w);
// a long label most of the way round: 100 mm of arc
r = await rebuild([cyl, rect(100, 8), wrap()]);
pr = res(r);
check('a band 100 mm long wraps round the cylinder', pr && near(pr.volume - V0, 800 * (h + h * h / (2 * R)), 0.1), pr ? (pr.volume - V0).toFixed(3) : r.errors.w);
r = await rebuild([cyl, circ(4), wrap()]);
pr = res(r);
const Vc = Math.PI * 16 * (h + h * h / (2 * R));
check('a round badge is within 0.5 %', pr && Math.abs(pr.volume - V0 - Vc) / Vc < 5e-3, pr ? `${(pr.volume - V0).toFixed(3)} vs ${Vc.toFixed(3)}` : r.errors.w);
// rotated 90°: the 10 mm side now runs along the axis
r = await rebuild([cyl, rect(10, 6), wrap({ rotate: 90 })]);
pr = res(r);
// the added material alone: the result minus the plain cylinder
const plain = (await rebuild([cyl])).states.at(-1).bodies.get('cy');
const added = (rr) => properties(rr.states.at(-1).bodies.get('cy').cut(plain)).bbox;
const za = added(await rebuild([cyl, rect(10, 6), wrap()])), zb = added(r);
check('unrotated, the 6 mm side runs along the axis (z 17 to 23)', near(za[0][2], 17) && near(za[1][2], 23), JSON.stringify(za));
check('rotated 90°, the 10 mm side runs along the axis (z 15 to 25)', pr && near(pr.volume - V0, 126, 0.05) && near(zb[0][2], 15) && near(zb[1][2], 25), JSON.stringify(zb));

// on a flat face it is a plain extrusion
const box = { id: 'cy', type: 'box', p: { w: 60, d: 40, h: 10, x: 0, y: 0, z: 0, op: 'new' } };
r = await rebuild([box, rect(10, 6), wrap({ face: [{ body: 'cy', p: [5, 5, 10], n: [0, 0, 1] }] })]);
pr = res(r);
check('emboss on a flat face adds 10 × 6 × 2', pr && near(pr.volume - 24000, 120, 1e-3) && near(pr.bbox[1][2], 12), pr ? (pr.volume - 24000).toFixed(4) : r.errors.w);
r = await rebuild([box, rect(10, 6), wrap({ mode: 'deboss', face: [{ body: 'cy', p: [5, 5, 10], n: [0, 0, 1] }] })]);
pr = res(r);
check('deboss on a flat face', pr && near(24000 - pr.volume, 120, 1e-3) && near(pr.bbox[1][2], 10), pr ? (24000 - pr.volume).toFixed(4) : r.errors.w);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
