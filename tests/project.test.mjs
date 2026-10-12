// Associative sketch projections: projected edges follow the model when it changes.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { rebuild } from '../src/kernel/build.js';
import { edgeSigFromSegments } from '../src/picksig.js';

const root = path.dirname(fileURLToPath(import.meta.url));
setOC(await opencascade({ locateFile: () => path.join(root, '../node_modules/replicad-opencascadejs/dist/replicad_single.wasm') }));
let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };
const near = (a, b, e = 1e-4) => Math.abs(a - b) < e;

const box = (w, hx) => [
  { id: 'bx', type: 'box', p: { w, d: 20, h: 10, x: 0, y: 0, z: 0, op: 'new' } },
  { id: 'ho', type: 'hole', p: { points: [{ body: 'bx', p: [hx, 0, 10], n: [0, 0, 1] }], diameter: 8, through: true, depth: 10 } },
];
// a sketch on the top face with the front top edge and the hole's rim projected into it, plus a free
// point tied to the projected line's midpoint
const sketch = {
  id: 'sk', type: 'sketch', p: {
    plane: { origin: [0, 0, 10], xDir: [1, 0, 0], normal: [0, 0, 1] },
    points: [{ id: 'a', x: -20, y: -10, fixed: true }, { id: 'b', x: 20, y: -10, fixed: true }, { id: 'c', x: 5, y: 0, fixed: true }, { id: 'm', x: 0, y: -10 }],
    curves: [
      { id: 'l', type: 'line', a: 'a', b: 'b', projected: true, src: { body: 'bx', p: [0, -10, 10], s: edgeSigFromSegments([[[-20, -10, 10], [20, -10, 10]]]), g: 'g1', k: 'line', i: 0 } },
      { id: 'o', type: 'circle', c: 'c', r: 4, projected: true, src: { body: 'bx', p: [9, 0, 10], s: edgeSigFromSegments(Array.from({ length: 48 }, (_, i) => [0, 1].map((k) => { const t = ((i + k) / 48) * 2 * Math.PI; return [5 + 4 * Math.cos(t), 4 * Math.sin(t), 10]; }))), g: 'g2', k: 'circle', i: 0 } },
    ],
    constraints: [{ id: 'k1', type: 'midpoint', p: 'm', line: 'l' }],
    dims: [],
  },
};
const geomOf = async (w, hx) => { const r = await rebuild([...box(w, hx), sketch]); return { r, sk: r.states.at(-1).sketches.get('sk') }; };

let { r, sk } = await geomOf(40, 5);
const line = (g) => g.geom.find((x) => x.id === 'l'), circ = (g) => g.geom.find((x) => x.id === 'o');
check('projected geometry builds as drawn', !r.errors.sk && !r.warnings?.sk && near(Math.abs(line(sk).a[0] - line(sk).b[0]), 40), JSON.stringify(line(sk)));
({ r, sk } = await geomOf(60, 12));
const L = line(sk), O = circ(sk);
check('a projected edge follows the body when it gets wider', near(Math.min(L.a[0], L.b[0]), -30) && near(Math.max(L.a[0], L.b[0]), 30) && near(L.a[1], -10), JSON.stringify(L));
check('a projected hole rim follows the hole', O && near(O.c[0], 12) && near(O.c[1], 0) && near(O.r, 4), JSON.stringify(O));
// the edge disappears (the box is replaced by a cylinder): the sketch keeps the last position and warns
const r2 = await rebuild([{ id: 'bx', type: 'cylinder', p: { r: 5, h: 10, axis: 'Z', x: 0, y: 0, z: 0, op: 'new' } }, sketch]);
check('a projection whose edge is gone warns instead of failing', !r2.errors.sk && /could not be found/.test(r2.warnings?.sk || ''), r2.warnings?.sk || '');

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
