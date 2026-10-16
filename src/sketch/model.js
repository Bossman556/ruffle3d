// Sketch v2 data model: points + curves + constraints + dimensions (sketch-local 2D coordinates, mm).
//
// sketch = {
//   points:      [{ id, x, y, fixed? }]
//   curves:      [{ id, type: 'line', a, b } | { id, type: 'circle', c, r } | { id, type: 'arc', c, a, b }   (ccw a→b)
//                 | { id, type: 'spline', pts: [pointIds], closed }
//                 | { id, type: 'ellipse', c, a, rb }]  (a: end of the major axis, rb: minor radius)  (+ construction?, projected?)
//   constraints: [{ id, type, ...refs }]
//   dims:        [{ id, type, ...refs, expr, value?, off: [du, dv] }]
// }
// Virtual, always-fixed references: point 'O' (origin), lines 'AX' (sketch X axis) and 'AY' (Y axis).

export const VIRTUAL_POINTS = { O: [0, 0], OX: [1, 0], OY: [0, 1] };
export const VIRTUAL_LINES = { AX: { id: 'AX', type: 'line', a: 'O', b: 'OX', virtual: true }, AY: { id: 'AY', type: 'line', a: 'O', b: 'OY', virtual: true } };

let seq = 0;
export const uid = (p = 'k') => `${p}${Date.now().toString(36).slice(-4)}${(seq++).toString(36)}`;

export function emptySketch() {
  return { points: [], curves: [], constraints: [], dims: [] };
}

export function pointPos(sk, id) {
  if (VIRTUAL_POINTS[id]) return VIRTUAL_POINTS[id];
  const p = sk.points.find((q) => q.id === id);
  return p ? [p.x, p.y] : null;
}

export function getCurve(sk, id) {
  return VIRTUAL_LINES[id] || sk.curves.find((c) => c.id === id);
}

// ---------- geometry evaluation ----------
const TAU = Math.PI * 2;
export const normAng = (a) => ((a % TAU) + TAU) % TAU;

// Converts Catmull-Rom fit points to cubic Bezier segments (identical curve, exact for the kernel).
export function catmullBeziers(pts, closed) {
  const n = pts.length;
  if (n < 2) return [];
  const get = (i) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  const segs = [];
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    segs.push([p1, [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6], p2]);
  }
  return segs;
}

export function bezPoint([p0, c1, c2, p1], t) {
  const u = 1 - t;
  return [
    u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0],
    u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1],
  ];
}

// Point ids a curve is built on.
export function curvePointIds(c) {
  if (c.type === 'line') return [c.a, c.b];
  if (c.type === 'circle') return [c.c];
  if (c.type === 'arc') return [c.c, c.a, c.b];
  if (c.type === 'ellipse') return [c.c, c.a];
  return c.pts || [];
}

// ---------- ellipses ----------
// e = { c, rx, ry, rot }: centre, major and minor radius, angle of the major axis.
// Points are c + rx·cos t·u + ry·sin t·v with u along the major axis and v perpendicular to it.
export function ellipsePoint(e, t) {
  const cr = Math.cos(e.rot), sr = Math.sin(e.rot), x = e.rx * Math.cos(t), y = e.ry * Math.sin(t);
  return [e.c[0] + x * cr - y * sr, e.c[1] + x * sr + y * cr];
}
// Local coordinates of p in the ellipse frame.
export function ellipseLocal(e, p) {
  const dx = p[0] - e.c[0], dy = p[1] - e.c[1], cr = Math.cos(e.rot), sr = Math.sin(e.rot);
  return [dx * cr + dy * sr, -dx * sr + dy * cr];
}
// Parameter of the point on the ellipse closest to p (coarse search, then Newton).
export function ellipseClosestT(e, p) {
  const [x, y] = ellipseLocal(e, p);
  let best = 0, bd = Infinity;
  for (let i = 0; i < 64; i++) {
    const t = (i / 64) * TAU, d = (e.rx * Math.cos(t) - x) ** 2 + (e.ry * Math.sin(t) - y) ** 2;
    if (d < bd) { bd = d; best = t; }
  }
  let t = best;
  for (let k = 0; k < 30; k++) {
    const c = Math.cos(t), s = Math.sin(t);
    // f(t) = d/dt ½|E(t) − p|²
    const f = (e.rx * c - x) * -e.rx * s + (e.ry * s - y) * e.ry * c;
    const df = e.rx * e.rx * s * s - (e.rx * c - x) * e.rx * c + e.ry * e.ry * c * c - (e.ry * s - y) * e.ry * s;
    if (Math.abs(df) < 1e-14) break;
    const step = f / df;
    t -= Math.max(-0.5, Math.min(0.5, step));
    if (Math.abs(step) < 1e-13) break;
  }
  return normAng(t);
}
// Perimeter (Ramanujan's second approximation: relative error below 1e-9 for b/a > 0.1).
export function ellipsePerimeter(rx, ry) {
  const h = ((rx - ry) / (rx + ry)) ** 2;
  return Math.PI * (rx + ry) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

// Geometry with resolved coordinates. Returns null for curves with missing points.
export function curveGeom(sk, c) {
  const P = (id) => pointPos(sk, id);
  if (c.type === 'line') {
    const a = P(c.a), b = P(c.b);
    return a && b ? { id: c.id, type: 'line', a, b, construction: !!c.construction, projected: !!c.projected } : null;
  }
  if (c.type === 'circle') {
    const ctr = P(c.c);
    return ctr ? { id: c.id, type: 'circle', c: ctr, r: c.r, construction: !!c.construction, projected: !!c.projected } : null;
  }
  if (c.type === 'arc') {
    const ctr = P(c.c), a = P(c.a), b = P(c.b);
    if (!ctr || !a || !b) return null;
    const r = Math.hypot(a[0] - ctr[0], a[1] - ctr[1]);
    const a0 = Math.atan2(a[1] - ctr[1], a[0] - ctr[0]);
    let sweep = normAng(Math.atan2(b[1] - ctr[1], b[0] - ctr[0]) - a0);
    if (sweep < 1e-9) sweep = TAU;
    // the end point lies exactly on the circle in the evaluated geometry
    const bb = [ctr[0] + r * Math.cos(a0 + sweep), ctr[1] + r * Math.sin(a0 + sweep)];
    return { id: c.id, type: 'arc', c: ctr, r, a0, sweep, pa: a, pb: bb, construction: !!c.construction, projected: !!c.projected };
  }
  if (c.type === 'ellipse') {
    const ctr = P(c.c), a = P(c.a);
    if (!ctr || !a) return null;
    const rx = Math.hypot(a[0] - ctr[0], a[1] - ctr[1]);
    return { id: c.id, type: 'ellipse', c: ctr, rx, ry: Math.abs(c.rb), rot: Math.atan2(a[1] - ctr[1], a[0] - ctr[0]), pa: a, construction: !!c.construction, projected: !!c.projected };
  }
  if (c.type === 'spline') {
    const pts = c.pts.map(P);
    if (pts.some((p) => !p) || pts.length < 2) return null;
    return { id: c.id, type: 'spline', pts, closed: !!c.closed, bez: catmullBeziers(pts, !!c.closed), construction: !!c.construction, projected: !!c.projected };
  }
  return null;
}

export function sketchGeom(sk) {
  return sk.curves.map((c) => curveGeom(sk, c)).filter(Boolean);
}

export function sampleGeom(g, seg = 64) {
  if (g.type === 'line') return [g.a, g.b];
  if (g.type === 'circle') {
    const out = [];
    for (let i = 0; i <= seg; i++) { const t = (i / seg) * TAU; out.push([g.c[0] + g.r * Math.cos(t), g.c[1] + g.r * Math.sin(t)]); }
    return out;
  }
  if (g.type === 'arc') {
    const n = Math.max(4, Math.ceil((seg * g.sweep) / TAU));
    const out = [];
    for (let i = 0; i <= n; i++) { const t = g.a0 + (g.sweep * i) / n; out.push([g.c[0] + g.r * Math.cos(t), g.c[1] + g.r * Math.sin(t)]); }
    return out;
  }
  if (g.type === 'ellipse') {
    const out = [];
    for (let i = 0; i <= seg; i++) out.push(ellipsePoint(g, (i / seg) * TAU));
    return out;
  }
  if (g.type === 'spline') {
    const out = [];
    g.bez.forEach((b, i) => { for (let k = i ? 1 : 0; k <= 16; k++) out.push(bezPoint(b, k / 16)); });
    return out;
  }
  return [];
}

export function distToSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export function distToGeom(p, g) {
  if (g.type === 'ellipse') { const q = ellipsePoint(g, ellipseClosestT(g, p)); return Math.hypot(p[0] - q[0], p[1] - q[1]); }
  if (g.type === 'circle') return Math.abs(Math.hypot(p[0] - g.c[0], p[1] - g.c[1]) - g.r);
  if (g.type === 'arc') {
    const ang = normAng(Math.atan2(p[1] - g.c[1], p[0] - g.c[0]) - g.a0);
    if (ang <= g.sweep) return Math.abs(Math.hypot(p[0] - g.c[0], p[1] - g.c[1]) - g.r);
    return Math.min(Math.hypot(p[0] - g.pa[0], p[1] - g.pa[1]), Math.hypot(p[0] - g.pb[0], p[1] - g.pb[1]));
  }
  const pts = sampleGeom(g);
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, distToSeg(p, pts[i], pts[i + 1]));
  return d;
}

// Closest point on a curve and its parameter (line: t ∈ [0,1]; circle/arc: absolute angle; ellipse: its parameter).
export function closestOnGeom(p, g) {
  if (g.type === 'ellipse') { const t = ellipseClosestT(g, p); return { p: ellipsePoint(g, t), t }; }
  if (g.type === 'line') {
    const dx = g.b[0] - g.a[0], dy = g.b[1] - g.a[1];
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - g.a[0]) * dx + (p[1] - g.a[1]) * dy) / l2));
    return { p: [g.a[0] + t * dx, g.a[1] + t * dy], t };
  }
  if (g.type === 'circle' || g.type === 'arc') {
    let ang = Math.atan2(p[1] - g.c[1], p[0] - g.c[0]);
    if (g.type === 'arc' && normAng(ang - g.a0) > g.sweep) {
      const da = Math.hypot(p[0] - g.pa[0], p[1] - g.pa[1]), db = Math.hypot(p[0] - g.pb[0], p[1] - g.pb[1]);
      ang = da < db ? g.a0 : g.a0 + g.sweep;
    }
    return { p: [g.c[0] + g.r * Math.cos(ang), g.c[1] + g.r * Math.sin(ang)], t: ang };
  }
  const pts = sampleGeom(g);
  let best = { d: Infinity };
  for (let i = 0; i < pts.length - 1; i++) {
    const q = closestOnGeom(p, { type: 'line', a: pts[i], b: pts[i + 1] }).p;
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < best.d) best = { d, p: q, t: i };
  }
  return best;
}

// ---------- intersections (used by trim and region detection) ----------
const EPS = 1e-9;

function lineLine(a1, a2, b1, b2) {
  const d1x = a2[0] - a1[0], d1y = a2[1] - a1[1], d2x = b2[0] - b1[0], d2y = b2[1] - b1[1];
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < EPS) return [];
  const t = ((b1[0] - a1[0]) * d2y - (b1[1] - a1[1]) * d2x) / den;
  const u = ((b1[0] - a1[0]) * d1y - (b1[1] - a1[1]) * d1x) / den;
  return [{ p: [a1[0] + t * d1x, a1[1] + t * d1y], t, u }];
}

function lineCircle(a, b, c, r) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const fx = a[0] - c[0], fy = a[1] - c[1];
  const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r;
  const disc = B * B - 4 * A * C;
  if (disc < 0 || A < EPS) return [];
  const s = Math.sqrt(Math.max(0, disc));
  const ts = disc < 1e-14 ? [-B / (2 * A)] : [(-B - s) / (2 * A), (-B + s) / (2 * A)];
  return ts.map((t) => { const p = [a[0] + t * dx, a[1] + t * dy]; return { p, t, ang: Math.atan2(p[1] - c[1], p[0] - c[0]) }; });
}

function circleCircle(c1, r1, c2, r2) {
  const dx = c2[0] - c1[0], dy = c2[1] - c1[1];
  const d = Math.hypot(dx, dy);
  if (d < EPS || d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const mx = c1[0] + (a * dx) / d, my = c1[1] + (a * dy) / d;
  const pts = h < 1e-12 ? [[mx, my]] : [[mx + (h * dy) / d, my - (h * dx) / d], [mx - (h * dy) / d, my + (h * dx) / d]];
  return pts.map((p) => ({ p, ang1: Math.atan2(p[1] - c1[1], p[0] - c1[0]), ang2: Math.atan2(p[1] - c2[1], p[0] - c2[0]) }));
}

// a point in an ellipse's unit-circle frame: there the ellipse is the unit circle and the polar angle is its parameter
const unitFrame = (e, p) => { const [x, y] = ellipseLocal(e, p); return [x / e.rx, y / e.ry]; };
const ellParam = (e, p) => { const [x, y] = unitFrame(e, p); return normAng(Math.atan2(y, x)); };

function lineEllipse(a, b, e) {
  // affine maps keep the line parameter, so intersect the mapped line with the unit circle
  return lineCircle(unitFrame(e, a), unitFrame(e, b), [0, 0], 1).map((h) => ({ p: [a[0] + (b[0] - a[0]) * h.t, a[1] + (b[1] - a[1]) * h.t], t: h.t, ang: normAng(h.ang) }));
}
// crossings of an ellipse with a circle, arc or another ellipse: sign changes of the other curve's implicit
// function along the ellipse, refined by bisection (touching without crossing is not reported)
function ellipseCurve(e, g) {
  const f = g.type === 'ellipse' ? (p) => Math.hypot(...unitFrame(g, p)) - 1 : (p) => Math.hypot(p[0] - g.c[0], p[1] - g.c[1]) - g.r;
  const F = (t) => f(ellipsePoint(e, t)), N = 256, out = [];
  let t0 = 0, f0 = F(0);
  for (let i = 1; i <= N; i++) {
    const t1 = (i / N) * TAU, f1 = F(t1);
    if (f0 === 0 || f0 * f1 < 0) {
      let lo = t0, hi = t1, flo = f0;
      for (let k = 0; k < 60 && hi - lo > 1e-15; k++) { const m = (lo + hi) / 2, fm = F(m); if (flo * fm <= 0) hi = m; else { lo = m; flo = fm; } }
      const t = normAng((lo + hi) / 2), p = ellipsePoint(e, t);
      if (!out.some((h) => Math.abs(h.s - t) < 1e-9)) out.push({ p, s: t, t: g.type === 'ellipse' ? ellParam(g, p) : Math.atan2(p[1] - g.c[1], p[0] - g.c[0]) });
    }
    t0 = t1; f0 = f1;
  }
  return out;
}

const onArc = (g, ang, tol = 1e-9) => g.type === 'circle' || normAng(ang - g.a0) <= g.sweep + tol || normAng(ang - g.a0) >= TAU - tol;

/** Intersections between two geometries: [{ p, s, t }] where s/t are params on g1/g2 (line t, circle/arc angle). */
export function intersect(g1, g2, tolT = 1e-9) {
  const L = (g) => g.type === 'line', C = (g) => g.type === 'circle' || g.type === 'arc', E = (g) => g.type === 'ellipse';
  const inLine = (t) => t >= -tolT && t <= 1 + tolT;
  if (L(g1) && E(g2)) return lineEllipse(g1.a, g1.b, g2).filter((h) => inLine(h.t)).map((h) => ({ p: h.p, s: h.t, t: h.ang }));
  if (E(g1) && L(g2)) return intersect(g2, g1, tolT).map((h) => ({ p: h.p, s: h.t, t: h.s }));
  if (E(g1) && (C(g2) || E(g2))) return ellipseCurve(g1, g2).filter((h) => !C(g2) || onArc(g2, h.t));
  if (C(g1) && E(g2)) return intersect(g2, g1, tolT).map((h) => ({ p: h.p, s: h.t, t: h.s }));
  if (L(g1) && L(g2)) return lineLine(g1.a, g1.b, g2.a, g2.b).filter((h) => inLine(h.t) && inLine(h.u)).map((h) => ({ p: h.p, s: h.t, t: h.u }));
  if (L(g1) && C(g2)) return lineCircle(g1.a, g1.b, g2.c, g2.r).filter((h) => inLine(h.t) && onArc(g2, h.ang)).map((h) => ({ p: h.p, s: h.t, t: h.ang }));
  if (C(g1) && L(g2)) return intersect(g2, g1, tolT).map((h) => ({ p: h.p, s: h.t, t: h.s }));
  if (C(g1) && C(g2)) return circleCircle(g1.c, g1.r, g2.c, g2.r).filter((h) => onArc(g1, h.ang1) && onArc(g2, h.ang2)).map((h) => ({ p: h.p, s: h.ang1, t: h.ang2 }));
  return [];
}

// ---------- migration from the v1 entity format ----------
export function migrateSketch(p) {
  if (p.points) return p;
  const sk = emptySketch();
  const pt = (xy) => { const id = uid('p'); sk.points.push({ id, x: xy[0], y: xy[1] }); return id; };
  const line = (a, b, construction) => { const id = uid('c'); sk.curves.push({ id, type: 'line', a, b, ...(construction ? { construction } : {}) }); return id; };
  for (const e of p.entities || []) {
    const cons = !!e.construction;
    if (e.type === 'rect') {
      const ids = [[e.a[0], e.a[1]], [e.b[0], e.a[1]], [e.b[0], e.b[1]], [e.a[0], e.b[1]]].map(pt);
      const ls = ids.map((id, i) => line(id, ids[(i + 1) % 4], cons));
      sk.constraints.push({ id: uid('k'), type: 'horizontal', line: ls[0] }, { id: uid('k'), type: 'horizontal', line: ls[2] }, { id: uid('k'), type: 'vertical', line: ls[1] }, { id: uid('k'), type: 'vertical', line: ls[3] });
    } else if (e.type === 'circle') {
      sk.curves.push({ id: uid('c'), type: 'circle', c: pt(e.c), r: e.r, ...(cons ? { construction: true } : {}) });
    } else if (e.type === 'polygon' || e.type === 'polyline') {
      let pts = e.pts;
      if (e.type === 'polygon') {
        pts = [];
        for (let i = 0; i < e.n; i++) { const t = ((e.rot || 0) * Math.PI) / 180 + (i / e.n) * TAU; pts.push([e.c[0] + e.r * Math.cos(t), e.c[1] + e.r * Math.sin(t)]); }
      }
      const ids = pts.map(pt);
      const closed = e.type === 'polygon' || e.closed;
      for (let i = 0; i < ids.length - (closed ? 0 : 1); i++) line(ids[i], ids[(i + 1) % ids.length], cons);
    } else if (e.type === 'slot') {
      const ang = Math.atan2(e.b[1] - e.a[1], e.b[0] - e.a[0]);
      const nx = -Math.sin(ang) * e.r, ny = Math.cos(ang) * e.r;
      const ca = pt(e.a), cb = pt(e.b);
      const a1 = pt([e.a[0] + nx, e.a[1] + ny]), a2 = pt([e.a[0] - nx, e.a[1] - ny]);
      const b1 = pt([e.b[0] + nx, e.b[1] + ny]), b2 = pt([e.b[0] - nx, e.b[1] - ny]);
      line(a2, b2, cons); line(b1, a1, cons);
      sk.curves.push({ id: uid('c'), type: 'arc', c: cb, a: b2, b: b1 }, { id: uid('c'), type: 'arc', c: ca, a: a1, b: a2 });
    } else if (e.type === 'spline') {
      sk.curves.push({ id: uid('c'), type: 'spline', pts: e.pts.map(pt), closed: !!e.closed });
    }
  }
  return { ...p, ...sk, entities: undefined };
}
