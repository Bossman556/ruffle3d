// Sheet metal: base plate, up/down flanges, cut-outs and the flat pattern (bend allowance, DXF).
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { rebuild, properties, flatPattern } from '../src/kernel/build.js';
import { primitivesToSketch, parseDXF } from '../src/dxf.js';

const root = path.dirname(fileURLToPath(import.meta.url));
setOC(await opencascade({ locateFile: () => path.join(root, '../node_modules/replicad-opencascadejs/dist/replicad_single.wasm') }));
let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };
const near = (a, b, e = 1e-3) => Math.abs(a - b) < e;

const rect = primitivesToSketch([[0, 0, 100, 0], [100, 0, 100, 60], [100, 60, 0, 60], [0, 60, 0, 0]].map(([a, b, c, d]) => ({ t: 'line', a: [a, b], b: [c, d] })));
const sketch = { id: 's', type: 'sketch', p: { plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, ...rect } };
const T = 2, R = 2, K = 0.44;
const base = { id: 'b', type: 'sheetbase', p: { sketch: 's', profiles: [], thickness: T, bendRadius: R, kfactor: K, flip: false } };
const fl = (id, pt, dir, extra = {}) => ({ id, type: 'flange', p: { edges: [{ body: 'b', p: pt }], angle: 90, length: 20, dir, inset: 0, ...extra } });

let r = await rebuild([sketch, base]);
const st0 = r.states.at(-1);
check('base plate volume', !r.errors.b && near(properties(st0.bodies.get('b')).volume, 100 * 60 * T, 0.01), r.errors.b || '');

const feats = [sketch, base, fl('f1', [100, 30, T], 'up'), fl('f2', [0, 30, 0], 'down')];
r = await rebuild(feats);
const st = r.states.at(-1);
const body = st.bodies.get('b');
const oneFlange = (Math.PI / 4) * ((R + T) ** 2 - R ** 2) * 60 + 20 * T * 60;
check('two flanges build', !r.errors.f1 && !r.errors.f2, `${r.errors.f1 || ''} ${r.errors.f2 || ''}`);
check('folded volume = plate + 2 × (bend + flange)', near(properties(body).volume, 100 * 60 * T + 2 * oneFlange, 0.5), properties(body).volume.toFixed(2));
const [lo, hi] = properties(body).bbox;
check('up flange on the right reaches z = T + R + 20', near(hi[2], T + R + 20, 1e-3) && near(hi[0], 100 + R + T, 1e-3), JSON.stringify(hi));
check('down flange on the left reaches z = -(R + 20)', near(lo[2], -(R + 20), 1e-3) && near(lo[0], -(R + T), 1e-3), JSON.stringify(lo));

let fp = flatPattern(st, 'b');
const BA = (Math.PI / 2) * (R + K * T);
check('flat pattern width = 100 + 2 × (BA + 20)', near(fp.size[0], 100 + 2 * (BA + 20), 1e-6) && near(fp.size[1], 60, 1e-6), JSON.stringify(fp.size));
check('bend table: 2 bends, up and down', fp.bends.length === 2 && fp.bends.some((b) => b.dir === 'Up') && fp.bends.some((b) => b.dir === 'Down') && near(fp.bends[0].allowance, BA));
check('4 bend lines on the BEND layer', fp.ents.filter((e) => e.layer === 'BEND').length === 4);
const d = parseDXF(fp.dxf);
check('flat DXF parses back', d.entities.length === fp.ents.length, `${d.entities.length} vs ${fp.ents.length}`);

// hole through the base and one through the right flange show up in the flat pattern
const holes = [
  { id: 'h1', type: 'hole', p: { points: [{ body: 'b', p: [50, 30, T], n: [0, 0, 1] }], diameter: 10, through: true, depth: 10 } },
  { id: 'h2', type: 'hole', p: { points: [{ body: 'b', p: [100 + R + T, 30, T + R + 10], n: [1, 0, 0] }], diameter: 6, through: false, depth: T + 0.5 } },
];
r = await rebuild([...feats, ...holes]);
check('holes build', !r.errors.h1 && !r.errors.h2, `${r.errors.h1 || ''} ${r.errors.h2 || ''}`);
fp = flatPattern(r.states.at(-1), 'b');
const circles = fp.ents.filter((e) => e.t === 'CIRCLE');
check('flat pattern has both holes', circles.length === 2, `${circles.length} circles`);
// the flange hole sits 10 mm past the bend: x = (BA + 20) [left flange] + 100 + BA + 10
const fh = circles.find((c) => near(c.r, 3, 1e-6));
check('flange hole unfolds to the right place', fh && near(fh.c[0], BA + 20 + 100 + BA + 10, 1e-3) && near(fh.c[1], 30, 1e-3), fh && JSON.stringify(fh.c));
const bh = circles.find((c) => near(c.r, 5, 1e-6));
check('base hole stays put', bh && near(bh.c[0], BA + 20 + 50, 1e-3), bh && JSON.stringify(bh.c));

// a flange on a flange: a 15 mm lip folded back over the plate from the tip of the right flange
{
  const lip = fl('f3', [100 + R + T, 30, T + R + 20], 'up', { length: 15 });
  const r3 = await rebuild([...feats, lip]);
  const b3 = r3.states.at(-1).bodies.get('b');
  const [l3, h3] = properties(b3).bbox;
  const lipVol = (Math.PI / 4) * ((R + T) ** 2 - R ** 2) * 60 + 15 * T * 60;
  check('flange on a flange builds', !r3.errors.f3, r3.errors.f3 || '');
  check('the lip adds its bend and flat part', near(properties(b3).volume, 100 * 60 * T + 2 * oneFlange + lipVol, 0.5), properties(b3).volume.toFixed(2));
  check('the lip folds back over the plate at the top', near(h3[2], 2 * T + 2 * R + 20, 1e-3) && near(h3[0], 100 + R + T, 1e-3), JSON.stringify([l3, h3]));
  const fp3 = flatPattern(r3.states.at(-1), 'b');
  check('flat pattern unfolds the lip too', near(fp3.size[0], 100 + 3 * BA + 55, 1e-6) && near(fp3.size[1], 60, 1e-6) && fp3.bends.length === 3, JSON.stringify(fp3.size));
  check('6 bend lines for 3 bends', fp3.ents.filter((e) => e.layer === 'BEND').length === 6);
  // a flange on the side of a flange
  const side = fl('f4', [100 + R + T, 0, T + R + 10], 'up', { length: 10 });
  const r4 = await rebuild([...feats, side]);
  check('a flange on the side edge of a flange builds', !r4.errors.f4 && flatPattern(r4.states.at(-1), 'b').bends.length === 3, r4.errors.f4 || '');
}

// insets and errors
r = await rebuild([sketch, base, fl('f3', [50, 0, T], 'up', { inset: 5, angle: 45, length: 10 })]);
check('inset 45° flange', !r.errors.f3, r.errors.f3 || '');
fp = flatPattern(r.states.at(-1), 'b');
check('inset flange flat size', near(fp.size[1], 60 + (Math.PI / 4) * (R + K * T) + 10, 1e-6), JSON.stringify(fp.size));
r = await rebuild([sketch, base, fl('f1', [100, 30, T], 'up'), fl('f4', [100, 20, T], 'up')]);
check('second flange on the same edge is rejected', !!r.errors.f4, r.errors.f4 || '');
r = await rebuild([sketch, { id: 'e', type: 'extrude', p: { sketch: 's', profiles: [], side: 'one', distance: 2, op: 'new' } }, { id: 'f5', type: 'flange', p: { edges: [{ body: 'e', p: [100, 30, 2] }], angle: 90, length: 10, dir: 'up', inset: 0 } }]);
check('flange on a non-sheet body explains why', /Sheet Metal Base/.test(r.errors.f5 || ''), r.errors.f5 || '');

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
