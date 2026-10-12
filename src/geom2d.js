// 2D sketch geometry helpers shared by the UI (preview/region shading) and the CAD worker.
// Sketch entities live in the sketch plane's local (u, v) coordinates, in millimetres.

export const CLOSED_TYPES = new Set(['rect', 'circle', 'polygon', 'slot', 'polyline', 'spline']);

export function isClosed(e) {
  if (e.construction) return false;
  if (e.type === 'polyline' || e.type === 'spline') return !!e.closed && e.pts.length >= 3;
  return CLOSED_TYPES.has(e.type);
}

export function rectCorners(e) {
  const [x0, y0] = e.a, [x1, y1] = e.b;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

export function polygonVerts(e) {
  const out = [];
  const rot = ((e.rot || 0) * Math.PI) / 180;
  for (let i = 0; i < e.n; i++) {
    const t = rot + (i / e.n) * Math.PI * 2;
    out.push([e.c[0] + e.r * Math.cos(t), e.c[1] + e.r * Math.sin(t)]);
  }
  return out;
}

function arcPts(c, r, a0, a1, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = a0 + ((a1 - a0) * i) / n;
    out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
  }
  return out;
}

export function slotOutline(e, seg = 24) {
  const [ax, ay] = e.a, [bx, by] = e.b;
  const ang = Math.atan2(by - ay, bx - ax);
  return [
    ...arcPts(e.b, e.r, ang - Math.PI / 2, ang + Math.PI / 2, seg),
    ...arcPts(e.a, e.r, ang + Math.PI / 2, ang + (3 * Math.PI) / 2, seg),
  ];
}

// Centripetal-ish Catmull-Rom sampling used to preview splines.
export function splinePts(pts, closed, perSeg = 16) {
  if (pts.length < 2) return pts.slice();
  const n = pts.length;
  const get = (i) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  const out = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    for (let k = 0; k < perSeg; k++) {
      const t = k / perSeg, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  if (!closed) out.push(pts[n - 1]);
  return out;
}

// Points along the entity outline (closed entities return a ring without repeating the first point).
export function outline(e) {
  switch (e.type) {
    case 'rect': return rectCorners(e);
    case 'circle': return arcPts(e.c, e.r, 0, Math.PI * 2, 72).slice(0, -1);
    case 'polygon': return polygonVerts(e);
    case 'slot': return slotOutline(e);
    case 'polyline': return e.pts.slice();
    case 'spline': return splinePts(e.pts, !!e.closed);
    case 'point': return [e.p];
    default: return [];
  }
}

export function polyArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return a / 2;
}

export function pointInPoly(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Returns closed profiles with their nesting depth: even depth = material, odd depth = hole.
export function profiles(entities) {
  const list = entities
    .map((e, idx) => ({ e, idx }))
    .filter(({ e }) => isClosed(e))
    .map(({ e, idx }) => {
      const ring = outline(e);
      return { e, idx, ring, area: Math.abs(polyArea(ring)) };
    });
  for (const p of list) {
    // test a point slightly inside the ring's first vertex to avoid boundary ambiguity
    const probe = interiorProbe(p.ring);
    p.depth = list.filter((q) => q !== p && q.area > p.area && pointInPoly(probe, q.ring)).length;
  }
  return list;
}

function interiorProbe(ring) {
  // centroid works for convex shapes; otherwise nudge the midpoint of the first edge inward
  let cx = 0, cy = 0;
  for (const [x, y] of ring) { cx += x; cy += y; }
  cx /= ring.length; cy /= ring.length;
  if (pointInPoly([cx, cy], ring)) return [cx, cy];
  const [a, b] = [ring[0], ring[1]];
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const s = polyArea(ring) > 0 ? 1 : -1;
  return [mx - (dy / len) * 1e-3 * s, my + (dx / len) * 1e-3 * s];
}

export function dist2(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

export function distToSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export function distToEntity(p, e) {
  if (e.type === 'circle') return Math.abs(dist2(p, e.c) - e.r);
  if (e.type === 'point') return dist2(p, e.p);
  const ring = outline(e);
  const closed = e.type === 'polyline' || e.type === 'spline' ? e.closed : true;
  let d = Infinity;
  for (let i = 0; i < ring.length - 1; i++) d = Math.min(d, distToSeg(p, ring[i], ring[i + 1]));
  if (closed && ring.length > 2) d = Math.min(d, distToSeg(p, ring[ring.length - 1], ring[0]));
  return d;
}

// Key points used for snapping (endpoints, centres, midpoints).
export function snapPoints(e) {
  switch (e.type) {
    case 'rect': {
      const c = rectCorners(e);
      return [...c, [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2]];
    }
    case 'circle': return [e.c, [e.c[0] + e.r, e.c[1]], [e.c[0] - e.r, e.c[1]], [e.c[0], e.c[1] + e.r], [e.c[0], e.c[1] - e.r]];
    case 'polygon': return [e.c, ...polygonVerts(e)];
    case 'slot': return [e.a, e.b];
    case 'polyline': {
      const mids = [];
      for (let i = 0; i < e.pts.length - 1; i++) mids.push([(e.pts[i][0] + e.pts[i + 1][0]) / 2, (e.pts[i][1] + e.pts[i + 1][1]) / 2]);
      return [...e.pts, ...mids];
    }
    case 'spline': return e.pts.slice();
    case 'point': return [e.p];
    default: return [];
  }
}

// Plane helpers: plane = { origin:[x,y,z], xDir:[x,y,z], normal:[x,y,z] }
export function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function yDirOf(plane) { return cross(plane.normal, plane.xDir); }
export function toWorld(plane, [u, v], w = 0) {
  const y = yDirOf(plane), o = plane.origin, x = plane.xDir, n = plane.normal;
  return [o[0] + u * x[0] + v * y[0] + w * n[0], o[1] + u * x[1] + v * y[1] + w * n[1], o[2] + u * x[2] + v * y[2] + w * n[2]];
}

export const STD_PLANES = {
  XY: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] },
  XZ: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] },
  YZ: { origin: [0, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] },
};

const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const round9 = (v) => v.map((c) => Math.round(c * 1e9) / 1e9);

// Plane through a point with a normal. The origin is the projection of the world origin onto the
// plane and the X direction follows world axes, so sketches on faces get predictable coordinates.
export function planeFromPointNormal(p, n) {
  n = norm3(n);
  const d = p[0] * n[0] + p[1] * n[1] + p[2] * n[2];
  const origin = [n[0] * d, n[1] * d, n[2] * d];
  let x = Math.abs(n[2]) > 0.9 ? [1, 0, 0] : cross([0, 0, 1], n);
  const k = x[0] * n[0] + x[1] * n[1] + x[2] * n[2];
  x = norm3([x[0] - n[0] * k, x[1] - n[1] * k, x[2] - n[2] * k]);
  return { origin: round9(origin), xDir: round9(x), normal: round9(n) };
}

// Rotates vector v about unit axis k by angle (radians) - Rodrigues' formula.
export function rotateVec(v, k, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const kv = cross(k, v), kd = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  return [0, 1, 2].map((i) => v[i] * c + kv[i] * s + k[i] * kd * (1 - c));
}
