// Path pattern: copies of a body spaced along a sketch curve.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { rebuild, properties } from '../src/kernel/build.js';
import { primitivesToSketch } from '../src/dxf.js';

const root = path.dirname(fileURLToPath(import.meta.url));
setOC(await opencascade({ locateFile: () => path.join(root, '../node_modules/replicad-opencascadejs/dist/replicad_single.wasm') }));
let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };
const near = (a, b, e = 1e-3) => Math.abs(a - b) < e;
const XY = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const sketch = (id, prims) => ({ id, type: 'sketch', p: { plane: XY, ...primitivesToSketch(prims) } });
const cube = { id: 'c', type: 'box', p: { w: 4, d: 4, h: 4, x: 0, y: 0, z: 0, op: 'new' } };
const pattern = (extra) => ({ id: 'pp', type: 'ppattern', p: { bodies: ['c'], path: 'path', count: 6, mode: 'fit', spacing: 20, orient: 'fixed', join: true, ...extra } });
const bb = (r) => properties(r.states.at(-1).bodies.get('c')).bbox;

// a straight 100 mm path: six cubes at x = 0, 20, … 100
const line = sketch('path', [{ t: 'line', a: [0, 0], b: [100, 0] }]);
let r = await rebuild([cube, line, pattern({})]);
let b = bb(r), v = properties(r.states.at(-1).bodies.get('c')).volume;
check('six cubes spread along a 100 mm line', !r.errors.pp && near(b[0][0], -2) && near(b[1][0], 102) && near(v, 6 * 64, 1e-3), `${r.errors.pp || ''} ${JSON.stringify(b)} V=${v.toFixed(2)}`);

// a set distance: 25 mm apart, 3 copies → x = 0, 25, 50
r = await rebuild([cube, line, pattern({ mode: 'spacing', spacing: 25, count: 3 })]);
b = bb(r);
check('a set spacing places copies that far apart', near(b[1][0], 52) && near(properties(r.states.at(-1).bodies.get('c')).volume, 3 * 64, 1e-3), JSON.stringify(b));

// more copies than fit at that spacing: the extra ones are left out with a warning
r = await rebuild([cube, line, pattern({ mode: 'spacing', spacing: 40, count: 5 })]);
check('copies that would run past the end are left out, with a warning', near(bb(r)[1][0], 82) && /past the end/.test(r.warnings?.pp || ''), r.warnings?.pp || '');

// a semicircle of radius 50 from (50, 0) to (-50, 0): copies follow the curve
const arc = sketch('path', [{ t: 'arc', c: [0, 0], r: 50, a0: 0, a1: Math.PI }]);
const tall = { id: 'c', type: 'box', p: { w: 2, d: 10, h: 2, x: 50, y: 0, z: 0, op: 'new' } }; // long in Y, i.e. along the path at its start
r = await rebuild([tall, arc, pattern({ count: 3, orient: 'follow', join: false })]);
const st = r.states.at(-1), ids = [...st.bodies.keys()];
const mid = ids.map((id) => properties(st.bodies.get(id)).bbox).find((q) => near((q[0][1] + q[1][1]) / 2, 50, 0.01));
check('three copies along a semicircle (start, top, end)', !r.errors.pp && ids.length === 3 && !!mid, `${r.errors.pp || ''} ${ids.length} bodies`);
check('with "turn with the path" the copy at the top is turned 90° to lie along the curve', mid && near(mid[1][0] - mid[0][0], 10, 0.01) && near(mid[1][1] - mid[0][1], 2, 0.01), mid && JSON.stringify(mid));
r = await rebuild([tall, arc, pattern({ count: 3, orient: 'fixed', join: false })]);
const fixedMid = [...r.states.at(-1).bodies.values()].map((s) => properties(s).bbox).find((q) => near((q[0][1] + q[1][1]) / 2, 50, 0.01));
check('with "keep orientation" it is only moved', fixedMid && near(fixedMid[1][0] - fixedMid[0][0], 2, 0.01) && near(fixedMid[1][1] - fixedMid[0][1], 10, 0.01), fixedMid && JSON.stringify(fixedMid));

// a closed path (circle): six copies evenly round it, none on top of the first
const ring = sketch('path', [{ t: 'circle', c: [0, 0], r: 30 }]);
r = await rebuild([{ ...cube, p: { ...cube.p, x: 30 } }, ring, pattern({ count: 6 })]);
check('a closed path spaces copies evenly all the way round', !r.errors.pp && near(properties(r.states.at(-1).bodies.get('c')).volume, 6 * 64, 1e-2), `${r.errors.pp || ''} V=${properties(r.states.at(-1).bodies.get('c')).volume.toFixed(2)}`);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
