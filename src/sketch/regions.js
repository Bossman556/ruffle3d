// Planar region detection for sketches.
// 1. Planarize: split lines/arcs/circles at all mutual intersections and T-junctions.
// 2. Build a half-edge graph and walk faces (always turning to the next clockwise edge).
// 3. Bounded faces (positive area) are regions; each connected component's outer boundary becomes a
//    hole of the smallest region of another component that contains it. Nesting depth gives the
//    default "even-odd" profile selection.
import { intersect, closestOnGeom, distToGeom, bezPoint, normAng, ellipsePoint } from './model.js';

const TAU = Math.PI * 2;

function pieceFrom(piece) {
  if (piece.type === 'line') return piece.a;
  if (piece.type === 'arc') return [piece.c[0] + piece.r * Math.cos(piece.s), piece.c[1] + piece.r * Math.sin(piece.s)];
  if (piece.type === 'ell') return ellipsePoint(piece, piece.s);
  return piece.b[0];
}
function pieceTo(piece) {
  if (piece.type === 'line') return piece.b;
  if (piece.type === 'arc') { const e = piece.s + piece.sw; return [piece.c[0] + piece.r * Math.cos(e), piece.c[1] + piece.r * Math.sin(e)]; }
  if (piece.type === 'ell') return ellipsePoint(piece, piece.s + piece.sw);
  return piece.b[3];
}
export function pieceAt(piece, t) {
  if (piece.type === 'line') return [piece.a[0] + (piece.b[0] - piece.a[0]) * t, piece.a[1] + (piece.b[1] - piece.a[1]) * t];
  if (piece.type === 'arc') { const a = piece.s + piece.sw * t; return [piece.c[0] + piece.r * Math.cos(a), piece.c[1] + piece.r * Math.sin(a)]; }
  if (piece.type === 'ell') return ellipsePoint(piece, piece.s + piece.sw * t);
  return bezPoint(piece.b, t);
}
export function reversePiece(p) {
  if (p.type === 'line') return { type: 'line', a: p.b, b: p.a };
  if (p.type === 'arc') return { type: 'arc', c: p.c, r: p.r, s: p.s + p.sw, sw: -p.sw };
  if (p.type === 'ell') return { ...p, s: p.s + p.sw, sw: -p.sw };
  return { type: 'bez', b: [p.b[3], p.b[2], p.b[1], p.b[0]] };
}
function samplePiece(p, n) {
  const k = p.type === 'line' ? 1 : n ?? (p.type === 'ell' ? 48 : Math.max(4, Math.ceil(Math.abs(p.sw || 1) * 12)));
  const out = [];
  for (let i = 0; i <= k; i++) out.push(pieceAt(p, i / k));
  return out;
}

export function polyArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return -a / 2;
}
export function pointInPoly(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** geoms: output of sketchGeom (construction curves are ignored). */
export function computeRegions(geoms) {
  const gs = geoms.filter((g) => !g.construction);
  if (!gs.length) return [];
  // scale-aware tolerance
  let ext = 1;
  for (const g of gs) for (const p of g.type === 'line' ? [g.a, g.b] : g.type === 'spline' ? g.pts : [g.c]) ext = Math.max(ext, Math.abs(p[0]), Math.abs(p[1]), g.r || g.rx || 0);
  const tol = ext * 1e-7 + 1e-9;

  // ---- split parameters per splittable curve ----
  const splittable = gs.filter((g) => g.type !== 'spline');
  const params = new Map(splittable.map((g) => [g, []]));
  const paramOf = (g, raw) => (g.type === 'line' ? raw : g.type === 'arc' ? Math.min(g.sweep, Math.max(0, normAng(raw - g.a0))) : normAng(raw));
  for (let i = 0; i < splittable.length; i++) {
    for (let j = i + 1; j < splittable.length; j++) {
      const g1 = splittable[i], g2 = splittable[j];
      for (const h of intersect(g1, g2, 1e-7)) {
        params.get(g1).push(paramOf(g1, h.s));
        params.get(g2).push(paramOf(g2, h.t));
      }
    }
  }
  // T-junctions: endpoints of any curve touching the interior of a splittable curve
  const endpoints = [];
  for (const g of gs) {
    if (g.type === 'line') endpoints.push(g.a, g.b);
    else if (g.type === 'arc') endpoints.push(g.pa, g.pb);
    else if (g.type === 'spline' && !g.closed) endpoints.push(g.pts[0], g.pts[g.pts.length - 1]);
  }
  for (const g of splittable) {
    for (const e of endpoints) {
      if (distToGeom(e, g) < tol * 10) params.get(g).push(paramOf(g, closestOnGeom(e, g).t));
    }
  }

  // ---- pieces ----
  const pieces = [];
  for (const g of splittable) {
    const raw = params.get(g);
    if (g.type === 'ellipse') {
      // split at every crossing, and at least at the quarters (the kernel draws elliptical arcs under half a turn)
      const ts = [...new Set([0, TAU, Math.PI / 2, Math.PI, (3 * Math.PI) / 2, ...raw])].filter((t) => t >= 0 && t <= TAU).sort((a, b) => a - b);
      for (let i = 0; i < ts.length - 1; i++) if (ts[i + 1] - ts[i] > 1e-9) pieces.push({ type: 'ell', c: g.c, rx: g.rx, ry: g.ry, rot: g.rot, s: ts[i], sw: ts[i + 1] - ts[i] });
    } else if (g.type === 'line') {
      const ts = [...new Set([0, 1, ...raw].map((t) => Math.max(0, Math.min(1, t))))].sort((a, b) => a - b);
      for (let i = 0; i < ts.length - 1; i++) {
        if (ts[i + 1] - ts[i] < 1e-9) continue;
        const a = [g.a[0] + (g.b[0] - g.a[0]) * ts[i], g.a[1] + (g.b[1] - g.a[1]) * ts[i]];
        const b = [g.a[0] + (g.b[0] - g.a[0]) * ts[i + 1], g.a[1] + (g.b[1] - g.a[1]) * ts[i + 1]];
        pieces.push({ type: 'line', a, b });
      }
    } else {
      const full = g.type === 'circle';
      const base = full ? 0 : g.a0;
      const total = full ? TAU : g.sweep;
      const ts = [...new Set([0, total, ...(full ? [Math.PI] : []), ...raw])].filter((t) => t >= 0 && t <= total).sort((a, b) => a - b);
      for (let i = 0; i < ts.length - 1; i++) {
        if (ts[i + 1] - ts[i] < 1e-9) continue;
        pieces.push({ type: 'arc', c: g.c, r: g.r, s: base + ts[i], sw: ts[i + 1] - ts[i] });
      }
    }
  }
  for (const g of gs.filter((x) => x.type === 'spline')) {
    if (!g.closed) pieces.push(...g.bez.map((b) => ({ type: 'bez', b })));
    else g.bez.forEach((b) => pieces.push({ type: 'bez', b }));
  }

  // ---- vertices ----
  const verts = [];
  const vid = (p) => {
    for (let i = 0; i < verts.length; i++) if (Math.abs(verts[i][0] - p[0]) < tol * 100 && Math.abs(verts[i][1] - p[1]) < tol * 100) return i;
    verts.push(p);
    return verts.length - 1;
  };
  const edges = [];
  for (const pc of pieces) {
    const u = vid(pieceFrom(pc)), v = vid(pieceTo(pc));
    if (u === v && pc.type === 'line') continue;
    edges.push({ u, v, pc, alive: true });
  }
  // prune dangling edges
  for (let changed = true; changed;) {
    changed = false;
    const deg = new Array(verts.length).fill(0);
    for (const e of edges) if (e.alive) { deg[e.u]++; deg[e.v]++; }
    for (const e of edges) if (e.alive && (deg[e.u] < 2 || deg[e.v] < 2)) { e.alive = false; changed = true; }
  }
  const live = edges.filter((e) => e.alive);
  if (!live.length) return [];

  // ---- half edges ----
  const half = [];
  const out = verts.map(() => []);
  live.forEach((e, i) => {
    const fwd = { from: e.u, to: e.v, pc: e.pc, edge: i };
    const rev = { from: e.v, to: e.u, pc: reversePiece(e.pc), edge: i };
    fwd.twin = rev; rev.twin = fwd;
    for (const h of [fwd, rev]) {
      const p0 = verts[h.from], q = pieceAt(h.pc, 0.02);
      h.ang = Math.atan2(q[1] - p0[1], q[0] - p0[0]);
      half.push(h);
      out[h.from].push(h);
    }
  });
  for (const list of out) list.sort((a, b) => a.ang - b.ang);
  const loops = [];
  const seen = new Set();
  for (const h0 of half) {
    if (seen.has(h0)) continue;
    const loop = [];
    let h = h0;
    for (let guard = 0; guard < half.length + 2 && !seen.has(h); guard++) {
      seen.add(h);
      loop.push(h);
      const list = out[h.to];
      const k = list.indexOf(h.twin);
      h = list[(k - 1 + list.length) % list.length];
    }
    const poly = [];
    for (const he of loop) poly.push(...samplePiece(he.pc).slice(0, -1));
    loops.push({ halves: loop, poly, area: polyArea(poly) });
  }

  // ---- components ----
  const parent = verts.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (const e of live) parent[find(e.u)] = find(e.v);
  const compOf = (loop) => find(loop.halves[0].from);
  const faces = loops.filter((l) => l.area > tol);
  const outers = new Map();
  for (const l of loops) {
    if (l.area > tol) continue;
    const c = compOf(l);
    if (!outers.has(c) || l.area < outers.get(c).area) outers.set(c, l);
  }

  // ---- nesting ----
  const parentFace = new Map(); // component -> face
  for (const [c, outer] of outers) {
    const probe = outer.poly[0];
    let best = null;
    for (const f of faces) {
      if (compOf(f) === c) continue;
      if (pointInPoly(probe, f.poly) && (!best || f.area < best.area)) best = f;
    }
    if (best) parentFace.set(c, best);
  }
  const depthMemo = new Map();
  const depthOfComp = (c, guard = 0) => {
    if (depthMemo.has(c)) return depthMemo.get(c);
    const pf = parentFace.get(c);
    const d = pf && guard < 50 ? depthOfComp(compOf(pf), guard + 1) + 1 : 0;
    depthMemo.set(c, d);
    return d;
  };

  const regions = faces.map((f) => {
    const holes = [];
    for (const [c, pf] of parentFace) if (pf === f) holes.push(outers.get(c));
    return {
      pieces: f.halves.map((h) => h.pc),
      poly: f.poly,
      holes: holes.map((h) => ({ pieces: h.halves.map((x) => x.pc), poly: h.poly })),
      depth: depthOfComp(compOf(f)),
      area: f.area - holes.reduce((s, h) => s + Math.abs(h.area), 0),
    };
  });
  for (const r of regions) r.sample = interiorPoint(r);
  return regions;
}

export function inRegion(p, r) {
  return pointInPoly(p, r.poly) && !r.holes.some((h) => pointInPoly(p, h.poly));
}

function interiorPoint(r) {
  let cx = 0, cy = 0;
  for (const [x, y] of r.poly) { cx += x; cy += y; }
  cx /= r.poly.length; cy /= r.poly.length;
  if (inRegion([cx, cy], r)) return [cx, cy];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of r.poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  for (let n = 4; n <= 64; n *= 2) {
    for (let i = 1; i < n; i++) for (let j = 1; j < n; j++) {
      const p = [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * j) / n];
      if (inRegion(p, r)) return p;
    }
  }
  return r.poly[0];
}

/** Regions picked by sample points, or the default even-depth set when none are given. */
export function selectRegions(regions, pts) {
  if (!pts || !pts.length) return regions.filter((r) => r.depth % 2 === 0);
  const sel = new Set();
  for (const p of pts) {
    // the smallest region containing the point (regions of nested components overlap their parents' holes)
    let best = null;
    for (const r of regions) if (inRegion(p, r) && (!best || r.area < best.area)) best = r;
    if (best) sel.add(best);
  }
  return [...sel];
}
