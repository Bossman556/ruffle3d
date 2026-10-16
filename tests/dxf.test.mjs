// DXF import (parse → primitives → sketch → extrude) and DXF export of faces, plus tapped holes.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { rebuild, properties, faceDXF } from '../src/kernel/build.js';
import { parseDXF, dxfPrimitives, primitivesToSketch } from '../src/dxf.js';

const root = path.dirname(fileURLToPath(import.meta.url));
setOC(await opencascade({ locateFile: () => path.join(root, '../node_modules/replicad-opencascadejs/dist/replicad_single.wasm') }));
let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };
const near = (a, b, e = 1e-3) => Math.abs(a - b) < e;
const dxf = (header, entities, blocks = '') => [
  '0', 'SECTION', '2', 'HEADER', ...header, '0', 'ENDSEC',
  ...(blocks ? ['0', 'SECTION', '2', 'BLOCKS', ...blocks, '0', 'ENDSEC'] : []),
  '0', 'SECTION', '2', 'ENTITIES', ...entities, '0', 'ENDSEC', '0', 'EOF',
].join('\n');

// plate 60 × 40 with a rounded right end (bulge = 1 → semicircle) and a Ø10 hole, drawn in millimetres
const plate = dxf(['9', '$INSUNITS', '70', '4'], [
  '0', 'LWPOLYLINE', '8', '0', '90', '4', '70', '1',
  '10', '0', '20', '0', '10', '40', '20', '0', '42', '1', '10', '40', '20', '40', '10', '0', '20', '40',
  '0', 'CIRCLE', '8', '0', '10', '15', '20', '20', '30', '0', '40', '5',
]);
let d = parseDXF(plate);
check('reads $INSUNITS (mm)', d.unitScale === 1);
let { prims, skipped } = dxfPrimitives(d, d.unitScale);
check('polyline with bulge → 3 lines + 1 arc, plus a circle', prims.filter((p) => p.t === 'line').length === 3 && prims.filter((p) => p.t === 'arc').length === 1 && prims.some((p) => p.t === 'circle'), JSON.stringify(skipped));
const arc = prims.find((p) => p.t === 'arc');
check('bulge arc centre and radius', near(arc.c[0], 40) && near(arc.c[1], 20) && near(arc.r, 20), JSON.stringify(arc));
let sk = primitivesToSketch(prims);
check('shared endpoints are merged', sk.points.length === 4 + 1 + 1, `points ${sk.points.length}`);
const sketchFeat = (id, data) => ({ id, type: 'sketch', p: { plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, ...data } });
let r = await rebuild([sketchFeat('s', sk), { id: 'e', type: 'extrude', p: { sketch: 's', profiles: [], side: 'one', distance: 5, op: 'new' } }]);
const expected = (40 * 40 + (Math.PI * 20 * 20) / 2 - Math.PI * 25) * 5;
check('imported DXF extrudes to the right volume', !r.errors.s && !r.errors.e && near(properties(r.states.at(-1).bodies.get('e')).volume, expected, 0.5), `${r.errors.e || ''} ${r.states.at(-1).bodies.get('e') && properties(r.states.at(-1).bodies.get('e')).volume.toFixed(2)} vs ${expected.toFixed(2)}`);

// inches + a block inserted at 2× scale and rotated 90°
const inch = dxf(['9', '$INSUNITS', '70', '1'], [
  '0', 'INSERT', '8', '0', '2', 'SQ', '10', '1', '20', '1', '41', '2', '42', '2', '50', '90',
  '0', 'ARC', '8', '0', '10', '0', '20', '0', '40', '1', '50', '0', '51', '90',
], ['0', 'BLOCK', '8', '0', '2', 'SQ', '10', '0', '20', '0', '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '1', '21', '0', '0', 'ENDBLK']);
d = parseDXF(inch);
check('reads inches', d.unitScale === 25.4);
({ prims } = dxfPrimitives(d, d.unitScale));
const ln = prims.find((p) => p.t === 'line');
check('block insert: scale 2 and 90° rotation, in mm', ln && near(ln.a[0], 25.4) && near(ln.a[1], 25.4) && near(ln.b[0], 25.4) && near(ln.b[1], 25.4 + 50.8), JSON.stringify(ln));
const a2 = prims.find((p) => p.t === 'arc');
check('arc converted to mm with radians', a2 && near(a2.r, 25.4) && near(a2.a1, Math.PI / 2));

// SPLINE by fit points becomes a sketch spline; a whole ELLIPSE stays an exact ellipse, a partial one a spline
const spl = dxf([], [
  '0', 'SPLINE', '8', '0', '70', '8', '71', '3', '11', '0', '21', '0', '11', '10', '21', '5', '11', '20', '21', '0',
  '0', 'ELLIPSE', '8', '0', '10', '0', '20', '0', '11', '10', '21', '0', '40', '0.5', '41', '0', '42', '6.283185307',
]);
({ prims } = dxfPrimitives(parseDXF(spl), 1));
check('spline (fit points) and full ellipse', prims.length === 2 && prims[0].t === 'spline' && prims[1].t === 'ellipse' && near(prims[1].a[0], 10) && near(prims[1].rb, 5));
const half = dxf([], ['0', 'ELLIPSE', '8', '0', '10', '0', '20', '0', '11', '10', '21', '0', '40', '0.5', '41', '0', '42', '3.14159265']);
check('a partial ellipse is an open spline', dxfPrimitives(parseDXF(half), 1).prims[0].t === 'spline' && !dxfPrimitives(parseDXF(half), 1).prims[0].closed);

// ---------- export: top face of a 40 × 30 plate with a Ø8 hole ----------
r = await rebuild([
  { id: 'b', type: 'box', p: { w: 40, d: 30, h: 5, x: 0, y: 0, z: 0, op: 'new' } },
  { id: 'h', type: 'cylinder', p: { r: 4, h: 5, axis: 'Z', x: 0, y: 0, z: 0, op: 'cut', target: 'b' } },
]);
const text = faceDXF(r.states.at(-1), { body: 'b', p: [10, 10, 5], n: [0, 0, 1] });
check('face export writes an ASCII DXF', text.startsWith('0\r\nSECTION') && text.trim().endsWith('EOF'));
const back = dxfPrimitives(parseDXF(text), 1).prims;
const lines = back.filter((p) => p.t === 'line'), circles = back.filter((p) => p.t === 'circle');
check('exported face has 4 lines and the hole as a circle', lines.length === 4 && (circles.length === 1 || back.filter((p) => p.t === 'arc').length >= 2), back.map((p) => p.t).join(','));
const xs = lines.flatMap((l) => [l.a[0], l.b[0]]), ys = lines.flatMap((l) => [l.a[1], l.b[1]]);
check('exported outline is 40 × 30 starting at the origin', near(Math.min(...xs), 0) && near(Math.max(...xs) - Math.min(...xs), 40) && near(Math.max(...ys) - Math.min(...ys), 30));
check('exported hole radius is 4', circles.length !== 1 || near(circles[0].r, 4));

// ---------- tapped holes ----------
r = await rebuild([
  { id: 'blk', type: 'box', p: { w: 30, d: 30, h: 12, x: 0, y: 0, z: 0, op: 'new' } },
  { id: 'th', type: 'hole', p: { points: [{ body: 'blk', p: [0, 0, 12], n: [0, 0, 1] }], tapped: true, tapSize: 'M6', diameter: 6, through: false, depth: 10, threadDepth: 8, cbore: false, csink: false } },
]);
const vb = properties(r.states.at(-1).bodies.get('blk')).volume;
const drill = Math.PI * (5 / 2) ** 2 * 10; // M6 tap drill Ø5
check('tapped M6 hole drills Ø5 and cuts a thread', !r.errors.th && vb < 30 * 30 * 12 - drill - 5 && vb > 30 * 30 * 12 - drill - 120, `${r.errors.th || ''} removed ${(30 * 30 * 12 - vb).toFixed(1)} (drill ${drill.toFixed(1)})`);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
