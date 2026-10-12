// Persistent references: picks carry mesh signatures, and features find their faces and edges again
// after edits that move, shrink or split them.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { rebuild, meshShape, properties } from '../src/kernel/build.js';
import { faceSigFromMesh, edgeSigFromSegments } from '../src/picksig.js';

const root = path.dirname(fileURLToPath(import.meta.url));
setOC(await opencascade({ locateFile: () => path.join(root, '../node_modules/replicad-opencascadejs/dist/replicad_single.wasm') }));
let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };
const near = (a, b, e = 1e-3) => Math.abs(a - b) < e;
const box = (id, w, d, h, x = 0, y = 0, z = 0, op = 'new', target) => ({ id, type: 'box', p: { w, d, h, x, y, z, op, target } });

// pick helpers working on the display mesh exactly as the app does
// the face whose plane passes through p with the given outward normal (as a click on it would give)
const facePick = (shape, body, p, n = [0, 0, 1]) => {
  const m = meshShape(shape).mesh;
  for (const g of m.faceGroups) {
    const s = faceSigFromMesh(m.vertices, m.triangles, g.start, g.count);
    const inBox = p.every((v, k) => v >= s.b[0][k] - 1e-6 && v <= s.b[1][k] + 1e-6);
    if (s.pl && s.n.every((v, k) => Math.abs(v - n[k]) < 1e-3) && inBox) return { body, p, n: s.n, s };
  }
  throw new Error('no face there');
};
const edgePick = (shape, body, p) => {
  const m = meshShape(shape).mesh;
  let best = null, bd = Infinity;
  for (const g of m.edgeGroups) {
    const pts = [];
    for (let i = g.start; i < g.start + g.count; i++) pts.push([m.lines[i * 3], m.lines[i * 3 + 1], m.lines[i * 3 + 2]]);
    for (const q of pts) { const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]); if (d < bd) { bd = d; best = pts; } }
    const mid = pts.length === 2 ? pts[0].map((v, k) => (v + pts[1][k]) / 2) : null;
    if (mid) { const d = Math.hypot(mid[0] - p[0], mid[1] - p[1], mid[2] - p[2]); if (d < bd) { bd = d; best = pts; } }
  }
  const segs = best.slice(0, -1).map((q, i) => [q, best[i + 1]]);
  return { body: body, p, s: edgeSigFromSegments(segs) };
};

// 1. a filleted edge that a later-inserted slot splits in two: both pieces stay filleted
let r = await rebuild([box('b', 60, 20, 10)]);
const ep = edgePick(r.states.at(-1).bodies.get('b'), 'b', [0, -10, 10]);
check('edge signature describes the 60 mm straight edge', ep.s.st && near(ep.s.l, 60) && near(Math.abs(ep.s.d[0]), 1), JSON.stringify(ep.s));
const slot = box('s', 10, 30, 5, 0, 0, 5, 'cut', 'b');
const fillet = (picks) => ({ id: 'f', type: 'fillet', p: { edges: picks, radius: 2 } });
const plain = (await rebuild([box('b', 60, 20, 10), slot])).states.at(-1).bodies.get('b');
r = await rebuild([box('b', 60, 20, 10), slot, fillet([ep])]);
const filleted = r.states.at(-1).bodies.get('b');
const removed = properties(plain).volume - properties(filleted).volume;
const expect = (1 - Math.PI / 4) * 4 * 50; // both 25 mm pieces
check('split edge: both pieces are filleted', !r.errors.f && near(removed, expect, 0.05), `${r.errors.f || ''} removed ${removed.toFixed(3)} vs ${expect.toFixed(3)} mm³`);
r = await rebuild([box('b', 60, 20, 10), slot, fillet([{ body: 'b', p: [0, -10, 10] }])]);
check('(without a signature the old method loses the edge)', !!r.errors.f, r.errors.f || 'no error');

// 2. shelling away the lower top face of an L-shaped part after the upper block grows over most of it
const L = (w2) => [box('a', 40, 20, 10), box('u', w2, 20, 10, 20 - w2 / 2, 0, 10, 'join', 'a')];
r = await rebuild(L(20));
const lower = facePick(r.states.at(-1).bodies.get('a'), 'a', [-10, 0, 10]);
check('face signature: planar, facing +Z, 20 × 20', lower.s.pl && near(lower.s.n[2], 1) && near(lower.s.a, 400, 0.01), JSON.stringify(lower.s));
const shell = (pk) => ({ id: 'sh', type: 'shell', p: { faces: [pk], thickness: 1, dir: 'inside' } });
r = await rebuild([...L(35), shell(lower)]);
const shelled = r.states.at(-1).bodies.get('a');
// the open face must be the remaining strip of the lower top (x −20…−15, z = 10), not the upper top (z = 20)
const openAt10 = shelled && properties(shelled).bbox[1][2] > 19.9 && shelled.faces.some((f) => f.geomType === 'PLANE' && Math.abs(f.center.z - 10) < 1e-6 && f.center.x < -14);
check('moved and shrunk face is found again by signature', !r.errors.sh && openAt10, r.errors.sh || '');
r = await rebuild([...L(35), shell({ body: 'a', p: [-10, 0, 10] })]);
check('(without a signature the old method fails here)', !!r.errors.sh, r.errors.sh || 'no error');

// 3. a hole on a top face that moved up keeps its position in the face and stays one hole
const hole = (pk) => ({ id: 'h', type: 'hole', p: { points: [pk], diameter: 6, through: false, depth: 4 } });
r = await rebuild([box('b', 40, 20, 10)]);
const tp = facePick(r.states.at(-1).bodies.get('b'), 'b', [8, 3, 10]);
r = await rebuild([box('b', 40, 20, 18), hole({ ...tp, n: [0, 0, 1] })]);
const hb = r.states.at(-1).bodies.get('b');
check('hole follows its face when the part gets taller', !r.errors.h && near(properties(hb).volume, 40 * 20 * 18 - Math.PI * 9 * 4, 0.05), r.errors.h || properties(hb).volume.toFixed(3));

// 4. a picked face whose old point now lies on a side face (the part got narrower): the signature rejects the side face
r = await rebuild([box('b', 40, 20, 10)]);
const corner = facePick(r.states.at(-1).bodies.get('b'), 'b', [15, 0, 10]);
const pp = (pk) => ({ id: 'pp', type: 'presspull', p: { faces: [pk], distance: 3 } });
r = await rebuild([box('b', 30, 20, 10), pp(corner)]);
const pb = r.states.at(-1).bodies.get('b');
check('press-pull still pushes the top face, not the side', !r.errors.pp && near(properties(pb).bbox[1][2], 13) && near(properties(pb).bbox[1][0], 15), r.errors.pp || JSON.stringify(properties(pb).bbox));

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
