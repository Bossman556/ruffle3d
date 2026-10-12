// Drawing views: section through a part with a hole, cut faces as closed loops aligned with the view.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import opencascade from 'replicad-opencascadejs';
import { setOC, makeBaseBox, makeCylinder } from 'replicad';
import { projectViews, sectionView, drawingHoles } from '../src/kernel/build.js';

const root = path.dirname(fileURLToPath(import.meta.url));
setOC(await opencascade({ locateFile: () => path.join(root, '../node_modules/replicad-opencascadejs/dist/replicad_single.wasm') }));
let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };
const near = (a, b, e = 1e-3) => Math.abs(a - b) < e;
const area = (ring) => { let a = 0; for (let i = 0; i < ring.length; i++) { const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length]; a += x0 * y1 - x1 * y0; } return Math.abs(a / 2); };

// 80 × 40 × 20 block (centred in X and Y, z 0..20) with a Ø10 vertical through hole at the centre
const part = makeBaseBox(80, 40, 20).cut(makeCylinder(5, 40, [0, 0, -10], [0, 0, 1]));
const sec = sectionView([part], { axis: 'Y', at: 0.5 });
check('section view has visible lines', sec.visible.length > 4, `${sec.visible.length} paths`);
check('cut through the hole gives two hatched regions', sec.loops.length === 2, `${sec.loops.length}`);
const total = sec.loops.reduce((s, rings) => s + area(rings[0]), 0);
check('cut area = (80 − 10) × 20', near(total, 70 * 20, 0.5), total.toFixed(2));
const pts = sec.loops.flat(2);
const [lx, ly, hx, hy] = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
check('cut faces line up with the projected view', near(lx, sec.bbox[0][0], 1e-3) && near(hx, sec.bbox[1][0], 1e-3) && near(ly, sec.bbox[0][1], 1e-3) && near(hy, sec.bbox[1][1], 1e-3), JSON.stringify([[lx, ly], [hx, hy], sec.bbox]));
const front = projectViews([part], ['front'])[0];
check('section matches the front view outline', near(front.bbox[1][0] - front.bbox[0][0], hx - lx, 1e-3) && near(front.bbox[1][1] - front.bbox[0][1], hy - ly, 1e-3));

// off-centre cut misses the hole: one region with the full width
const off = sectionView([part], { axis: 'Y', at: 0.1 });
check('off-centre cut gives one full region', off.loops.length === 1 && near(area(off.loops[0][0]), 80 * 20, 0.5), `${off.loops.length}`);
// side section (B–B) through the hole
const side = sectionView([part], { axis: 'X', at: 0.5 });
check('side section through the hole', side.loops.length === 2 && near(side.loops.reduce((s, r) => s + area(r[0]), 0), 30 * 20, 0.5), `${side.loops.length}`);
// a plate with a closed pocket: cut faces with holes keep their inner ring
const ring = makeCylinder(20, 10, [0, 0, 0], [0, 0, 1]).cut(makeCylinder(10, 10, [0, 0, 0], [0, 0, 1]));
const rs = sectionView([ring], { axis: 'Z', at: 0.5 });
check('section of a tube is a ring with a hole', rs.loops.length === 1 && rs.loops[0].length === 2 && near(area(rs.loops[0][0]) - area(rs.loops[0][1]), Math.PI * (400 - 100), 3), `${rs.loops.length} loops, ${rs.loops[0]?.length} rings`);

// hole callouts: two plain through holes, one counterbored, one blind
const plate = makeBaseBox(100, 60, 10)
  .cut(makeCylinder(3, 20, [-30, 15, -5])).cut(makeCylinder(3, 20, [30, 15, -5]))
  .cut(makeCylinder(4, 20, [0, -10, -5])).cut(makeCylinder(7, 4, [0, -10, 6]))
  .cut(makeCylinder(2.5, 6, [-30, -15, 4]));
const holes = drawingHoles([plate]);
// a countersunk hole on its own plate: Ø6 through with a 90° countersink to Ø12
{
  const { rebuild } = await import('../src/kernel/build.js');
  const r = await rebuild([
    { id: 'b', type: 'box', p: { w: 40, d: 40, h: 10, x: 0, y: 0, z: 0, op: 'new' } },
    { id: 'h', type: 'hole', p: { points: [{ body: 'b', p: [0, 0, 10], n: [0, 0, 1] }], diameter: 6, through: true, depth: 10, csink: true, csinkD: 12 } },
  ]);
  const ch = drawingHoles([r.states.at(-1).bodies.get('b')]);
  check('countersink is found on the hole', ch.length === 1 && ch[0].csink && Math.abs(ch[0].csink.d - 12) < 0.05, JSON.stringify(ch[0]?.csink));
  // a boss with a chamfered outer edge and a plain hole: the chamfer is not a countersink
  const r2 = await rebuild([
    { id: 'p', type: 'box', p: { w: 40, d: 40, h: 5, x: 0, y: 0, z: 0, op: 'new' } },
    { id: 'c', type: 'cylinder', p: { r: 10, h: 15, copy: false } },
  ]);
  const { makeCylinder: mc } = await import('replicad');
  const bossed = r2.states.at(-1).bodies.get('p').fuse(mc(10, 15)).chamfer(1.5, (e) => e.inPlane('XY', 15)).cut(mc(4, 40, [0, 0, -5]));
  const bh = drawingHoles([bossed]);
  check('an outside chamfer is not reported as a countersink', bh.length === 1 && !bh[0].csink, JSON.stringify(bh.map((h) => [h.d, h.csink])));
}
check('finds the four holes (outer cylinders are not holes)', holes.length === 4, JSON.stringify(holes.map((h) => h.d.toFixed(2))));
const thru6 = holes.filter((h) => Math.abs(h.d - 6) < 1e-3);
check('Ø6 holes are through', thru6.length === 2 && thru6.every((h) => h.through && Math.abs(h.depth - 10) < 1e-3));
const cb = holes.find((h) => Math.abs(h.d - 8) < 1e-3);
check('Ø8 hole has a Ø14 × 4 counterbore', cb && cb.through && cb.cbore && Math.abs(cb.cbore.d - 14) < 1e-3 && Math.abs(cb.cbore.depth - 4) < 1e-3, JSON.stringify(cb?.cbore));
const blind = holes.find((h) => Math.abs(h.d - 5) < 1e-3);
check('Ø5 hole is blind, 6 deep', blind && !blind.through && Math.abs(blind.depth - 6) < 1e-3, blind && `${blind.depth}`);
// positions match the top view's frame: hole centres sit inside the top view's bounding box, mirrored in Y (SVG)
const top = projectViews([plate], ['top'])[0];
const inBox = holes.every((h) => h.x > top.bbox[0][0] && h.x < top.bbox[1][0] && h.y > top.bbox[0][1] && h.y < top.bbox[1][1]);
const a = holes.find((h) => Math.abs(h.d - 6) < 1e-3 && h.x < (top.bbox[0][0] + top.bbox[1][0]) / 2);
check('callout positions are in the top view frame', inBox && a && Math.abs(a.x - (top.bbox[0][0] + 20)) < 1e-3 && Math.abs(a.y - (top.bbox[0][1] + 15)) < 1e-3, JSON.stringify([a?.x, a?.y, top.bbox]));

// annotation snapping and rendering
{
  const { parseSnaps, annotationsSVG } = await import('../src/annotate.js');
  const sn = parseSnaps(['M -17 -10 L 17 -10 A 3 3 0 0 1 20 -7 L 20 7', 'M 4 0 A 4 4 0 0 0 -4 0 A 4 4 0 0 0 4 0 Z']);
  const fil = sn.circles.find((c) => Math.abs(c.r - 3) < 1e-9), hole = sn.circles.find((c) => Math.abs(c.r - 4) < 1e-9);
  check('fillet arc centre is recovered from SVG arc flags', fil && near(fil.c[0], 17) && near(fil.c[1], -7) && !fil.full, JSON.stringify(fil));
  check('two half-arcs make a full circle at the right centre', hole && hole.full && near(hole.c[0], 0) && near(hole.c[1], 0));
  check('circle seams are not snap points, fillet ends are', !sn.pts.some((p) => near(p[0], 4) && near(p[1], 0)) && sn.pts.some((p) => near(p[0], 20) && near(p[1], -7)));
  const V = { k: 2, rect: [0, 0, 100, 100], toSheet: (x, y) => [10 + x * 2, 10 + y * 2], toView: (X, Y) => [(X - 10) / 2, (Y - 10) / 2] };
  const svg = annotationsSVG([{ id: 'd1', t: 'lin', view: 'front', a: [0, 0], b: [37.5, 5], at: [10, 20], dir: 'h', tol: '±0.1' }, { id: 'd2', t: 'dia', view: 'front', c: [0, 0], r: 3.25, at: [10, -10] }], { views: { front: V }, du: (x) => (Math.round(x * 100) / 100).toString() }, null);
  check('dimension text shows the model value with its tolerance, independent of scale', svg.includes('>37.5<') && svg.includes('±0.1') && svg.includes('Ø6.5'), svg.match(/>[^<]{1,12}</g)?.slice(0, 6).join(' '));
}

// associative dimensions: a 60 × 10 plate front view grows to 80 wide; the length dimension follows its edges
{
  const { parseSnaps, reanchor } = await import('../src/annotate.js');
  const outline = (w) => [`M ${-w / 2} -10 L ${w / 2} -10 L ${w / 2} 0 L ${-w / 2} 0 Z`, `M 4 -5 A 4 4 0 0 0 -4 -5 A 4 4 0 0 0 4 -5 Z`];
  const items = [
    { id: 'L', t: 'lin', view: 'front', a: [-30, 0], b: [30, 0], at: [0, 8], dir: 'h', vb: [[-30, -10], [30, 0]] },
    { id: 'H', t: 'lin', view: 'front', a: [30, -10], b: [30, 0], at: [36, -5], dir: 'v', vb: [[-30, -10], [30, 0]] },
    { id: 'D', t: 'dia', view: 'front', c: [0, -5], r: 4, at: [15, -20], vb: [[-30, -10], [30, 0]] },
  ];
  reanchor(items, { front: [[-40, -10], [40, 0]] }, { front: parseSnaps(outline(80)) });
  const [L, H, D] = items;
  check('a length dimension follows its edges when the part grows', near(L.a[0], -40) && near(L.b[0], 40) && near(L.at[1], 8) && !L.lost, JSON.stringify(L));
  check('a height dimension moves with the side it measures and keeps its offset', near(H.a[0], 40) && near(H.b[0], 40) && near(H.at[0], 46) && !H.lost, JSON.stringify(H));
  check('a diameter stays on its hole', near(D.c[0], 0) && near(D.r, 4) && !D.lost, JSON.stringify(D));
  // the hole is removed: the diameter is flagged
  reanchor(items, { front: [[-40, -10], [40, 1]] }, { front: parseSnaps(['M -40 -10 L 40 -10 L 40 1 L -40 1 Z']) });
  check('a dimension whose geometry is gone is flagged as lost', items[2].lost === true && !items[0].lost, JSON.stringify(items.map((i) => [i.id, !!i.lost])));
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
