// Sketch ellipses: geometry, solver constraints and dimensions, regions, and exact solids in the kernel.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { rebuild, properties } from '../src/kernel/build.js';
import { solveSketch } from '../src/sketch/solver.js';
import { computeRegions } from '../src/sketch/regions.js';
import { sketchGeom, curveGeom, ellipsePoint, closestOnGeom, distToGeom, ellipsePerimeter, intersect } from '../src/sketch/model.js';

const root = path.dirname(fileURLToPath(import.meta.url));
setOC(await opencascade({ locateFile: () => path.join(root, '../node_modules/replicad-opencascadejs/dist/replicad_single.wasm') }));
let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

// an ellipse centred at (10, 5), major radius 30 at 30°, minor radius 12
const rot = Math.PI / 6;
const ell = (rb = 12, extra = {}) => ({
  points: [{ id: 'c', x: 10, y: 5 }, { id: 'a', x: 10 + 30 * Math.cos(rot), y: 5 + 30 * Math.sin(rot) }, ...(extra.points || [])],
  curves: [{ id: 'e', type: 'ellipse', c: 'c', a: 'a', rb }, ...(extra.curves || [])],
  constraints: extra.constraints || [], dims: extra.dims || [],
});

// geometry
const g = curveGeom(ell(), ell().curves[0]);
check('geometry: radii and angle come from the centre, axis point and minor radius', near(g.rx, 30) && near(g.ry, 12) && near(g.rot, rot));
const q = ellipsePoint(g, Math.PI / 2);
check('the end of the minor axis is 12 from the centre, at right angles', near(Math.hypot(q[0] - 10, q[1] - 5), 12) && near((q[0] - 10) * Math.cos(rot) + (q[1] - 5) * Math.sin(rot), 0));
const off = [ellipsePoint(g, 1)[0] + 3, ellipsePoint(g, 1)[1] + 4];
const cl = closestOnGeom(off, g);
const tang = [ellipsePoint(g, cl.t + 1e-6)[0] - ellipsePoint(g, cl.t - 1e-6)[0], ellipsePoint(g, cl.t + 1e-6)[1] - ellipsePoint(g, cl.t - 1e-6)[1]];
check('closest point: the offset is normal to the ellipse', Math.abs((off[0] - cl.p[0]) * tang[0] + (off[1] - cl.p[1]) * tang[1]) / Math.hypot(...tang) < 1e-6 && near(distToGeom(off, g), Math.hypot(off[0] - cl.p[0], off[1] - cl.p[1])));
{
  // perimeter against direct numerical integration of |dE/dt|
  let P = 0; const N = 200000;
  for (let i = 0; i < N; i++) { const t = ((i + 0.5) / N) * 2 * Math.PI; P += Math.hypot(30 * Math.sin(t), 12 * Math.cos(t)) * (2 * Math.PI / N); }
  check('perimeter matches numerical integration', near(ellipsePerimeter(30, 12), P, 1e-6), `${ellipsePerimeter(30, 12).toFixed(6)} vs ${P.toFixed(6)}`);
}

// solver: dimensions on both axes, a point on the ellipse, a tangent line
{
  const sk = ell(8, {
    points: [{ id: 'q', x: 0, y: 30 }, { id: 'l1', x: -40, y: 40 }, { id: 'l2', x: 60, y: 41 }],
    curves: [{ id: 'L', type: 'line', a: 'l1', b: 'l2' }],
    constraints: [{ id: 'k1', type: 'pointOnCurve', p: 'q', curve: 'e' }, { id: 'k2', type: 'tangent', c1: 'L', c2: 'e' }, { id: 'k3', type: 'horizontal', line: 'L' }, { id: 'k4', type: 'fix', p: 'c', x: 10, y: 5 }, { id: 'k5', type: 'horizontal', a: 'c', b: 'a' }],
    dims: [{ id: 'd1', type: 'axis', curve: 'e', which: 'major', value: 80 }, { id: 'd2', type: 'axis', curve: 'e', which: 'minor', value: 50 }],
  });
  const r = solveSketch(sk);
  const s = r.sketch, gg = curveGeom(s, s.curves[0]), P = (id) => { const p = s.points.find((x) => x.id === id); return [p.x, p.y]; };
  check('axis dimensions drive the radii (80 × 50)', r.ok && near(gg.rx, 40, 1e-5) && near(gg.ry, 25, 1e-5) && near(gg.rot, 0, 1e-6), JSON.stringify({ ok: r.ok, failed: r.failed, rx: gg.rx, ry: gg.ry }));
  check('a point on the ellipse stays on it', distToGeom(P('q'), gg) < 1e-5);
  check('a horizontal tangent line touches the top of the ellipse (y = 5 + 25)', near(P('l1')[1], 30, 1e-5) && near(P('l2')[1], 30, 1e-5), JSON.stringify([P('l1'), P('l2')]));
}
{
  // tangent to a sloped line, rotated ellipse: the line's distance from the centre is the support width
  const sk = ell(12, { points: [{ id: 'l1', x: 0, y: 60 }, { id: 'l2', x: 60, y: 0 }], curves: [{ id: 'L', type: 'line', a: 'l1', b: 'l2' }], constraints: [{ id: 'k', type: 'tangent', c1: 'e', c2: 'L' }, { id: 'f1', type: 'fix', p: 'c', x: 10, y: 5 }, { id: 'f2', type: 'fix', p: 'a', x: 10 + 30 * Math.cos(rot), y: 5 + 30 * Math.sin(rot) }, { id: 'f3', type: 'fix', p: 'l1', x: 0, y: 60 }] });
  const r = solveSketch(sk);
  const s = r.sketch, gg = curveGeom(s, s.curves[0]);
  const L = s.points.filter((p) => p.id.startsWith('l')).map((p) => [p.x, p.y]);
  const pts = Array.from({ length: 20000 }, (_, i) => ellipsePoint(gg, (i / 20000) * 2 * Math.PI));
  const d = (p) => ((p[0] - L[0][0]) * (L[1][1] - L[0][1]) - (p[1] - L[0][1]) * (L[1][0] - L[0][0])) / Math.hypot(L[1][0] - L[0][0], L[1][1] - L[0][1]);
  const ds = pts.map(d), side = Math.sign(d(gg.c));
  const gap = Math.min(...ds.map((x) => x * side));
  check('a sloped tangent line just touches a rotated ellipse', r.ok && Math.abs(gap) < 1e-4, `gap ${gap.toExponential(2)}`);
}

// regions: an ellipse alone, and an elliptical hole in a rectangle
{
  const regs = computeRegions(sketchGeom(ell()));
  check('an ellipse is one region of area πab', regs.length === 1 && near(regs[0].area, Math.PI * 30 * 12, 0.5), regs.map((x) => x.area.toFixed(2)).join());
  const rect = { points: [[-40, -30], [60, -30], [60, 40], [-40, 40]].map(([x, y], i) => ({ id: `r${i}`, x, y })), curves: [0, 1, 2, 3].map((i) => ({ id: `rl${i}`, type: 'line', a: `r${i}`, b: `r${(i + 1) % 4}` })) };
  const sk = ell(12, rect);
  const rs = computeRegions(sketchGeom(sk)).sort((a, b) => b.area - a.area);
  check('inside a rectangle the ellipse becomes a hole', rs.length === 2 && rs[0].holes.length === 1 && rs[0].depth === 0 && rs[1].depth === 1, rs.map((r) => `${r.area.toFixed(1)}/${r.depth}/${r.holes.length}`).join(' '));
}

// crossings: a line through the centre halves the ellipse; a circle over its end makes three regions
{
  const sk = ell(12, { points: [{ id: 'l1', x: -40, y: 5 }, { id: 'l2', x: 60, y: 5 }], curves: [{ id: 'L', type: 'line', a: 'l1', b: 'l2' }] });
  const gs = sketchGeom(sk), hits = intersect(gs[0], gs[1]);
  check('a line meets the ellipse at two exact points', hits.length === 2 && hits.every((h) => distToGeom(h.p, gs[0]) < 1e-9 && Math.abs(h.p[1] - 5) < 1e-9), JSON.stringify(hits.map((h) => h.p)));
  const rs = computeRegions(gs);
  check('a line through the centre splits it into two equal halves', rs.length === 2 && rs.every((r) => near(r.area, (Math.PI * 30 * 12) / 2, 0.5)), rs.map((r) => r.area.toFixed(2)).join());
  const g = curveGeom(ell(), ell().curves[0]), tip = ellipsePoint(g, 0);
  const sk2 = ell(12, { points: [{ id: 'cc', x: tip[0], y: tip[1] }], curves: [{ id: 'C', type: 'circle', c: 'cc', r: 8 }] });
  const g2 = sketchGeom(sk2), cross = intersect(g2[0], g2[1]);
  check('an ellipse and a circle cross at two points on both', cross.length === 2 && cross.every((h) => distToGeom(h.p, g2[0]) < 1e-9 && Math.abs(Math.hypot(h.p[0] - tip[0], h.p[1] - tip[1]) - 8) < 1e-9));
  const r3 = computeRegions(g2);
  const total = r3.reduce((a, r) => a + r.area, 0);
  check('ellipse and circle overlap: three regions, union area', r3.length === 3, `${r3.length} regions, ${total.toFixed(1)}`);
  const e2 = { points: [{ id: 'c', x: 0, y: 0 }, { id: 'a', x: 20, y: 0 }, { id: 'c2', x: 0, y: 0 }, { id: 'a2', x: 0, y: 20 }], curves: [{ id: 'e', type: 'ellipse', c: 'c', a: 'a', rb: 8 }, { id: 'f', type: 'ellipse', c: 'c2', a: 'a2', rb: 8 }], constraints: [], dims: [] };
  const x4 = intersect(...sketchGeom(e2));
  check('two crossed ellipses meet at four points', x4.length === 4 && x4.every((h) => near(Math.abs(h.p[0]), Math.abs(h.p[1]), 1e-9)), JSON.stringify(x4.map((h) => h.p.map((v) => +v.toFixed(4)))));
  const r5 = computeRegions(sketchGeom(e2));
  check('crossed ellipses make five regions', r5.length === 5, r5.map((r) => r.area.toFixed(1)).join());
}

// kernel: exact elliptical solids
const plane = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const V = Math.PI * 30 * 12 * 10;
{
  const r = await rebuild([{ id: 'sk', type: 'sketch', p: { plane, ...ell() } }, { id: 'ex', type: 'extrude', p: { sketch: 'sk', profiles: [], distance: '10', op: 'new' } }]);
  const pr = r.errors.ex ? null : properties(r.states.at(-1).bodies.get('ex'));
  check('extruding an ellipse gives exactly πab·h', pr && near(pr.volume, V, 1e-3), pr ? `${pr.volume.toFixed(4)} vs ${V.toFixed(4)}` : r.errors.ex);
  check('and its side area is perimeter × h', pr && near(pr.area, 2 * Math.PI * 30 * 12 + ellipsePerimeter(30, 12) * 10, 1e-2), pr && pr.area.toFixed(3));
  check('the centre of mass is the ellipse centre', pr && near(pr.centerOfMass[0], 10, 1e-6) && near(pr.centerOfMass[1], 5, 1e-6));
}
{
  const rect = { points: [[-40, -30], [60, -30], [60, 40], [-40, 40]].map(([x, y], i) => ({ id: `r${i}`, x, y })), curves: [0, 1, 2, 3].map((i) => ({ id: `rl${i}`, type: 'line', a: `r${i}`, b: `r${(i + 1) % 4}` })) };
  const r = await rebuild([{ id: 'sk', type: 'sketch', p: { plane, ...ell(12, rect) } }, { id: 'ex', type: 'extrude', p: { sketch: 'sk', profiles: [], distance: '10', op: 'new' } }]);
  const pr = r.errors.ex ? null : properties(r.states.at(-1).bodies.get('ex'));
  check('a plate with an elliptical hole', pr && near(pr.volume, 100 * 70 * 10 - V, 1e-3), pr ? pr.volume.toFixed(4) : r.errors.ex);
}
{
  // half an ellipse, cut off by a line through its centre along the major axis, picked by a point inside it
  const g = curveGeom(ell(), ell().curves[0]), A = ellipsePoint(g, 0), B = ellipsePoint(g, Math.PI), d = [(A[0] - B[0]) / 30, (A[1] - B[1]) / 30];
  const sk = ell(12, { points: [{ id: 'l1', x: B[0] - d[0] * 10, y: B[1] - d[1] * 10 }, { id: 'l2', x: A[0] + d[0] * 10, y: A[1] + d[1] * 10 }], curves: [{ id: 'L', type: 'line', a: 'l1', b: 'l2' }] });
  const inside = ellipsePoint({ ...g, rx: 15, ry: 6 }, Math.PI / 2);
  const r = await rebuild([{ id: 'sk', type: 'sketch', p: { plane, ...sk } }, { id: 'ex', type: 'extrude', p: { sketch: 'sk', profiles: [inside], distance: '10', op: 'new' } }]);
  const pr = r.errors.ex ? null : properties(r.states.at(-1).bodies.get('ex'));
  check('half an ellipse (split by a line) extrudes to exactly half', pr && near(pr.volume, V / 2, 1e-3), pr ? `${pr.volume.toFixed(4)} vs ${(V / 2).toFixed(4)}` : r.errors.ex);
}
{
  // an ellipse as a sweep path: a small circle swept round it gives an elliptical ring
  const prof = { points: [{ id: 'pc', x: 40, y: 5 + 0 }], curves: [{ id: 'pcc', type: 'circle', c: 'pc', r: 1 }], constraints: [], dims: [] };
  const flat = { points: [{ id: 'c', x: 0, y: 0 }, { id: 'a', x: 40, y: 0 }], curves: [{ id: 'e', type: 'ellipse', c: 'c', a: 'a', rb: 25 }], constraints: [], dims: [] };
  const r = await rebuild([
    { id: 'path', type: 'sketch', p: { plane, ...flat } },
    { id: 'pr', type: 'sketch', p: { plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] }, ...prof, points: [{ id: 'pc', x: 40, y: 0 }] } },
    { id: 'sw', type: 'sweep', p: { sketch: 'pr', profiles: [], path: 'path', orient: 'frenet', op: 'new' } },
  ]);
  const pr = r.errors.sw ? null : properties(r.states.at(-1).bodies.get('sw'));
  const Vr = Math.PI * 1 * ellipsePerimeter(40, 25);
  check('sweeping round an ellipse (volume ≈ πr² × perimeter)', pr && Math.abs(pr.volume - Vr) / Vr < 2e-3, pr ? `${pr.volume.toFixed(2)} vs ${Vr.toFixed(2)}` : r.errors.sw);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
