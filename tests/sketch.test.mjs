// Sketch solver + region detection tests: `node tests/sketch.test.mjs`
import { solveSketch } from '../src/sketch/solver.js';
import { computeRegions, selectRegions } from '../src/sketch/regions.js';
import { sketchGeom, migrateSketch } from '../src/sketch/model.js';

let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

function rectSketch(x0, y0, x1, y1, pre = '') {
  const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y], i) => ({ id: `${pre}p${i}`, x, y }));
  const curves = pts.map((p, i) => ({ id: `${pre}l${i}`, type: 'line', a: p.id, b: pts[(i + 1) % 4].id }));
  const constraints = [
    { id: `${pre}h0`, type: 'horizontal', line: `${pre}l0` }, { id: `${pre}h2`, type: 'horizontal', line: `${pre}l2` },
    { id: `${pre}v1`, type: 'vertical', line: `${pre}l1` }, { id: `${pre}v3`, type: 'vertical', line: `${pre}l3` },
  ];
  return { points: pts, curves, constraints, dims: [] };
}

// 1. fully constrained rectangle
{
  const sk = rectSketch(1, 2, 37, 25);
  sk.constraints.push({ id: 'c0', type: 'coincident', a: 'p0', b: 'O' });
  sk.dims.push({ id: 'd0', type: 'length', line: 'l0', value: 40 }, { id: 'd1', type: 'length', line: 'l1', value: 20 });
  const t = performance.now();
  const r = solveSketch(sk);
  const P = Object.fromEntries(r.sketch.points.map((p) => [p.id, [p.x, p.y]]));
  check('rect solves', r.ok, `${(performance.now() - t).toFixed(1)} ms`);
  check('rect corner at origin', near(P.p0[0], 0) && near(P.p0[1], 0));
  check('rect size 40x20', near(P.p2[0], 40) && near(P.p2[1], 20), JSON.stringify(P.p2));
  const a = r.analyze();
  check('rect fully constrained (0 DOF)', a.dof === 0, `dof=${a.dof}`);
  // remove one dim → 1 DOF
  const r2 = solveSketch({ ...sk, dims: sk.dims.slice(0, 1) });
  check('rect with one dim has 1 DOF', r2.analyze().dof === 1, `dof=${r2.analyze().dof}`);
}

// 2. conflicting constraints are reported
{
  const sk = rectSketch(0, 0, 10, 10);
  sk.constraints.push({ id: 'bad', type: 'parallel', l1: 'l0', l2: 'l1' });
  const r = solveSketch(sk);
  check('over-constrained detected', !r.ok, JSON.stringify(r.failed));
}

// 3. tangent arc + circle radius dim + equal
{
  const sk = {
    points: [{ id: 'c', x: 0, y: 0 }, { id: 'a', x: 10, y: 0 }, { id: 'b', x: 0, y: 11 }, { id: 'q1', x: -5, y: 13 }, { id: 'q2', x: 30, y: 12 }],
    curves: [{ id: 'arc', type: 'arc', c: 'c', a: 'a', b: 'b' }, { id: 'ln', type: 'line', a: 'q1', b: 'q2' }, { id: 'ci', type: 'circle', c: 'c', r: 3 }],
    constraints: [{ id: 't', type: 'tangent', c1: 'ln', c2: 'arc' }, { id: 'e', type: 'equal', c1: 'ci', c2: 'arc' }, { id: 'h', type: 'horizontal', line: 'ln' }],
    dims: [{ id: 'r', type: 'radius', curve: 'arc', value: 8 }],
  };
  const r = solveSketch(sk);
  const P = Object.fromEntries(r.sketch.points.map((p) => [p.id, [p.x, p.y]]));
  check('arc/tangent solves', r.ok, JSON.stringify(r.failed));
  check('line tangent at distance r', near(Math.abs(P.q1[1] - P.c[1]), 8, 1e-5), P.q1[1].toFixed(4));
  check('equal: circle radius follows arc', near(r.sketch.curves.find((c) => c.id === 'ci').r, 8, 1e-5));
  check('arc end stays on circle', near(Math.hypot(P.b[0] - P.c[0], P.b[1] - P.c[1]), 8, 1e-5));
}

// 4. drag keeps constraints
{
  const sk = rectSketch(0, 0, 10, 10);
  const r = solveSketch(sk, { drag: { point: 'p2', target: [20, 15] } });
  const P = Object.fromEntries(r.sketch.points.map((p) => [p.id, [p.x, p.y]]));
  check('drag solves', r.ok);
  check('drag moved corner', Math.hypot(P.p2[0] - 20, P.p2[1] - 15) < 0.5, JSON.stringify(P.p2));
  check('drag keeps rectangle', near(P.p1[0], P.p2[0], 1e-6) && near(P.p3[1], P.p2[1], 1e-6));
}

// 5. regions: rect with circle hole
{
  const sk = rectSketch(0, 0, 40, 20);
  sk.points.push({ id: 'cc', x: 20, y: 10 });
  sk.curves.push({ id: 'circ', type: 'circle', c: 'cc', r: 5 });
  const regs = computeRegions(sketchGeom(sk));
  check('rect+circle → 2 regions', regs.length === 2, `${regs.length}`);
  const sel = selectRegions(regs, []);
  check('default selection = rect with hole', sel.length === 1 && sel[0].holes.length === 1 && near(sel[0].area, 800 - Math.PI * 25, 0.5), sel.map((s) => s.area.toFixed(1)).join(','));
  const disc = selectRegions(regs, [[20, 10]]);
  check('clicking inside circle picks the disc', disc.length === 1 && near(disc[0].area, Math.PI * 25, 0.5));
}

// 6. overlapping rectangles (crossing, no shared points) → 3 regions
{
  const a = rectSketch(0, 0, 20, 20, 'a'), b = rectSketch(10, 10, 30, 30, 'b');
  const sk = { points: [...a.points, ...b.points], curves: [...a.curves, ...b.curves], constraints: [], dims: [] };
  const regs = computeRegions(sketchGeom(sk));
  check('overlapping rects → 3 regions', regs.length === 3, regs.map((r) => r.area.toFixed(0)).join(','));
  check('default selects all (union)', selectRegions(regs, []).length === 3);
}

// 7. rect split by a line with T-junctions
{
  const sk = rectSketch(0, 0, 40, 20);
  sk.points.push({ id: 'm1', x: 15, y: 0 }, { id: 'm2', x: 15, y: 20 });
  sk.curves.push({ id: 'mid', type: 'line', a: 'm1', b: 'm2' });
  const regs = computeRegions(sketchGeom(sk));
  check('T-junction split → 2 regions', regs.length === 2 && regs.some((r) => near(r.area, 300, 1e-3)), regs.map((r) => r.area.toFixed(1)).join(','));
}

// 8. slot (2 lines + 2 arcs) and migration of v1 entities
{
  const sk = migrateSketch({ entities: [{ type: 'slot', a: [0, 0], b: [30, 0], r: 5 }, { type: 'rect', a: [-20, -20], b: [50, 20] }, { type: 'polygon', c: [60, 0], r: 8, n: 6 }] });
  const regs = computeRegions(sketchGeom(sk));
  const sel = selectRegions(regs, []);
  const slotArea = 30 * 10 + Math.PI * 25;
  check('migrated sketch regions', regs.length === 3, regs.map((r) => r.area.toFixed(1)).join(','));
  check('rect has slot hole', sel.some((r) => r.holes.length === 1 && near(r.area, 70 * 40 - slotArea, 0.5)));
}

// 9. performance on a busier sketch
{
  const parts = [];
  for (let i = 0; i < 12; i++) parts.push(rectSketch(i * 12, 0, i * 12 + 10, 10, `r${i}`));
  const sk = { points: parts.flatMap((p) => p.points), curves: parts.flatMap((p) => p.curves), constraints: parts.flatMap((p) => p.constraints), dims: [] };
  for (let i = 0; i < 12; i++) sk.dims.push({ id: `w${i}`, type: 'length', line: `r${i}l0`, value: 8 }, { id: `h${i}`, type: 'length', line: `r${i}l1`, value: 6 });
  const t = performance.now();
  const r = solveSketch(sk);
  const dt = performance.now() - t;
  check('48-line sketch solves fast', r.ok && dt < 100, `${dt.toFixed(1)} ms`);
  const t2 = performance.now();
  computeRegions(sketchGeom(r.sketch));
  check('regions fast', performance.now() - t2 < 100, `${(performance.now() - t2).toFixed(1)} ms`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
