// Text feature: every built-in glyph builds, layout widths, emboss onto a face and engrave into it.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import opencascade from 'replicad-opencascadejs';
import { setOC, measureVolume, makeBaseBox } from 'replicad';
import { rebuild, properties } from '../src/kernel/build.js';
import { textSolid, strokeLayout, BUILTIN_CHARS } from '../src/kernel/text.js';

const root = path.dirname(fileURLToPath(import.meta.url));
setOC(await opencascade({ locateFile: () => path.join(root, '../node_modules/replicad-opencascadejs/dist/replicad_single.wasm') }));
let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };
const near = (a, b, e = 1e-3) => Math.abs(a - b) < e;

const plane = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
// every glyph must build and cut cleanly (a self-touching outline makes the boolean fail)
const bad = [];
const slab = makeBaseBox(40, 40, 10);
const slabV = measureVolume(slab);
for (const ch of BUILTIN_CHARS) {
  if (ch === ' ') continue;
  try {
    const tool = await textSolid({ text: ch, height: 10, plane: { ...plane, origin: [0, -5, 10] }, depth: -1.05, start: 0.05 });
    const tv = measureVolume(tool), removed = slabV - measureVolume(slab.cut(tool));
    if (!(tv > 0.5) || Math.abs(removed - tv * (1 / 1.05)) > tv * 0.06) bad.push(`${ch} (tool ${tv.toFixed(1)}, removed ${removed.toFixed(1)})`);
  } catch (e) { bad.push(`${ch}: ${e.message}`); }
}
check(`all ${BUILTIN_CHARS.length - 1} built-in glyphs build and engrave cleanly`, !bad.length, bad.join(', '));
check('lower case maps to capitals', JSON.stringify(strokeLayout('abc')) === JSON.stringify(strokeLayout('ABC')));
const two = strokeLayout('AB\nC');
check('two lines are laid out', two.height > 2.5 && two.height < 2.7, `${two.height}`);

const s = await textSolid({ text: 'HI', height: 10, plane, depth: 2, align: 'left' });
const [lo, hi] = s.boundingBox.bounds;
const r = 0.625; // regular weight: stroke 1.25 mm at 10 mm height
check('left-aligned text starts at x = 0 (minus the stroke radius)', near(lo[0], -r, 1e-3), JSON.stringify(lo));
check('cap height 10 mm plus stroke', near(hi[1] - lo[1], 10 + 2 * r, 1e-3) && near(hi[2] - lo[2], 2, 1e-6), JSON.stringify([lo, hi]));

// emboss on the top face of a box, then engrave
const box = { id: 'b', type: 'box', p: { w: 120, d: 40, h: 10, x: 0, y: 0, z: 0, op: 'new' } };
const top = { type: 'face', body: 'b', p: [0, 0, 10], n: [0, 0, 1] };
const base = (await rebuild([box])).states.at(-1);
const v0 = properties(base.bodies.get('b')).volume;
const tf = (id, op) => ({ id, type: 'text', p: { plane: top, text: 'RUFFLE 3D', font: 'builtin', weight: 'regular', height: 10, align: 'center', x: 0, y: 0, angle: 0, spacing: 0, depth: 1, op, target: 'b' } });
let res = await rebuild([box, tf('t1', 'join')]);
const emb = properties(res.states.at(-1).bodies.get('b'));
check('emboss adds material above the face', !res.errors.t1 && emb.volume > v0 + 50 && near(emb.bbox[1][2], 11, 1e-6), `${res.errors.t1 || ''} +${(emb.volume - v0).toFixed(1)} mm³, top ${emb.bbox[1][2]}`);
const added = emb.volume - v0;
res = await rebuild([box, tf('t2', 'cut')]);
const eng = properties(res.states.at(-1).bodies.get('b'));
check('engrave removes the same amount below the face', !res.errors.t2 && near(v0 - eng.volume, added, added * 0.02) && near(eng.bbox[1][2], 10, 1e-6), `${res.errors.t2 || ''} −${(v0 - eng.volume).toFixed(1)} mm³`);
res = await rebuild([box, { ...tf('t3', 'new'), p: { ...tf('t3', 'new').p, plane: { type: 'std', name: 'XZ' }, angle: 90 } }]);
check('text on another plane, rotated, as a new body', !res.errors.t3 && res.states.at(-1).bodies.has('t3'), res.errors.t3 || '');
res = await rebuild([box, { ...tf('t4', 'join'), p: { ...tf('t4', 'join').p, font: 'missing-font' } }]);
check('a missing custom font is explained', /font/i.test(res.errors.t4 || ''), res.errors.t4 || '');

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
