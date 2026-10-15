// CAM: facing, outside profile, pocket with stepdowns and pecking drill cycles, plus G-code output.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import opencascade from 'replicad-opencascadejs';
import { setOC, makeBaseBox, makeCylinder } from 'replicad';
import { emptyState, camToolpaths } from '../src/kernel/build.js';
import { postGcode, TOOL_LIBRARY } from '../src/cam.js';

const root = path.dirname(fileURLToPath(import.meta.url));
setOC(await opencascade({ locateFile: () => path.join(root, '../node_modules/replicad-opencascadejs/dist/replicad_single.wasm') }));
let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };
const near = (a, b, e = 1e-3) => Math.abs(a - b) < e;

// 100 × 60 × 10 plate (centred in X and Y, z 0..10), a 40 × 20 × 4 pocket and two Ø6 through holes
const part = makeBaseBox(100, 60, 10)
  .cut(makeBaseBox(40, 20, 4).translate([0, 0, 6]))
  .cut(makeCylinder(3, 20, [-35, 0, -5]))
  .cut(makeCylinder(3, 20, [35, 0, -5]));
const st = emptyState();
st.bodies.set('b', part);
const tools = Object.fromEntries(TOOL_LIBRARY.map((t) => [t.id, t]));
const em6 = TOOL_LIBRARY.find((t) => t.type === 'flat' && t.d === 6), dr6 = TOOL_LIBRARY.find((t) => t.type === 'drill' && t.d === 6);
const cam = {
  body: 'b', setup: { margin: 3, top: 1, safe: 10 }, tools,
  ops: [
    { id: 'o1', type: 'face', tool: em6.id },
    { id: 'o2', type: 'pocket', tool: em6.id, faces: [{ body: 'b', p: [0, 0, 6], n: [0, 0, 1] }] },
    { id: 'o3', type: 'drill', tool: dr6.id, faces: [{ body: 'b', p: [-35, 3, 5], n: [1, 0, 0] }, { body: 'b', p: [35, 3, 5], n: [-1, 0, 0] }] },
    { id: 'o4', type: 'profile', tool: em6.id, side: 'outside', through: true, faces: [{ body: 'b', p: [30, 25, 10], n: [0, 0, 1] }] },
  ],
};
const res = camToolpaths(st, cam);
const [face, pocket, drill, profile] = res.ops;
check('all operations generate toolpaths', res.ops.every((o) => !o.error && o.moves.length > 4), res.ops.map((o) => o.error || o.moves.length).join(', '));
check('stock is the part plus margins and top allowance', near(res.stock.lo[0], -53) && near(res.stock.hi[1], 33) && near(res.stock.hi[2], 11), JSON.stringify(res.stock));

const feeds = (o) => o.moves.filter((m) => !m.r).map((m) => m.p);
const zs = (o) => [...new Set(feeds(o).map((p) => +p[2].toFixed(4)))].sort((a, b) => b - a);
check('facing removes the 1 mm allowance down to the part top', near(Math.min(...feeds(face).map((p) => p[2])), 10), JSON.stringify(zs(face)));

// pocket: 6 mm tool in a 40 × 20 pocket → the outer ring runs 3 mm inside the walls; depth 4 in ≤ stepdown passes
const pf = feeds(pocket);
const px = Math.max(...pf.map((p) => p[0])), py = Math.max(...pf.map((p) => p[1]));
check('pocket stays a tool radius inside the walls', near(px, 20 - 3, 0.05) && near(py, 10 - 3, 0.05), `${px.toFixed(3)}, ${py.toFixed(3)}`);
const pz = zs(pocket);
check('pocket reaches the floor in equal stepdowns', near(Math.min(...pz), 6) && pz.length === Math.ceil(4 / em6.stepdown) && pz.every((z) => z <= 10 + 1e-9), JSON.stringify(pz));

// drill: both hole centres, through the bottom by the tip allowance, pecking
const df = feeds(drill);
const xs = [...new Set(df.map((p) => p[0].toFixed(3)))];
check('drill visits both hole centres', xs.length === 2 && xs.includes('-35.000') && xs.includes('35.000'), JSON.stringify(xs));
check('drill goes through the plate and pecks', Math.min(...df.map((p) => p[2])) < 0 && df.length >= 2 * Math.ceil(10 / dr6.peck), `${df.length} feeds, bottom ${Math.min(...df.map((p) => p[2])).toFixed(2)}`);

// outside profile through the part: tool centre 3 mm outside the 100 × 60 outline
const of = feeds(profile);
check('outside profile runs a tool radius outside the part', near(Math.max(...of.map((p) => p[0])), 53, 0.05) && near(Math.min(...of.map((p) => p[1])), -33, 0.05), `${Math.max(...of.map((p) => p[0])).toFixed(3)}`);
check('profile cuts through the bottom', Math.min(...of.map((p) => p[2])) < 0, `${Math.min(...of.map((p) => p[2]))}`);
check('cycle time is estimated', res.ops.every((o) => o.time > 0), res.ops.map((o) => o.time.toFixed(0)).join(' s, ') + ' s');

// errors are explained per operation
const bad = camToolpaths(st, { ...cam, ops: [{ id: 'x', type: 'pocket', tool: em6.id, faces: [{ body: 'b', p: [-50, 0, 5], n: [-1, 0, 0] }] }] });
check('a pocket on a side face is rejected with a reason', /XY plane/.test(bad.ops[0].error || ''), bad.ops[0].error || '');

// G-code: units, absolute, work offset from the stock top-left, tool changes, spindle and feeds
const g = postGcode(res, cam, { origin: 'stock-top-left', name: 'Plate' });
const lines = g.split('\n');
check('G-code header sets mm, absolute and the XY plane', lines.some((l) => /^G21/.test(l)) && lines.some((l) => /^G90/.test(l)) && lines.some((l) => /G17/.test(l)));
check('tool changes follow the operation order (mill, drill, mill) with two tool numbers', (g.match(/^T\d+ M6/gm) || []).length === 3 && new Set(g.match(/^T\d+ M6/gm)).size === 2 && /^S\d+ M3/m.test(g) && /^M30/m.test(g), `${(g.match(/^T\d+ M6/gm) || []).length} tool changes`);
const allZ = [...g.matchAll(/Z(-?\d+\.?\d*)/g)].map((m) => +m[1]);
check('Z is zero at the stock top', Math.max(...allZ) <= 10 + 1e-6 && near(Math.min(...allZ), -(11 + 0.6 * 6), 0.01), `${Math.min(...allZ)} … ${Math.max(...allZ)}`);
const allX = [...g.matchAll(/X(-?\d+\.?\d*)/g)].map((m) => +m[1]);
check('X is measured from the stock left edge', Math.min(...allX) >= -3.01 - 1e-6, `${Math.min(...allX)}`);

// holding tabs on the through profile: 4 tabs, 6 mm wide, 2 mm high, so the plate stays in the stock
{
  const camT = { ...cam, ops: [{ ...cam.ops[3], tabs: 4, tabWidth: 6, tabHeight: 2 }] };
  const T = camToolpaths(st, camT).ops[0];
  // points along every feed move (moves only have points at the tab edges and corners)
  const cuts = [];
  T.moves.forEach((m, i) => { if (m.r || !i) return; const a = T.moves[i - 1].p, b = m.p; for (let k = 0; k <= 20; k++) cuts.push(a.map((v, j) => v + ((b[j] - v) * k) / 20)); });
  const near2 = (p, c, d) => Math.hypot(p[0] - c[0], p[1] - c[1]) < d;
  check('tabs are placed on the outer outline', !T.error && T.tabs?.length === 4, `${T.error || ''} ${JSON.stringify(T.tabs)}`);
  // over each tab the tool stays at or above the tab top; away from them it cuts through
  const overTabs = cuts.filter((p) => T.tabs.some((c) => near2(p, c, 2.9)));
  const away = cuts.filter((p) => !T.tabs.some((c) => near2(p, c, 3 + 3 + 1)));
  check('the tool never cuts into a tab', overTabs.length > 0 && Math.min(...overTabs.map((p) => p[2])) >= 2 - 1e-9, `lowest over tabs ${Math.min(...overTabs.map((p) => p[2]))}`);
  check('between the tabs it still cuts through the part', Math.min(...away.map((p) => p[2])) < 0, `lowest away ${Math.min(...away.map((p) => p[2]))}`);
  const g = postGcode(camToolpaths(st, camT), camT);
  check('tabbed profile posts to G-code', /\bG1\b/.test(g));
}

// engraving: a line and a Ø20 circle sketched on the plate's top face (z = 10), 0.5 mm deep with a 90° V-bit
{
  const stE = emptyState();
  stE.bodies.set('b', part);
  stE.sketches.set('logo', { plane: { origin: [0, 0, 10], xDir: [1, 0, 0], normal: [0, 0, 1] }, geom: [{ type: 'line', a: [-20, 0], b: [20, 0] }, { type: 'circle', c: [0, 0], r: 10 }] });
  const vb = TOOL_LIBRARY.find((t) => t.type === 'vbit' && t.angle === 90);
  const E = camToolpaths(stE, { body: 'b', setup: { margin: 3, top: 1, safe: 10 }, tools, ops: [{ id: 'e', type: 'engrave', tool: vb.id, sketch: 'logo', depth: 0.5 }] }).ops[0];
  const cutsE = E.moves.filter((m) => !m.r).map((m) => m.p);
  const deep = cutsE.filter((p) => Math.abs(p[2] - 9.5) < 1e-9);
  check('engraving cuts to 0.5 mm below the sketch plane', !E.error && deep.length > 50 && Math.min(...cutsE.map((p) => p[2])) >= 9.5 - 1e-9, `${E.error || ''} ${deep.length} points at z 9.5`);
  check('it follows the sketch: the line and the circle', deep.every((p) => Math.abs(p[1]) < 1e-9 || Math.abs(Math.hypot(p[0], p[1]) - 10) < 1e-3) && deep.some((p) => Math.abs(p[0] + 20) < 1e-9) && deep.some((p) => Math.abs(p[1] - 10) < 0.01));
  check('a V-bit reports the line width it cuts (1 mm at 0.5 mm deep for 90°)', E.warnings.some((w) => /1 mm wide/.test(w)), E.warnings.join(' | '));
  const bad = camToolpaths(stE, { body: 'b', setup: { margin: 3, top: 1, safe: 10 }, tools, ops: [{ id: 'e', type: 'engrave', tool: vb.id, sketch: 'nope', depth: 0.5 }] }).ops[0];
  check('engraving without a sketch explains why', /Choose the sketch/.test(bad.error || ''), bad.error);
}

// 3D machining of a dome: R30 sphere cap on a 60 × 60 × 10 block (top of the dome at z = 15)
{
  const { makeSphere } = await import('replicad');
  const dome = makeBaseBox(60, 60, 10).fuse(makeSphere(30).translate([0, 0, -15]).intersect(makeBaseBox(60, 60, 40)));
  const st3 = emptyState();
  st3.bodies.set('d', dome);
  const bm6 = TOOL_LIBRARY.find((t) => t.type === 'ball' && t.d === 6);
  const cam3 = { body: 'd', setup: { margin: 3, top: 1, safe: 10 }, tools, ops: [{ id: 'r', type: 'rough3d', tool: em6.id, leave: 0.3, tolerance: 0.25 }, { id: 'f', type: 'parallel', tool: bm6.id, leave: 0, tolerance: 0.1 }] };
  const t0 = performance.now();
  const res3 = camToolpaths(st3, cam3);
  const [R3, F3] = res3.ops;
  check('3D roughing and finishing toolpaths compute', !R3.error && !F3.error && R3.moves.length > 50 && F3.moves.length > 50, `${R3.error || ''} ${F3.error || ''} ${R3.moves.length}/${F3.moves.length} moves, ${Math.round(performance.now() - t0)} ms`);
  // the dome surface height at (x, y), or the block top
  const surf = (x, y) => { const q = 900 - x * x - y * y; return Math.max(10, q > 0 ? Math.sqrt(q) - 15 : -Infinity); };
  // finishing: the ball (centre = tip + 3) never enters the sphere, and it touches the top of the dome
  const cuts = F3.moves.filter((m) => !m.r && Math.abs(m.p[0]) < 30 && Math.abs(m.p[1]) < 30);
  const gouge = Math.min(...cuts.map((m) => { const c = [m.p[0], m.p[1], m.p[2] + 3]; return Math.hypot(c[0], c[1], c[2] + 15) - 33; }).filter((d) => Number.isFinite(d) && cuts.length));
  const topTip = Math.max(...cuts.map((m) => m.p[2]));
  check('ball finishing does not gouge the dome (within the tolerance)', gouge > -0.12, `closest ${gouge.toFixed(4)} mm`);
  check('ball finishing reaches the top of the dome', near(topTip, 15, 0.12), `highest tip ${topTip.toFixed(3)}`);
  // roughing: the flat end mill never goes below surface + leave under its centre
  const under = Math.min(...R3.moves.filter((m) => !m.r && Math.abs(m.p[0]) < 27 && Math.abs(m.p[1]) < 27).map((m) => m.p[2] - surf(m.p[0], m.p[1])));
  check('3D roughing leaves stock on the surface', under > 0.3 - 0.13, `min gap ${under.toFixed(3)}`);
  const g3 = postGcode(res3, cam3);
  check('3D toolpaths post to G-code', /\bG1\b/.test(g3) && g3.split('\n').length > 100, `${g3.split('\n').length} lines: ${g3.split('\n').slice(10, 14).join(' / ')}`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
