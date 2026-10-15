// Parametric rebuild engine on top of replicad / OpenCascade.
// Features are replayed in order; the state after each feature is cached by a cumulative hash,
// so editing feature N only recomputes features N..end.
import {
  draw, drawCircle, Plane, Vector,
  makeBaseBox, makeCylinder, makeSphere, makeVertex, makeCompound,
  measureDistanceBetween, measureVolume, measureArea, measureShapeVolumeProperties,
  exportSTEP, importSTEP, importSTL, genericSweep, basicFaceExtrusion, drawProjection, ProjectionCamera,
  getOC, cast, downcast, loft, makeAx1, weldShellsAndFaces, Shell, Edge, Face, assembleWire, makeHelix, makePolygon, makeBox, Wire,
} from 'replicad';
import { yDirOf, STD_PLANES, planeFromPointNormal, rotateVec, cross } from '../geom2d.js';
import { migrateSketch, sketchGeom } from '../sketch/model.js';
import { solveSketch } from '../sketch/solver.js';
import { computeRegions, selectRegions, pieceAt, reversePiece } from '../sketch/regions.js';
import { writeDXF } from '../dxf.js';
import { textSolid, fontLoaded } from './text.js';
export { writeDXF };

const AXES = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => mul(a, 1 / (len(a) || 1));
const neg = (a) => mul(a, -1);
const vxyz = (v) => [v.x, v.y, v.z];
const RAD = 180 / Math.PI;
const errMsg = (e) => {
  if (e && e.message && !(typeof WebAssembly !== 'undefined' && WebAssembly.Exception && e instanceof WebAssembly.Exception)) return e.message;
  if (typeof e === 'number' || typeof e === 'object') return 'Geometry kernel error (the operation is not possible with these inputs)';
  return String(e);
};

function hashStr(str, h = 2166136261) {
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ---------- sketch regions → replicad drawings ----------
function loopDrawing(pieces) {
  const start = pieceAt(pieces[0], 0);
  let pen = draw(start);
  pieces.forEach((pc, i) => {
    const end = i === pieces.length - 1 ? start : pieceAt(pc, 1);
    if (pc.type === 'line') pen = pen.lineTo(end);
    else if (pc.type === 'arc') pen = pen.threePointsArcTo(end, pieceAt(pc, 0.5));
    else pen = pen.cubicBezierCurveTo(end, pc.b[1], pc.b[2]);
  });
  return pen.close();
}

function regionDrawing(r) {
  let d = loopDrawing(r.pieces);
  for (const h of r.holes) d = d.cut(loopDrawing(h.pieces));
  return d;
}

function pickRegions(sk, pts) {
  const regs = selectRegions(sk.regions, pts);
  if (!regs.length) throw new Error(sk.regions.length ? 'No profile selected' : 'Sketch has no closed profiles');
  return regs;
}

function profileDrawing(sk, pts) {
  let d = null;
  for (const r of pickRegions(sk, pts)) d = d ? d.fuse(regionDrawing(r)) : regionDrawing(r);
  return d;
}

const mkPlane = (pl) => new Plane(pl.origin, pl.xDir, pl.normal);
const toSketch = (sk, pts) => profileDrawing(sk, pts).sketchOnPlane(mkPlane(sk.plane));
const largestRegion = (sk, pts) => pickRegions(sk, pts).sort((a, b) => b.area - a.area)[0];

// Orders the open curves of a sketch into a single path wire (for sweeps).
// The path of a sketch as one 2D polyline in order (lines exact; arcs, circles and splines sampled),
// with cumulative lengths. Used to place instances along a path.
// a sketch curve as a 2D polyline (lines exact; arcs, circles and splines finely sampled)
function sampleSketchCurve(g) {
  if (g.type === 'line') return [g.a, g.b];
  if (g.type === 'circle') return Array.from({ length: 257 }, (_, i) => [g.c[0] + g.r * Math.cos((i / 256) * 2 * Math.PI), g.c[1] + g.r * Math.sin((i / 256) * 2 * Math.PI)]);
  if (g.type === 'arc') { const n = Math.max(8, Math.ceil(g.sweep / 0.02)); return Array.from({ length: n + 1 }, (_, i) => { const t = g.a0 + (g.sweep * i) / n; return [g.c[0] + g.r * Math.cos(t), g.c[1] + g.r * Math.sin(t)]; }); }
  const out = [];
  g.bez.forEach((b, j) => { for (let k = j ? 1 : 0; k <= 48; k++) { const t = k / 48, u = 1 - t; out.push([0, 1].map((d) => u * u * u * b[0][d] + 3 * u * u * t * b[1][d] + 3 * u * t * t * b[2][d] + t * t * t * b[3][d])); } });
  return out;
}

function pathPolyline(sk) {
  const gs = sk.geom.filter((g) => !g.construction);
  if (!gs.length) throw new Error('Path sketch is empty');
  const sample = sampleSketchCurve;
  let pts;
  if (gs.length === 1) pts = sample(gs[0]);
  else {
    const same = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6;
    const remaining = gs.map(sample);
    const all = remaining.flatMap((q) => [q[0], q[q.length - 1]]);
    let cur = all.find((p) => all.filter((q) => same(p, q)).length === 1) || all[0];
    pts = [cur];
    while (remaining.length) {
      const i = remaining.findIndex((q) => same(q[0], cur) || same(q[q.length - 1], cur));
      if (i < 0) throw new Error('Path curves must be connected end to end');
      let q = remaining.splice(i, 1)[0];
      if (!same(q[0], cur)) q = q.slice().reverse();
      pts.push(...q.slice(1));
      cur = q[q.length - 1];
    }
  }
  const len = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const closed = Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-6;
  // point and direction (angle in the sketch plane) at arc length s
  const at = (s) => {
    s = Math.max(0, Math.min(len[len.length - 1], s));
    let i = 1;
    while (i < len.length - 1 && len[i] < s) i++;
    const t = len[i] > len[i - 1] ? (s - len[i - 1]) / (len[i] - len[i - 1]) : 0;
    const a = pts[i - 1], b = pts[i];
    return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], ang: Math.atan2(b[1] - a[1], b[0] - a[0]) };
  };
  return { pts, len: len[len.length - 1], closed, at };
}

function pathWire(sk) {
  const gs = sk.geom.filter((g) => !g.construction);
  if (!gs.length) throw new Error('Path sketch is empty');
  if (gs.length === 1 && gs[0].type === 'circle') {
    const g = gs[0];
    return drawCircle(g.r).translate(g.c[0], g.c[1]).sketchOnPlane(mkPlane(sk.plane)).wire;
  }
  const ends = (g) => (g.type === 'line' ? [g.a, g.b] : g.type === 'arc' ? [g.pa, g.pb] : [g.pts[0], g.closed ? g.pts[0] : g.pts[g.pts.length - 1]]);
  const same = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6;
  const remaining = gs.filter((g) => g.type !== 'circle');
  // start at an end point used by only one curve (open path) or anywhere (closed path)
  const all = remaining.flatMap(ends);
  let start = all.find((p) => all.filter((q) => same(p, q)).length === 1) || all[0];
  let pen = draw(start);
  let cur = start;
  let closed = false;
  while (remaining.length) {
    const i = remaining.findIndex((g) => ends(g).some((p) => same(p, cur)));
    if (i < 0) throw new Error('Path curves must be connected end to end');
    const g = remaining.splice(i, 1)[0];
    const [a, b] = ends(g);
    const fwd = same(a, cur);
    const end = fwd ? b : a;
    if (g.type === 'line') pen = pen.lineTo(end);
    else if (g.type === 'arc') {
      const m = g.a0 + g.sweep / 2;
      pen = pen.threePointsArcTo(end, [g.c[0] + g.r * Math.cos(m), g.c[1] + g.r * Math.sin(m)]);
    } else {
      const segs = fwd ? g.bez : g.bez.slice().reverse().map((s) => [s[3], s[2], s[1], s[0]]);
      for (const s of segs) pen = pen.cubicBezierCurveTo(s[3], s[1], s[2]);
    }
    cur = end;
    if (same(cur, start) && !remaining.length) closed = true;
  }
  return (closed ? pen.close() : pen.done()).sketchOnPlane(mkPlane(sk.plane)).wire;
}

// Splits the curves of a sketch into connected chains, one wire per chain (open or closed).
function chainWires(sk) {
  const gs = sk.geom.filter((g) => !g.construction && g.type !== 'point');
  if (!gs.length) throw new Error('The curve sketch is empty');
  const wires = [];
  const ends = (g) => (g.type === 'line' ? [g.a, g.b] : g.type === 'arc' ? [g.pa, g.pb] : [g.pts[0], g.closed ? g.pts[0] : g.pts[g.pts.length - 1]]);
  const same = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6;
  const remaining = [];
  for (const g of gs) {
    if (g.type === 'circle') wires.push(drawCircle(g.r).translate(g.c[0], g.c[1]).sketchOnPlane(mkPlane(sk.plane)).wire);
    else remaining.push(g);
  }
  while (remaining.length) {
    const all = remaining.flatMap(ends);
    const start = all.find((p) => all.filter((q) => same(p, q)).length === 1) || all[0];
    let pen = draw(start), cur = start, closed = false;
    for (;;) {
      const i = remaining.findIndex((g) => ends(g).some((p) => same(p, cur)));
      if (i < 0) break;
      const g = remaining.splice(i, 1)[0];
      const [a, b] = ends(g);
      const fwd = same(a, cur);
      const end = fwd ? b : a;
      if (g.type === 'line') pen = pen.lineTo(end);
      else if (g.type === 'arc') {
        const m = g.a0 + g.sweep / 2;
        pen = pen.threePointsArcTo(end, [g.c[0] + g.r * Math.cos(m), g.c[1] + g.r * Math.sin(m)]);
      } else {
        const segs = fwd ? g.bez : g.bez.slice().reverse().map((q) => [q[3], q[2], q[1], q[0]]);
        for (const q of segs) pen = pen.cubicBezierCurveTo(q[3], q[1], q[2]);
      }
      cur = end;
      if (same(cur, start)) { closed = true; break; }
    }
    wires.push((closed ? pen.close() : pen.done()).sketchOnPlane(mkPlane(sk.plane)).wire);
  }
  return wires;
}
// A curve input is either a sketch (planar curves) or a 3D CV curve feature.
function curveSource(st, id, what) {
  const c = st.curves.get(id);
  if (c) return { wires: [c.wire.clone()], plane: c.plane };
  const sk = getSketch(st, id, what);
  return { wires: chainWires(sk), plane: sk.plane };
}
function railWire(st, id) {
  const c = st.curves.get(id);
  return c ? c.wire.clone() : pathWire(getSketch(st, id, 'rail'));
}
const singleWire = (st, id, what) => {
  const ws = curveSource(st, id, what).wires;
  if (ws.length !== 1) throw new Error(`Each ${what} sketch must be one connected curve (found ${ws.length})`);
  return ws[0];
};

// True if the shape contains at least one solid (otherwise it is a surface / open shell).
export function hasSolid(shape) {
  const oc = getOC();
  const ex = new oc.TopExp_Explorer(shape.wrapped, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  const r = ex.More();
  ex.delete();
  return r;
}
// Solids with inward-facing orientation report negative volume; flip them.
const outward = (s) => { try { return measureVolume(s) < 0 ? cast(s.wrapped.Reversed()) : s; } catch { return s; } };
const shapeOf = (builder) => { const s = cast(downcast(builder.Shape())); builder.delete(); return s; };
const joinSurfaces = (shapes) => (shapes.length === 1 ? shapes[0] : weldShellsAndFaces(shapes, true));

// ---------- thread helpers ----------
// ISO 261 / 262 coarse-pitch metric threads.
const ISO_PITCH = { M2: 0.4, 'M2.5': 0.45, M3: 0.5, M4: 0.7, M5: 0.8, M6: 1, M8: 1.25, M10: 1.5, M12: 1.75, M14: 2, M16: 2, M20: 2.5, M24: 3, M30: 3.5 };
const ISO_DIA = Object.fromEntries(Object.keys(ISO_PITCH).map((k) => [k, +k.slice(1)]));
// Cuts a 60° ISO thread groove into a body along a helix: start/axis/r define the cylinder, len its length.
// Long helical sweeps are unreliable in one piece, so the groove is cut in chunks of whole turns that overlap
// by one turn: every chunk starts at the same angular phase and the grooves join seamlessly.
function cutThread(body, { start, axis, r, pitch, len, external, left = false, depth }) {
  const d = depth ?? 0.6134 * pitch, e = 0.15 * pitch, t30 = Math.tan(Math.PI / 6);
  const CH = 8, turns = len / pitch;
  let cut = body;
  for (let k = 0; k * (CH - 1) < turns - 1e-9 || k === 0; k++) {
    const t0 = k * (CH - 1), tl = Math.min(CH, turns - t0);
    if (tl < 1e-6) break;
    const s0 = add(start, mul(axis, t0 * pitch));
    const helix = makeHelix(pitch, tl * pitch, r, s0, axis, left);
    const aux = makeHelix(pitch, tl * pitch, r + Math.max(5, r), s0, axis, left);
    const S = vxyz(helix.startPoint);
    const rh = unit(sub(S, add(s0, mul(axis, dot(sub(S, s0), axis)))));
    const at = (rad, ax) => add(add(s0, mul(rh, rad)), mul(axis, dot(sub(S, s0), axis) + ax));
    const tip = external ? r - d : r + d, base = external ? r + e : r - e;
    const prof = makePolygon([at(tip, 0), at(base, (d + e) * t30), at(base, -(d + e) * t30)]).outerWire();
    cut = cut.cut(genericSweep(prof, helix, { auxiliarySpine: aux }, false));
    if (t0 + tl >= turns - 1e-9) break;
  }
  return cut;
}
// ISO 2306 tap drill for coarse threads ≈ nominal − pitch.
export const tapDrill = (size) => +(ISO_DIA[size] - ISO_PITCH[size]).toFixed(2);

// Axis, radius and axial extent of a cylindrical face.
function cylinderOf(face) {
  const P = [0, 1, 2].map((i) => vxyz(face.pointOnSurface((i + 0.5) / 3, 0.5)));
  const a = sub(P[1], P[0]), c = sub(P[2], P[0]), n = cross(a, c);
  const num = add(mul(cross(n, a), dot(c, c)), mul(cross(c, n), dot(a, a)));
  const center0 = add(P[0], mul(num, 1 / (2 * dot(n, n))));
  const axis = unit(n), radius = len(sub(P[0], center0));
  // axial extent from the face's own vertices / edge samples
  let v0 = Infinity, v1 = -Infinity;
  for (const e of face.edges) for (const t of [0, 0.25, 0.5, 0.75, 1]) { const q = vxyz(e.pointAt(t)); const v = dot(sub(q, center0), axis); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
  return { center: center0, axis, radius, v0, v1 };
}

// ---------- NURBS helpers ----------
function arr1d(vals) { const a = new (getOC().NCollection_Array1_double)(1, vals.length); vals.forEach((v, i) => a.SetValue(i + 1, v)); return a; }
function arr1i(vals) { const a = new (getOC().NCollection_Array1_int)(1, vals.length); vals.forEach((v, i) => a.SetValue(i + 1, v)); return a; }
// Uniform knot vector: clamped (open) or periodic (closed).
export function knotVector(n, deg, periodic = false) {
  const k = [], m = [];
  if (periodic) { for (let i = 0; i <= n; i++) { k.push(i / n); m.push(1); } return { k, m }; }
  const spans = n - deg;
  for (let i = 0; i <= spans; i++) { k.push(i / spans); m.push(i === 0 || i === spans ? deg + 1 : 1); }
  return { k, m };
}
function bsplineEdge(cvs, deg, closed) {
  const oc = getOC();
  const P = new oc.NCollection_Array1_gp_Pnt(1, cvs.length);
  cvs.forEach((c, i) => P.SetValue(i + 1, new oc.gp_Pnt(c[0], c[1], c[2])));
  const { k, m } = knotVector(cvs.length, deg, closed);
  const curve = new oc.Geom_BSplineCurve(P, arr1d(k), arr1i(m), deg, closed);
  const mk = new oc.BRepBuilderAPI_MakeEdge(curve);
  const e = new Edge(mk.Edge());
  mk.delete();
  return e;
}
// Best-fit plane of a point set (Newell normal), used as the "sketch plane" of a 3D curve.
function fitPlane(pts) {
  const c = pts.reduce((a, q) => add(a, q), [0, 0, 0]).map((v) => v / pts.length);
  let nrm = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const a = sub(pts[i], c), b = sub(pts[(i + 1) % pts.length], c);
    nrm = add(nrm, cross(a, b));
  }
  if (len(nrm) < 1e-9) {
    const d = unit(sub(pts[pts.length - 1], pts[0]));
    nrm = Math.abs(d[2]) < 0.9 ? cross(d, cross([0, 0, 1], d)) : [1, 0, 0];
    if (len(nrm) < 1e-9) nrm = [0, 0, 1];
  }
  nrm = unit(nrm);
  if (dot(nrm, [0, 0, 1]) < -1e-9) nrm = neg(nrm);
  let x = sub(pts[pts.length - 1], pts[0]);
  x = sub(x, mul(nrm, dot(x, nrm)));
  if (len(x) < 1e-9) x = Math.abs(nrm[0]) < 0.9 ? cross([1, 0, 0], nrm) : cross([0, 1, 0], nrm);
  return { origin: c, xDir: unit(x), normal: nrm };
}
// CV grid → trimmed-free NURBS face. cv = { nu, nv, du, dv, poles: [[x,y,z]] (i * nv + j), uk?, um?, vk?, vm? }
// Optional: cv.w (weights, rational NURBS) and cv.trims (UV trim loops: [[[u,v]...segment]...loop], first = outer).
function cvSurface(cv) {
  const oc = getOC();
  const { nu, nv } = cv;
  const du = Math.max(1, Math.min(cv.du || 3, nu - 1)), dv = Math.max(1, Math.min(cv.dv || 3, nv - 1));
  const P = new oc.NCollection_Array2_gp_Pnt(1, nu, 1, nv);
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) P.SetValue(i + 1, j + 1, new oc.gp_Pnt(...cv.poles[i * nv + j]));
  const ku = cv.uk ? { k: cv.uk, m: cv.um } : knotVector(nu, du), kv = cv.vk ? { k: cv.vk, m: cv.vm } : knotVector(nv, dv);
  if (cv.w?.length === nu * nv) {
    const W = new oc.NCollection_Array2_double(1, nu, 1, nv);
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) W.SetValue(i + 1, j + 1, cv.w[i * nv + j]);
    return new oc.Geom_BSplineSurface(P, W, arr1d(ku.k), arr1d(kv.k), arr1i(ku.m), arr1i(kv.m), du, dv, false, false);
  }
  return new oc.Geom_BSplineSurface(P, arr1d(ku.k), arr1d(kv.k), arr1i(ku.m), arr1i(kv.m), du, dv, false, false);
}
function curve2d(seg) {
  const oc = getOC();
  const P2 = (q) => new oc.gp_Pnt2d(q[0], q[1]);
  const line = (a, b) => {
    const A = new oc.NCollection_Array1_gp_Pnt2d(1, 2);
    A.SetValue(1, P2(a)); A.SetValue(2, P2(b));
    return new oc.Geom2d_BSplineCurve(A, arr1d([0, 1]), arr1i([2, 2]), 1, false);
  };
  if (seg.t === 'line') return line(seg.a, seg.b);
  if (seg.t === 'arc') {
    // exact rational quadratic NURBS arc, split into ≤ 90° spans
    const n = Math.max(1, Math.ceil(Math.abs(seg.sweep) / (Math.PI / 2) - 1e-9));
    const d = seg.sweep / n, w = Math.cos(d / 2);
    const on = (a, k = 1) => [seg.c[0] + seg.r * k * Math.cos(a), seg.c[1] + seg.r * k * Math.sin(a)];
    const poles = [], weights = [];
    for (let i = 0; i < n; i++) {
      poles.push(on(seg.a0 + i * d), on(seg.a0 + (i + 0.5) * d, 1 / w));
      weights.push(1, w);
    }
    poles.push(on(seg.a0 + seg.sweep)); weights.push(1);
    const A = new oc.NCollection_Array1_gp_Pnt2d(1, poles.length);
    poles.forEach((q, i) => A.SetValue(i + 1, P2(q)));
    const knots = Array.from({ length: n + 1 }, (_, i) => i), mults = knots.map((_, i) => (i === 0 || i === n ? 3 : 2));
    return new oc.Geom2d_BSplineCurve(A, arr1d(weights), arr1d(knots), arr1i(mults), 2, false);
  }
  const pts = Array.isArray(seg) ? seg : seg.pts;
  const collinear = pts.every((q, i) => i < 2 || Math.abs((pts[pts.length - 1][0] - pts[0][0]) * (q[1] - pts[0][1]) - (pts[pts.length - 1][1] - pts[0][1]) * (q[0] - pts[0][0])) < 1e-12);
  if (pts.length === 2 || collinear) return line(pts[0], pts[pts.length - 1]);
  const A = new oc.NCollection_Array1_gp_Pnt2d(1, pts.length);
  pts.forEach((q, i) => A.SetValue(i + 1, P2(q)));
  const ap = new oc.Geom2dAPI_PointsToBSpline(A, 3, 8, oc.GeomAbs_Shape.GeomAbs_C2, 1e-9);
  return ap.Curve();
}
function cvFace(cv) {
  const oc = getOC();
  const surf = cvSurface(cv);
  if (!cv.trims?.length) {
    const mk = new oc.BRepBuilderAPI_MakeFace(surf, 1e-6);
    const face = new Face(mk.Face());
    mk.delete();
    return face;
  }
  // trimmed NURBS: rebuild each loop from its UV segments on the (possibly edited) surface
  const wires = cv.trims.map((loop) => {
    const mw = new oc.BRepBuilderAPI_MakeWire();
    for (const seg of loop) {
      if (Array.isArray(seg) && seg.length < 2) continue;
      const me = new oc.BRepBuilderAPI_MakeEdge(curve2d(seg), surf);
      if (me.IsDone()) mw.Add(me.Edge());
      me.delete();
    }
    const w = mw.Wire();
    oc.BRepLib.BuildCurves3d(w);
    return w;
  });
  const mk = new oc.BRepBuilderAPI_MakeFace(surf, wires[0], true);
  for (const w of wires.slice(1)) mk.Add(w);
  const fix = new oc.ShapeFix_Face(mk.Face());
  fix.Perform();
  const face = new Face(fix.Face());
  mk.delete(); fix.delete();
  return face;
}
// UV trim loops of a face, mapped through uvMap. Each boundary edge becomes one segment:
//   { t: 'line', a, b }               exact straight segment in UV
//   { t: 'arc', c, r, a0, sweep }     exact circular arc in UV (planar faces, where UV is a metric chart)
//   { t: 'pts', pts }                 free-form edge, fitted to 1e-9 in UV
// Corners stay sharp because every edge is its own segment.
function faceTrims(face, uvMap = null) {
  const oc = getOC();
  if (oc.BRep_Tool.NaturalRestriction(face.wrapped)) return null;
  const handle = oc.BRep_Tool.Surface(face.wrapped);
  const map = uvMap || ((u, v) => [u, v]);
  const toUV = (q) => {
    const pr = new oc.GeomAPI_ProjectPointOnSurf(new oc.gp_Pnt(q.x, q.y, q.z), handle);
    const uv = pr.NbPoints() ? pr.LowerDistanceParameters() : null;
    pr.delete();
    return uv ? map(uv.U, uv.V) : null;
  };
  const planar = face.geomType === 'PLANE' && !uvMap;
  const wires = [face.clone().outerWire(), ...face.clone().innerWires()];
  return wires.map((w) => w.edges.map((e) => {
    const rev = e.wrapped.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
    if (e.geomType === 'LINE') {
      const a = toUV(e.startPoint), b = toUV(e.endPoint);
      return a && b ? (rev ? { t: 'line', a: b, b: a } : { t: 'line', a, b }) : null;
    }
    if (planar && e.geomType === 'CIRCLE') {
      const P = [0, 0.25, 0.5, 1].map((t) => toUV(e.pointAt(t)));
      if (P.every(Boolean)) {
        const [p0, pq, pm] = P;
        const c = circumcentre2(p0, pq, pm);
        if (c) {
          const ang = (q) => Math.atan2(q[1] - c[1], q[0] - c[0]);
          const r = Math.hypot(p0[0] - c[0], p0[1] - c[1]);
          const a0 = ang(p0);
          const dirSign = Math.sign(((ang(pq) - a0 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) || 1; // +1 ccw
          const closed = Math.hypot(P[3][0] - p0[0], P[3][1] - p0[1]) < 1e-9 * Math.max(1, r);
          let sweep;
          if (closed) sweep = 2 * Math.PI * dirSign;
          else {
            const ccw = (((ang(P[3]) - a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
            sweep = dirSign > 0 ? ccw : ccw - 2 * Math.PI;
          }
          return rev ? { t: 'arc', c, r, a0: a0 + sweep, sweep: -sweep } : { t: 'arc', c, r, a0, sweep };
        }
      }
    }
    const n = 64, pts = [];
    for (let i = 0; i <= n; i++) { const q = toUV(e.pointAt(i / n)); if (q) pts.push(q); }
    if (rev) pts.reverse();
    return pts.length >= 2 ? { t: 'pts', pts } : null;
  }).filter(Boolean));
}
function circumcentre2(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-14) return null;
  const A = a[0] ** 2 + a[1] ** 2, B = b[0] ** 2 + b[1] ** 2, C = c[0] ** 2 + c[1] ** 2;
  return [(A * (b[1] - c[1]) + B * (c[1] - a[1]) + C * (a[1] - b[1])) / d, (A * (c[0] - b[0]) + B * (a[0] - c[0]) + C * (b[0] - a[0])) / d];
}
// Exact NURBS (poles, weights, knots) of a face; null when the surface has no bounded NURBS form.
function exactFaceCV(face) {
  const oc = getOC();
  const b = oc.BRepTools.UVBounds(face.wrapped, 0, 0, 0, 0);
  const geomSurf = surfOf(face);
  let B;
  if (face.geomType === 'PLANE') {
    const c = [[b.UMin, b.VMin], [b.UMin, b.VMax], [b.UMax, b.VMin], [b.UMax, b.VMax]].map(([u, v]) => v3(geomSurf.Value(u, v)));
    return { nu: 2, nv: 2, du: 1, dv: 1, poles: c, uk: [b.UMin, b.UMax], um: [2, 2], vk: [b.VMin, b.VMax], vm: [2, 2], exact: true, trims: faceTrims(face) };
  }
  try {
    const h = oc.GeomConvert.SurfaceToBSplineSurface(geomSurf);
    B = h.get ? h.get() : h;
  } catch { return null; }
  if (B.IsUPeriodic()) B.SetUNotPeriodic();
  if (B.IsVPeriodic()) B.SetVNotPeriodic();
  const fb = B.Bounds(0, 0, 0, 0);
  if (b.UMin > fb.U1 + 1e-9 || b.UMax < fb.U2 - 1e-9 || b.VMin > fb.V1 + 1e-9 || b.VMax < fb.V2 - 1e-9) {
    try { const h = oc.GeomConvert.SplitBSplineSurface(B, b.UMin, b.UMax, b.VMin, b.VMax, 1e-9, true, true); B = h.get ? h.get() : h; } catch { /* keep the full patch */ }
  }
  const cv = { nu: B.NbUPoles(), nv: B.NbVPoles(), du: B.UDegree(), dv: B.VDegree(), poles: [], uk: [], um: [], vk: [], vm: [], exact: true };
  if (cv.nu * cv.nv > 2500) return null;
  const rational = B.IsURational() || B.IsVRational();
  if (rational) cv.w = [];
  for (let i = 1; i <= cv.nu; i++) for (let j = 1; j <= cv.nv; j++) { const q = B.Pole(i, j); cv.poles.push([q.X(), q.Y(), q.Z()]); if (rational) cv.w.push(B.Weight(i, j)); }
  for (let i = 1; i <= B.NbUKnots(); i++) { cv.uk.push(B.UKnot(i)); cv.um.push(B.UMultiplicity(i)); }
  for (let i = 1; i <= B.NbVKnots(); i++) { cv.vk.push(B.VKnot(i)); cv.vm.push(B.VMultiplicity(i)); }
  cv.trims = faceTrims(face);
  return cv;
}
// Largest distance from points sampled on face a to face b.
function faceDeviation(a, b, n = 9) {
  let worst = 0;
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
    const q = a.pointOnSurface(i / n, j / n);
    const P = [q.x, q.y, q.z], r = projectOn(b, P);
    if (r) worst = Math.max(worst, len(sub(P, r)));
  }
  return worst;
}
function planeCV(pl, w, l, nu, nv, deg) {
  nu = Math.max(2, Math.min(nu | 0 || 4, 40)); nv = Math.max(2, Math.min(nv | 0 || 4, 40));
  if (!(w > 0) || !(l > 0)) throw new Error('Width and length must be positive');
  const y = yDirOf(pl), poles = [];
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const a = (i / (nu - 1) - 0.5) * w, b = (j / (nv - 1) - 0.5) * l;
    poles.push(add(pl.origin, add(mul(pl.xDir, a), mul(y, b))));
  }
  return { nu, nv, du: deg || 3, dv: deg || 3, poles };
}
// B-spline basis values N_i,deg(t) for all i (The NURBS Book, A2.2).
function basisAll(n, deg, U, t) {
  let k = deg;
  while (k < n - 1 && t >= U[k + 1]) k++;
  const Nl = new Array(deg + 1).fill(0), left = [], right = [];
  Nl[0] = 1;
  for (let j = 1; j <= deg; j++) {
    left[j] = t - U[k + 1 - j];
    right[j] = U[k + j] - t;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const den = right[r + 1] + left[j - r];
      const tmp = Math.abs(den) > 1e-14 ? Nl[r] / den : 0;
      Nl[r] = saved + right[r + 1] * tmp;
      saved = left[j - r] * tmp;
    }
    Nl[j] = saved;
  }
  const N = new Array(n).fill(0);
  for (let j = 0; j <= deg; j++) N[k - deg + j] = Nl[j];
  return N;
}
function solveLinear(A, B) {
  // Gaussian elimination with partial pivoting; B is an array of right-hand-side vectors (n × 3)
  const n = A.length, M = A.map((r, i) => [...r, ...B[i]]), w = B[0].length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      if (f) for (let k = c; k < n + w; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r.slice(n).map((v) => v / M[i][i]));
}
// Interpolation poles (clamped uniform knots, n poles) through points sampled at the Greville abscissae.
function interpPoles(samples, deg) {
  const n = samples.length;
  const U = [...Array(deg + 1).fill(0), ...Array.from({ length: n - deg - 1 }, (_, i) => (i + 1) / (n - deg)), ...Array(deg + 1).fill(1)];
  const g = Array.from({ length: n }, (_, i) => { let a = 0; for (let k = 1; k <= deg; k++) a += U[i + k]; return Math.min(a / deg, 1 - 1e-12); });
  return { poles: solveLinear(g.map((t) => basisAll(n, deg, U, t)), samples), params: g };
}
// Rebuilds any face as an editable nu × nv CV surface that interpolates points sampled on it.
function fitFaceCV(face, nu, nv, deg, keepTrims = false) {
  nu = Math.max(4, Math.min(nu | 0 || 6, 40)); nv = Math.max(4, Math.min(nv | 0 || 6, 40));
  const du = Math.min(deg || 3, nu - 1), dv = Math.min(deg || 3, nv - 1);
  const gu = interpPoles(Array.from({ length: nu }, () => [0, 0, 0]), du).params;
  const gv = interpPoles(Array.from({ length: nv }, () => [0, 0, 0]), dv).params;
  // sample grid Q[i][j] at Greville parameters, then interpolate along v (rows) and u (columns)
  const Q = gu.map((u) => gv.map((v) => { const q = face.pointOnSurface(u, v); return [q.x, q.y, q.z]; }));
  const R = Q.map((row) => interpPoles(row, dv).poles);
  const poles = new Array(nu * nv);
  for (let j = 0; j < nv; j++) {
    const col = interpPoles(R.map((row) => row[j]), du).poles;
    for (let i = 0; i < nu; i++) poles[i * nv + j] = col[i];
  }
  const cv = { nu, nv, du, dv, poles };
  if (keepTrims) {
    // the fit is parameterised over the face UV box mapped to [0, 1]²; map the trim loops the same way
    const b = getOC().BRepTools.UVBounds(face.wrapped, 0, 0, 0, 0);
    const tr = faceTrims(face, (u, v) => [(u - b.UMin) / (b.UMax - b.UMin), (v - b.VMin) / (b.VMax - b.VMin)]);
    if (tr) cv.trims = tr;
  }
  return cv;
}
function splitShape(arg, tool) {
  const oc = getOC();
  const sp = new oc.BRepAlgoAPI_Splitter();
  const a = new oc.NCollection_List_TopoDS_Shape(); a.Append(arg.wrapped);
  const t = new oc.NCollection_List_TopoDS_Shape(); t.Append(tool.wrapped);
  sp.SetArguments(a); sp.SetTools(t); sp.Build();
  const r = cast(downcast(sp.Shape()));
  sp.delete(); a.delete(); t.delete();
  return r;
}
function sew(shapes, tol) {
  const oc = getOC();
  const sw = new oc.BRepBuilderAPI_Sewing(tol, true, true, true, false);
  for (const x of shapes) sw.Add(x.wrapped);
  sw.Perform();
  const shape = cast(downcast(sw.SewedShape()));
  const gaps = !(shape instanceof Shell) && !(shape instanceof Face) && shapes.length > 1;
  sw.delete();
  return { shape, gaps };
}
const projectOn = (face, P) => {
  const oc = getOC();
  const pr = new oc.GeomAPI_ProjectPointOnSurf(new oc.gp_Pnt(P[0], P[1], P[2]), oc.BRep_Tool.Surface(face.wrapped));
  if (!pr.NbPoints()) { pr.delete(); return null; }
  const q = pr.NearestPoint();
  const r = [q.X(), q.Y(), q.Z()];
  pr.delete();
  return r;
};
// Interpolating NURBS face through a grid of points (rows × cols).
function gridFace(rows) {
  const oc = getOC();
  const A = new oc.NCollection_Array2_gp_Pnt(1, rows.length, 1, rows[0].length);
  rows.forEach((r, i) => r.forEach((q, j) => A.SetValue(i + 1, j + 1, new oc.gp_Pnt(q[0], q[1], q[2]))));
  const ap = new oc.GeomAPI_PointsToBSplineSurface(A, 3, 8, oc.GeomAbs_Shape.GeomAbs_C2, 1e-4);
  const mk = new oc.BRepBuilderAPI_MakeFace(ap.Surface(), 1e-6);
  const f = new Face(mk.Face());
  mk.delete(); ap.delete();
  return f;
}
function offsetFace(face, d) {
  const mk = new (getOC().BRepOffsetAPI_MakeOffsetShape)();
  mk.PerformBySimple(face.wrapped, d);
  return shapeOf(mk);
}
// Rolling-ball fillet between two faces: offsets meet at the ball-centre spine, circular arcs
// span the contact points, and both faces are trimmed along their contact curves.
// pA / pB are points on the parts of each face to keep.
// Ball centre at distance r from both faces, refined from a starting guess (2×2 Newton step on the contact distances).
function ballCentre(fa, fb, S, r) {
  for (let k = 0; k < 12; k++) {
    const a = projectOn(fa, S), b = projectOn(fb, S);
    if (!a || !b) return S;
    const va = sub(S, a), vb = sub(S, b), da = len(va), db = len(vb);
    const ea = r - da, eb = r - db;
    if (Math.abs(ea) < 1e-7 && Math.abs(eb) < 1e-7) break;
    const ua = unit(va), ub = unit(vb), c = dot(ua, ub), den = Math.max(1 - c * c, 1e-6);
    S = add(S, add(mul(ua, (ea - c * eb) / den), mul(ub, (eb - c * ea) / den)));
  }
  return S;
}

// Size law along the spine: { r0, r1, rm, shape: 'linear' | 'smooth' | 'mid', flip, chord }.
// shape 'mid' passes through rm at the middle; with chord = true the sizes are chord lengths between the
// two contact curves instead of radii.
export function sizeLaw({ r0, r1, rm = (r0 + r1) / 2, shape = 'linear', flip = false }) {
  return (t) => {
    const u = Math.max(0, Math.min(1, flip ? 1 - t : t));
    if (shape === 'smooth') return r0 + (r1 - r0) * u * u * (3 - 2 * u);
    if (shape === 'mid') return r0 * 2 * (u - 0.5) * (u - 1) - rm * 4 * u * (u - 1) + r1 * 2 * u * (u - 0.5);
    return r0 + (r1 - r0) * u;
  };
}
function surfaceFillet(fa, fb, pA, pB, law) {
  if (typeof law === 'number') law = { r0: law, r1: law };
  const side = (f, P) => { const q = projectOn(f, P); const nv = f.normalAt(q); return dot(sub(P, q), [nv.x, nv.y, nv.z]) > 0 ? 1 : -1; };
  const sizeAt = sizeLaw(law);
  // a chord c spans a ball of radius c / (2 sin(θ/2)), θ = angle between the contact directions
  const sizeToR = (c, om) => (law.chord ? c / (2 * Math.max(Math.sin(om / 2), 1e-3)) : c);
  const k = law.chord ? Math.SQRT1_2 : 1; // first guess assumes surfaces meeting at 90°
  const rm = sizeAt(0.5) * k;
  const r = Math.max(Math.min(sizeAt(0), sizeAt(0.5), sizeAt(1)) * k, 1e-3); // sets the spine sampling density
  const A2 = offsetFace(fa, side(fa, pB) * rm), B2 = offsetFace(fb, side(fb, pA) * rm);
  const sec = new (getOC().BRepAlgoAPI_Section)(A2.wrapped, B2.wrapped, true);
  const spine = cast(downcast(sec.Shape())).edges.sort((x, y) => y.length - x.length)[0];
  sec.delete();
  if (!spine) throw new Error('No fillet of this radius fits between the surfaces (they must cross or come within the radius)');
  const N = Math.max(16, Math.min(60, Math.round(spine.length / (r * 0.5)))), M = 9, X = 3;
  const P3 = (v) => [v.x, v.y, v.z];
  const rows = [], toolA = [], toolB = [];
  for (let i = -X; i <= N + X; i++) {
    const t = i / N;
    let S;
    if (t < 0 || t > 1) {
      // extend the trimming cutters past the spine ends so they always cut through
      const end = t < 0 ? 0 : 1, p0 = P3(spine.pointAt(end)), p1 = P3(spine.pointAt(end ? 0.98 : 0.02));
      S = add(p0, mul(unit(sub(p0, p1)), (Math.abs(t - end) / X) * spine.length * 0.35));
    } else S = P3(spine.pointAt(t));
    const size = sizeAt(t);
    let rt = law.chord ? size / Math.SQRT2 : size, a, b, ua, ub, om;
    for (let it = 0; it < (law.chord ? 4 : 1); it++) {
      S = ballCentre(fa, fb, S, rt);
      a = projectOn(fa, S); b = projectOn(fb, S);
      if (!a || !b) break;
      ua = unit(sub(a, S)); ub = unit(sub(b, S));
      om = Math.acos(Math.max(-1, Math.min(1, dot(ua, ub))));
      if (law.chord) rt = sizeToR(size, om);
    }
    if (!a || !b) continue;
    if (t >= 0 && t <= 1) {
      const row = [];
      for (let j = 0; j < M; j++) {
        const u = j / (M - 1);
        const k1 = om > 1e-6 ? Math.sin((1 - u) * om) / Math.sin(om) : 1 - u, k2 = om > 1e-6 ? Math.sin(u * om) / Math.sin(om) : u;
        row.push(add(S, mul(unit(add(mul(ua, k1), mul(ub, k2))), rt)));
      }
      rows.push(row);
    }
    toolA.push([0, 0.5, 1, 1.5, 2].map((k) => add(S, mul(sub(a, S), k))));
    toolB.push([0, 0.5, 1, 1.5, 2].map((k) => add(S, mul(sub(b, S), k))));
  }
  if (rows.length < 4) throw new Error('Could not build the fillet between these surfaces');
  const fillet = gridFace(rows);
  const pick = (pieces, P) => pieces.map((pc) => [pc, measureDistanceBetween(pc, makeVertex(P))]).sort((x, y) => x[1] - y[1])[0][0];
  const a = pick(splitShape(fa, gridFace(toolA)).faces, pA);
  const b = pick(splitShape(fb, gridFace(toolB)).faces, pB);
  return { a, b, fillet };
}

// ---------- helpers ----------
function getBody(state, id, what = 'Body') {
  const s = state.bodies.get(id);
  if (!s) throw new Error(`${what} not found (it may have been removed or not created yet)`);
  return s;
}
function getSketch(state, id, what = 'profile') {
  const s = state.sketches.get(id);
  if (!s) throw new Error(`Select a sketch ${what}`);
  return s;
}

function applyOp(state, fid, shape, op, target) {
  if (op === 'new' || !op) { state.bodies.set(fid, shape); return; }
  const t = getBody(state, target, 'Target body');
  const r = op === 'join' ? t.fuse(shape) : op === 'cut' ? t.cut(shape) : t.intersect(shape);
  state.bodies.set(target, r);
}

function bboxOf(shape) {
  const [lo, hi] = shape.boundingBox.bounds;
  return { lo, hi, center: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2], diag: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) };
}

function near(shape, p, tol) {
  try { return measureDistanceBetween(shape, makeVertex(p)) <= tol; } catch { return false; }
}

function groupByBody(picks) {
  const m = new Map();
  for (const pk of picks || []) {
    if (!m.has(pk.body)) m.set(pk.body, []);
    m.get(pk.body).push(pk);
  }
  return m;
}

const tolFor = (body) => Math.max(bboxOf(body).diag * 1e-4, 1e-3);

// ---------- persistent references (the topological naming problem) ----------
// A pick stores the point that was clicked (p), that point normalised to the body's bounding box (u)
// and, from the app, a geometric signature of the face or edge (s):
//   face: { k: 'f', c: centroid, n: mean normal, a: area, pl: planar?, b: [lo, hi] }
//   edge: { k: 'e', m: midpoint, d: direction, l: length, st: straight?, a: start, z: end }
// Resolution, in order:
//   1. the clicked point still lies on a sub-shape that matches the signature (same kind, normal or
//      direction) → keep it;
//   2. otherwise every candidate is scored by signature (orientation, position, size) and the best one
//      is used, with the point carried along with the shape;
//   3. old picks without a signature fall back to the normalised point.
// In "expand" mode (sets of faces or edges) the pieces of a face or edge that a later edit split are
// all collected: coplanar faces inside the old face's extent, collinear edges inside the old span.
const sigCache = new WeakMap();
function subSig(sh, kind) {
  let s = sigCache.get(sh);
  if (s) return s;
  if (kind === 'f') {
    const c = vxyz(sh.center);
    let n = [0, 0, 0];
    try { n = unit(vxyz(sh.normalAt(c))); } catch { /* degenerate */ }
    let a = 0;
    try { a = measureArea(sh); } catch { /* ignore */ }
    const bb = bboxOf(sh);
    s = { c, n, a, pl: sh.geomType === 'PLANE', b: [bb.lo, bb.hi] };
  } else {
    const A = vxyz(sh.startPoint), Z = vxyz(sh.endPoint), m = vxyz(sh.pointAt(0.5));
    let l = 0;
    try { l = sh.length; } catch { l = len(sub(Z, A)); }
    s = { m, d: unit(sub(Z, A)), l, st: sh.geomType === 'LINE', a: A, z: Z };
  }
  sigCache.set(sh, s);
  return s;
}
const angleOK = (u, v, cos) => dot(unit(u), unit(v)) >= cos;
function consistent(sh, s, kind, p) {
  if (!s) return true;
  if (kind === 'f') {
    const g = subSig(sh, 'f');
    if (g.pl !== !!s.pl) return false;
    if (s.pl) {
      let n = g.n;
      try { n = unit(vxyz(sh.normalAt(p))); } catch { /* use centroid normal */ }
      return angleOK(n, s.n, Math.cos((15 * Math.PI) / 180));
    }
    return true;
  }
  const g = subSig(sh, 'e');
  if (g.st !== !!s.st) return false;
  return !s.st || Math.abs(dot(g.d, s.d)) >= Math.cos((15 * Math.PI) / 180);
}
function scoreSub(g, s, kind, diag) {
  if (kind === 'f') {
    if (g.pl !== !!s.pl) return Infinity;
    const ang = Math.acos(Math.max(-1, Math.min(1, dot(g.n, unit(s.n)))));
    if (s.pl && ang > 0.5) return Infinity;
    // for planes, how far the plane itself moved matters most (stacked faces share a normal)
    const shift = s.pl ? (Math.abs(dot(sub(g.c, s.c), unit(s.n))) / diag) * 8 : 0;
    return ang / 0.35 + shift + (len(sub(g.c, s.c)) / diag) * 4 + Math.abs(Math.log((g.a || 1e-9) / (s.a || 1e-9)));
  }
  if (g.st !== !!s.st) return Infinity;
  const ang = Math.acos(Math.min(1, Math.abs(dot(g.d, unit(s.d)))));
  if (s.st && ang > 0.5) return Infinity;
  return ang / 0.35 + (len(sub(g.m, s.m)) / diag) * 4 + Math.abs(Math.log((g.l || 1e-9) / (s.l || 1e-9)));
}
// Pieces of a split face (same plane, inside the old extent) or edge (same line, inside the old span).
function splitPieces(subShapes, s, kind, tol) {
  if (kind === 'f') {
    if (!s.pl || !s.b) return [];
    const n = unit(s.n), off = dot(s.c, n), [lo, hi] = s.b;
    return subShapes.filter((sh) => {
      const g = subSig(sh, 'f');
      if (!g.pl || !angleOK(g.n, n, 0.9999) || Math.abs(dot(g.c, n) - off) > tol * 10) return false;
      return g.c.every((v, i) => v >= lo[i] - tol * 10 && v <= hi[i] + tol * 10);
    });
  }
  if (!s.st) return [];
  const d = unit(s.d), t0 = 0, t1 = len(sub(s.z, s.a));
  const onLine = (q) => len(sub(sub(q, s.a), mul(d, dot(sub(q, s.a), d)))) < tol * 10;
  return subShapes.filter((sh) => {
    const g = subSig(sh, 'e');
    if (!g.st || Math.abs(dot(g.d, d)) < 0.9999 || !onLine(g.a) || !onLine(g.z)) return false;
    const tm = dot(sub(g.m, s.a), d);
    return tm >= t0 - tol && tm <= t1 + tol;
  });
}
function pointOn(sh, q, kind) {
  // keep q if it lies on the sub-shape, otherwise use a representative point of it
  if (near(sh, q, Math.max(bboxOf(sh).diag * 1e-6, 1e-6))) return q;
  if (kind === 'f') {
    const g = subSig(sh, 'f');
    if (g.pl) { const n = unit(g.n), pq = sub(q, mul(n, dot(sub(q, g.c), n))); if (near(sh, pq, 1e-6)) return pq; }
    return vxyz(sh.pointOnSurface(0.5, 0.5));
  }
  return subSig(sh, 'e').m;
}

/** Matches stored picks to sub-shapes: [{ q, sub }] (several per pick in expand mode). */
function matchPicks(body, subShapes, picks, tol, { expand = false } = {}) {
  const bb = bboxOf(body), out = [];
  for (const pk of picks) {
    const s = pk.s, k = s?.k || 'f';
    const nearOnes = subShapes.filter((sh) => near(sh, pk.p, tol));
    const good = nearOnes.filter((sh) => consistent(sh, s, k, pk.p));
    let found = null, pieces = null;
    if (good.length) found = { q: pk.p, sub: good[0] };
    else if (s && (pieces = splitPieces(subShapes, s, k, tol)).length) {
      // the face or edge was split: keep the piece nearest the old point (the rest join in expand mode)
      const d = (sh) => { try { return measureDistanceBetween(sh, makeVertex(pk.p)); } catch { return Infinity; } };
      const best = pieces.slice().sort((x, y) => d(x) - d(y))[0];
      found = { q: pointOn(best, pk.p, k), sub: best };
    } else if (s) {
      let best = null, bs = Infinity;
      for (const sh of subShapes) { const sc = scoreSub(subSig(sh, k), s, k, bb.diag || 1); if (sc < bs) { bs = sc; best = sh; } }
      if (best && bs < 4) {
        const shift = k === 'f' ? sub(subSig(best, 'f').c, s.c) : sub(subSig(best, 'e').m, s.m);
        found = { q: pointOn(best, add(pk.p, shift), k), sub: best };
      }
    } else if (pk.u) {
      const q = pk.u.map((t, i) => bb.lo[i] + t * (bb.hi[i] - bb.lo[i]));
      const sh = subShapes.find((x) => near(x, q, tol));
      if (sh) found = { q, sub: sh };
    }
    if (!found && nearOnes.length) found = { q: pk.p, sub: nearOnes[0] };
    if (!found) { out.push({ q: pk.p, sub: null }); continue; }
    out.push(found);
    if (expand && s) {
      for (const sh of splitPieces(subShapes, s, k, tol)) if (!out.some((o) => o.sub && o.sub.isSame?.(sh))) out.push({ q: pointOn(sh, found.q, k), sub: sh });
    }
  }
  return out;
}
function resolvePicks(body, subShapes, picks, tol, opts) { return matchPicks(body, subShapes, picks, tol, opts).map((m) => m.q); }

function pickedEdge(st, pk) {
  const body = getBody(st, pk.body);
  const tol = tolFor(body);
  const [m] = matchPicks(body, body.edges, [{ ...pk, s: pk.s?.k === 'e' ? pk.s : undefined }], tol);
  const edge = m?.sub;
  if (!edge) throw new Error('The selected edge no longer exists - edit this feature and reselect it');
  const face = body.faces.find((fc) => fc.edges.some((e) => e.isSame(edge)));
  return { body, edge, face };
}

function pickedFace(st, pk) {
  const body = getBody(st, pk.body);
  const tol = tolFor(body);
  const [m] = matchPicks(body, body.faces, [{ ...pk, s: pk.s?.k === 'f' ? pk.s : undefined }], tol);
  const face = m?.sub;
  if (!face) throw new Error('The selected face no longer exists - edit this feature and reselect it');
  return { body, face, q: m.q, tol };
}

// Plane references: 'XY' | {type:'std',name} | {type:'plane',id} | {type:'face',body,p,n,u}
function resolvePlaneRef(st, ref) {
  if (!ref) return null;
  if (typeof ref === 'string') return STD_PLANES[ref] || null;
  if (ref.type === 'std') return STD_PLANES[ref.name];
  if (ref.type === 'plane') {
    const pl = st.planes.get(ref.id);
    if (!pl) throw new Error('Referenced construction plane is missing');
    return pl;
  }
  if (ref.type === 'face') {
    const { face, q } = pickedFace(st, ref);
    if (face.geomType !== 'PLANE') throw new Error('Sketch face is no longer planar');
    return planeFromPointNormal(q, ref.n);
  }
  return null;
}

function revolveAxis(sk, axis) {
  const pl = sk.plane || STD_PLANES.XY;
  if (axis === 'sx') return { dir: pl.xDir, origin: pl.origin };
  if (axis === 'sy') return { dir: yDirOf(pl), origin: pl.origin };
  return { dir: AXES[axis], origin: [0, 0, 0] };
}

function polyDrawing(pts) {
  let pen = draw(pts[0]);
  for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
  return pen.close();
}

// Rotates shape s so that direction `from` points along `to`, about `center`.
function alignShape(s, from, to, center) {
  from = unit(from); to = unit(to);
  const c = cross(from, to), sl = len(c), d = dot(from, to);
  if (sl < 1e-9) {
    if (d > 0) return s;
    const perp = Math.abs(from[0]) < 0.9 ? unit(cross(from, [1, 0, 0])) : unit(cross(from, [0, 1, 0]));
    return s.rotate(180, center, perp);
  }
  return s.rotate(Math.atan2(sl, d) * RAD, center, unit(c));
}

// Frame of a picked face for joints: planar → centroid + normal, cylinder/cone → axis.
function faceFrame(st, pk) {
  const { face, q } = pickedFace(st, pk);
  const gt = face.geomType;
  if (gt === 'CYLINDRE' || gt === 'CONE') {
    // pointOnSurface takes normalised (0..1) UV parameters
    const P = [0, 1, 2].map((i) => vxyz(face.pointOnSurface((i + 0.5) / 3, 0.5)));
    // circumcentre of three points on the circle
    const a = sub(P[1], P[0]), c = sub(P[2], P[0]);
    const axis = unit(cross(a, c));
    const num = add(mul(cross(cross(a, c), a), dot(c, c)), mul(cross(c, cross(a, c)), dot(a, a)));
    const center = add(P[0], mul(num, 1 / (2 * dot(cross(a, c), cross(a, c)))));
    // orient the axis consistently with the surface's v direction
    const vdir = sub(vxyz(face.pointOnSurface(0, 1)), vxyz(face.pointOnSurface(0, 0)));
    return { kind: 'axis', center, normal: dot(axis, vdir) < 0 ? neg(axis) : axis };
  }
  // circular planar faces snap to their centre, others use the picked point
  const centroid = vxyz(face.center);
  let circular = false;
  try {
    const edges = face.clone().outerWire().edges;
    circular = edges.length === 1 && edges[0].geomType === 'CIRCLE';
  } catch { /* keep picked point */ }
  return { kind: 'plane', center: circular ? centroid : q, normal: unit(pk.n) };
}

// ---------- associative sketch projections ----------
// Projected curves carry src = { body, p, s, g (group), k (kind), i }. Before the sketch is solved, each
// source edge is found again on the current body and projected into the sketch plane, moving the
// curve's fixed points, so dimensions and constraints that use them follow the model.
function reproject(st, sk0, plane) {
  const groups = new Map();
  for (const c of sk0.curves || []) if (c.src?.body) { if (!groups.has(c.src.g)) groups.set(c.src.g, []); groups.get(c.src.g).push(c); }
  if (!groups.size) return { sk: sk0, lost: 0, proj: null };
  const sk = { ...sk0, points: sk0.points.map((q) => ({ ...q })), curves: sk0.curves.map((c) => ({ ...c })) };
  const P = new Map(sk.points.map((q) => [q.id, q])), C = new Map(sk.curves.map((c) => [c.id, c]));
  const y = yDirOf(plane), loc = (q) => { const d = sub(q, plane.origin); return [dot(d, plane.xDir), dot(d, y)]; };
  const set = (id, xy) => { const q = P.get(id); if (q) { q.x = xy[0]; q.y = xy[1]; } };
  const at = (id) => { const q = P.get(id); return q ? [q.x, q.y] : [0, 0]; };
  const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let lost = 0;
  for (const list of groups.values()) {
    const src = list[0].src, body = st.bodies.get(src.body);
    let edge = null;
    try { edge = body && matchPicks(body, body.edges, [{ p: src.p, s: src.s }], tolFor(body))[0]?.sub; } catch { edge = null; }
    if (!edge && body && src.s) edge = nearestLikeEdge(body, src);
    if (!edge) { lost++; continue; }
    const sample = (n) => Array.from({ length: n + 1 }, (_, k) => loc(vxyz(edge.pointAt(k / n))));
    const cs = list.map((c) => C.get(c.id)).sort((a, b) => (a.src.i || 0) - (b.src.i || 0));
    if (src.k === 'line') {
      const [A, B] = [sample(1)[0], sample(1)[1]], c = cs[0];
      if (d2(A, at(c.a)) + d2(B, at(c.b)) <= d2(B, at(c.a)) + d2(A, at(c.b))) { set(c.a, A); set(c.b, B); } else { set(c.a, B); set(c.b, A); }
    } else if (src.k === 'circle' || src.k === 'arc') {
      const pts = sample(24), c = cs[0], ctr = circumcentre2(pts[0], pts[8], pts[16]);
      if (!ctr) { lost++; continue; }
      set(c.c, ctr);
      if (src.k === 'circle') c.r = d2(ctr, pts[0]);
      else { const E0 = pts[0], E1 = pts[24]; if (d2(E0, at(c.a)) + d2(E1, at(c.b)) <= d2(E1, at(c.a)) + d2(E0, at(c.b))) { set(c.a, E0); set(c.b, E1); } else { set(c.a, E1); set(c.b, E0); } }
    } else {
      // a chain of segments through points along the edge: re-sample it with the same number of points
      const closed = src.k === 'loop', ids = cs.map((c) => c.a);
      if (!closed) ids.push(cs.at(-1).b);
      const n = closed ? ids.length : ids.length - 1, pts = sample(n);
      if (d2(pts[0], at(ids[0])) > d2(pts[n], at(ids[0])) && !closed) pts.reverse();
      ids.forEach((id, k) => set(id, pts[k]));
    }
  }
  // the moved points and radii, so the app can store them (the sketch editor then shows them too)
  const proj = { pts: {}, r: {} };
  for (const q of sk.points) { const o = sk0.points.find((x) => x.id === q.id); if (o && (Math.abs(o.x - q.x) > 1e-9 || Math.abs(o.y - q.y) > 1e-9)) proj.pts[q.id] = [q.x, q.y]; }
  for (const c of sk.curves) { const o = sk0.curves.find((x) => x.id === c.id); if (c.type === 'circle' && o && Math.abs(o.r - c.r) > 1e-9) proj.r[c.id] = c.r; }
  return { sk, lost, proj: Object.keys(proj.pts).length || Object.keys(proj.r).length ? proj : null };
}

// The edge most like a projected one: same kind (straight with the same direction, or round with the same
// length), similar length, nearest to where it was. Lets a projection follow a feature that moved.
function nearestLikeEdge(body, src) {
  const sg = src.s, want = sg.m || src.p;
  let best = null, bd = Infinity;
  for (const e of body.edges) {
    try {
      const L = e.length, straight = e.geomType === 'LINE';
      if (straight !== !!sg.st || Math.abs(L - sg.l) > 0.35 * sg.l + 1e-6) continue;
      if (straight) { const d = unit(sub(vxyz(e.endPoint), vxyz(e.startPoint))); if (Math.abs(dot(d, sg.d)) < 0.999) continue; }
      else if (Math.abs(L - sg.l) > 1e-3 * Math.max(1, sg.l)) continue;
      const dist = len(sub(vxyz(e.pointAt(0.5)), want));
      if (dist < bd) { bd = dist; best = e; }
    } catch { /* skip */ }
  }
  return best;
}

// ---------- sheet metal helpers ----------
// A sheet body keeps its definition in st.sheets: the base plane (z = 0 is the bottom of the plate),
// thickness T, inside bend radius R, K-factor, the base outline (counter-clockwise pieces) and the
// flanges added to straight outline segments. The flat pattern is computed from this definition.
function loopSignedArea(pieces) {
  const ring = pieces.flatMap((pc) => [0, 0.25, 0.5, 0.75].map((t) => pieceAt(pc, t)));
  let a = 0;
  for (let i = 0; i < ring.length; i++) { const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length]; a += x0 * y1 - x1 * y0; }
  return a / 2;
}

function sheetFrame(sh) {
  const n = sh.plane.normal, X = sh.plane.xDir, Y = cross(n, X), O = sh.plane.origin;
  return {
    n, X, Y,
    loc: (q) => { const d = sub(q, O); return [dot(d, X), dot(d, Y), dot(d, n)]; },
    to3: (x, y, z = 0) => add(O, add(mul(X, x), add(mul(Y, y), mul(n, z)))),
  };
}

// Flanges can carry flanges. Each flange's flat part is a "panel" with its own frame, laid out like a
// base plate (z = 0 is the outer face, thickness toward +z), so flange geometry works the same on any
// panel. Panel outline: bend line (0,0)→(W,0), side, tip (W,L)→(0,L), side. Flanges record the panel
// they hang from (parent: 'base' or a flange id).
function childPanel(sh, fl) {
  const g = flangeGeom(sh, fl), F = sheetFrame(sh);
  const u3 = add(mul(F.X, g.u2[0]), mul(F.Y, g.u2[1])), o3 = cross(u3, F.n);
  const v3 = (q2) => add(mul(o3, q2[0]), mul(F.n, q2[1]));
  const baseA = F.to3(g.A[0], g.A[1]);
  const oT = add(baseA, v3(g.at(sh.R + sh.T, g.th))), iT = add(baseA, v3(g.at(sh.R, g.th)));
  const nC = unit(sub(iT, oT)), t3 = unit(v3(g.t));
  // right-handed: X along the edge, Y away from the bend, normal toward the thickness side
  const flip = dot(cross(u3, t3), nC) < 0;
  const X = flip ? neg(u3) : u3, origin = flip ? add(oT, mul(u3, g.span)) : oT;
  const W = g.span, L = fl.length, ln = (a, b) => ({ type: 'line', a, b });
  return { plane: { origin, xDir: X, normal: nC }, T: sh.T, R: sh.R, K: sh.K, outer: [ln([0, 0], [W, 0]), ln([W, 0], [W, L]), ln([W, L], [0, L]), ln([0, L], [0, 0])], holes: [], flanges: [], bendSeg: 0, W, L, flip };
}
function sheetPanels(sh) {
  const panels = new Map([['base', sh]]);
  for (const fl of sh.flanges) { const par = panels.get(fl.parent || 'base'); if (par) panels.set(fl.id, childPanel(par, fl)); }
  return panels;
}
// The panel and straight outline segment an edge point lies on (or null).
function sheetEdgeAt(sh, q) {
  let best = null, bd = Math.max(sh.T * 0.6, 1e-3);
  for (const [pid, pan] of sheetPanels(sh)) {
    const [x, y, z] = sheetFrame(pan).loc(q);
    if (z < -bd || z > pan.T + bd) continue;
    pan.outer.forEach((pc, i) => {
      if (pc.type !== 'line' || i === pan.bendSeg) return;
      const [ax, ay] = pc.a, [bx, by] = pc.b, dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (L2 || 1)));
      const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
      if (d < bd) { bd = d; best = { pid, seg: i }; }
    });
  }
  return best;
}

// Geometry of one flange in the bend cross-section (o = outward from the edge, z = plate normal).
function flangeGeom(sh, fl) {
  const pc = sh.outer[fl.seg];
  const L = Math.hypot(pc.b[0] - pc.a[0], pc.b[1] - pc.a[1]);
  const u2 = [(pc.b[0] - pc.a[0]) / L, (pc.b[1] - pc.a[1]) / L], o2 = [u2[1], -u2[0]];
  if (fl.inset0 + fl.inset1 >= L - 1e-6) throw new Error('The flange insets are longer than the edge');
  const A = [pc.a[0] + u2[0] * fl.inset0, pc.a[1] + u2[1] * fl.inset0], B = [pc.b[0] - u2[0] * fl.inset1, pc.b[1] - u2[1] * fl.inset1];
  const { T, R } = sh, s = fl.up ? 1 : -1, th = (fl.angle * Math.PI) / 180;
  const za = s > 0 ? T + R : -R;
  const at = (r, phi) => [r * Math.sin(phi), za - s * r * Math.cos(phi)];
  const t = [Math.cos(th), s * Math.sin(th)];
  const BA = th * (R + sh.K * T); // bend allowance on the neutral axis
  return { A, B, u2, o2, s, th, at, t, BA, span: Math.hypot(B[0] - A[0], B[1] - A[1]) };
}

function flangeSolid(sh, fl) {
  const g = flangeGeom(sh, fl), { R, T } = sh, Lf = fl.length;
  const F = sheetFrame(sh);
  const u3 = add(mul(F.X, g.u2[0]), mul(F.Y, g.u2[1])), o3 = cross(u3, F.n);
  const ext = (q) => [q[0] + g.t[0] * Lf, q[1] + g.t[1] * Lf];
  const i0 = g.at(R, 0), iT = g.at(R, g.th), iM = g.at(R, g.th / 2);
  const oT = g.at(R + T, g.th), oM = g.at(R + T, g.th / 2), o0 = g.at(R + T, 0);
  let pen = draw(i0);
  if (R > 1e-9) pen = pen.threePointsArcTo(iT, iM);
  if (Lf > 1e-9) pen = pen.lineTo(ext(iT)).lineTo(ext(oT));
  pen = pen.lineTo(oT).threePointsArcTo(o0, oM);
  // section plane at the B end of the edge: x = outward, y = plate normal, extruded back to A
  const pl = new Plane(F.to3(g.B[0], g.B[1]), o3, neg(u3));
  return pen.close().sketchOnPlane(pl).extrude(g.span);
}

/** Flat pattern of a sheet body: DXF entities (bend lines on layer BEND), bend table and size. */
export function flatPattern(state, bodyId) {
  const sh = state.sheets?.get(bodyId);
  if (!sh) throw new Error('This body is not sheet metal. Create it with Sheet Metal ▸ Base.');
  const body = state.bodies.get(bodyId);
  const F = sheetFrame(sh);
  const ents = [], bends = [];
  const line = (a, b, layer) => { if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-9) ents.push({ t: 'LINE', a, b, layer }); };
  const pieceEnt = (pc) => {
    if (pc.type === 'line') return line(pc.a, pc.b);
    if (pc.type === 'arc') {
      const d0 = (pc.s * 180) / Math.PI, d1 = ((pc.s + pc.sw) * 180) / Math.PI;
      if (Math.abs(pc.sw) >= 2 * Math.PI - 1e-9) return ents.push({ t: 'CIRCLE', c: pc.c, r: pc.r });
      return ents.push(pc.sw > 0 ? { t: 'ARC', c: pc.c, r: pc.r, a0: d0, a1: d1 } : { t: 'ARC', c: pc.c, r: pc.r, a0: d1, a1: d0 });
    }
    const pts = []; for (let i = 0; i <= 24; i++) pts.push(pieceAt(pc, i / 24));
    ents.push({ t: 'POLY', pts });
  };
  const P = (q, u, du, o, dO) => [q[0] + u[0] * du + o[0] * dO, q[1] + u[1] * du + o[1] * dO];
  const panels = sheetPanels(sh), maps = new Map();
  // unfold a panel: M maps the panel's own 2D coordinates onto the flat pattern
  const unfold = (pid, M) => {
    const pan = panels.get(pid), kids = sh.flanges.filter((x) => (x.parent || 'base') === pid);
    maps.set(pid, M);
    pan.outer.forEach((pc, i) => {
      if (i === pan.bendSeg) return line(M(pc.a), M(pc.b), 'BEND');
      const fl = kids.find((x) => x.seg === i);
      if (!fl) return pid === 'base' ? pieceEnt(pc) : line(M(pc.a), M(pc.b));
      const g = flangeGeom(pan, fl);
      line(M(pc.a), M(g.A)); line(M(g.B), M(pc.b));
      line(M(g.A), M(P(g.A, g.u2, 0, g.o2, g.BA))); line(M(g.B), M(P(g.B, g.u2, 0, g.o2, g.BA)));
      line(M(g.A), M(g.B), 'BEND');
      bends.push({ angle: fl.angle, dir: fl.up ? 'Up' : 'Down', radius: sh.R, allowance: g.BA, length: g.span });
      const cp = panels.get(fl.id);
      unfold(fl.id, (q) => M(P(cp.flip ? g.B : g.A, g.u2, cp.flip ? -q[0] : q[0], g.o2, g.BA + q[1])));
    });
  };
  unfold('base', (q) => q);
  // cut-outs: inner loops of the faces lying on each panel's outer face (z = 0 of its frame)
  let holes = 0;
  if (body) {
    const tolZ = 1e-4 * Math.max(1, sh.T * 10);
    const planarFaces = body.faces.filter((fc) => fc.geomType === 'PLANE');
    for (const [pid, pan] of panels) {
      const Fp = sheetFrame(pan), M = maps.get(pid);
      for (const fc of planarFaces) {
        const pts = [0.2, 0.5, 0.8].flatMap((a) => [0.3, 0.7].map((b) => Fp.loc(vxyz(fc.pointOnSurface(a, b)))));
        if (!pts.every((q) => Math.abs(q[2]) < tolZ)) continue;
        if (pid !== 'base' && !pts.every((q) => q[0] > -tolZ - 1e-3 && q[0] < pan.W + 1e-3 && q[1] > -1e-3 && q[1] < pan.L + 1e-3)) continue;
        for (const w of fc.clone().innerWires()) { ents.push(...edgeEnts(w.edges, (q) => M(Fp.loc(q).slice(0, 2)))); holes++; }
      }
    }
  }
  if (!holes) for (const h of sh.holes) h.forEach(pieceEnt);
  // overall size, then shift to the origin
  let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  const each = (q) => { lo = [Math.min(lo[0], q[0]), Math.min(lo[1], q[1])]; hi = [Math.max(hi[0], q[0]), Math.max(hi[1], q[1])]; };
  for (const e of ents) {
    if (e.t === 'LINE') { each(e.a); each(e.b); } else if (e.t === 'POLY') e.pts.forEach(each);
    else {
      const a0 = e.t === 'ARC' ? e.a0 : 0, sw = e.t === 'ARC' ? ((((e.a1 - e.a0) % 360) + 360) % 360 || 360) : 360;
      for (let k = 0; k <= 72; k++) { const a = ((a0 + (sw * k) / 72) * Math.PI) / 180; each([e.c[0] + e.r * Math.cos(a), e.c[1] + e.r * Math.sin(a)]); }
    }
  }
  const sh2 = (q) => [q[0] - lo[0], q[1] - lo[1]];
  for (const e of ents) { if (e.t === 'LINE') { e.a = sh2(e.a); e.b = sh2(e.b); } else if (e.t === 'POLY') e.pts = e.pts.map(sh2); else e.c = sh2(e.c); }
  return { ents, bends, size: [hi[0] - lo[0], hi[1] - lo[1]], thickness: sh.T, kfactor: sh.K, radius: sh.R, dxf: writeDXF(ents) };
}

// ---------- assemblies: components and mates ----------
// A component feature rebuilds another project's (resolved) features in its own cache and inserts its
// bodies as "<componentId>/<bodyId>", placed by a rigid transform T = { r: rotation vector (rad), t }.
// Mates are solved together after the rebuild (solveAssembly) by Levenberg–Marquardt over the
// rotation and translation of every component that is not grounded.
const componentCaches = new Map();
const rodrigues = (r) => {
  const th = Math.hypot(r[0], r[1], r[2]);
  if (th < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const k = r.map((v) => v / th), c = Math.cos(th), s = Math.sin(th), v = 1 - c;
  return [
    c + k[0] * k[0] * v, k[0] * k[1] * v - k[2] * s, k[0] * k[2] * v + k[1] * s,
    k[1] * k[0] * v + k[2] * s, c + k[1] * k[1] * v, k[1] * k[2] * v - k[0] * s,
    k[2] * k[0] * v - k[1] * s, k[2] * k[1] * v + k[0] * s, c + k[2] * k[2] * v,
  ];
};
const matMul = (A, B) => { const C = new Array(9).fill(0); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j]; return C; };
const matVec = (R, v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
// rotation matrix → rotation vector
function rotVec(R) {
  // angle from atan2 (acos loses half its digits near 0° and 180°)
  const v = [(R[7] - R[5]) / 2, (R[2] - R[6]) / 2, (R[3] - R[1]) / 2], sn = Math.hypot(...v), cs = (R[0] + R[4] + R[8] - 1) / 2;
  const th = Math.atan2(sn, cs);
  if (th < 1e-12) return v;
  if (sn > 1e-4) return v.map((x) => (x * th) / sn);
  // near 180°: the axis is the dominant column of R + I, signed to agree with the antisymmetric part
  const k = R[0] >= R[4] && R[0] >= R[8] ? 0 : R[4] >= R[8] ? 1 : 2;
  const col = [R[k] + (k === 0 ? 1 : 0), R[3 + k] + (k === 1 ? 1 : 0), R[6 + k] + (k === 2 ? 1 : 0)];
  const l = Math.hypot(...col) || 1, ax = col.map((x) => x / l);
  const sg = ax[0] * v[0] + ax[1] * v[1] + ax[2] * v[2] < 0 ? -1 : 1;
  return ax.map((x) => x * th * sg);
}
export const transformPoint = (T, p) => add(matVec(rodrigues(T.r), p), T.t);
export const transformDir = (T, d) => matVec(rodrigues(T.r), d);
function placeShape(shape, T) {
  let s = shape.clone();
  const th = Math.hypot(...T.r);
  if (th > 1e-12) s = s.rotate((th * 180) / Math.PI, [0, 0, 0], T.r.map((v) => v / th));
  if (Math.hypot(...T.t) > 0) s = s.translate(T.t);
  return s;
}
/** Initial placement from the component feature's position (mm) and rotations (deg, X then Y then Z). */
function featureT(p) {
  const d = Math.PI / 180;
  const Rx = rodrigues([(p.rx || 0) * d, 0, 0]), Ry = rodrigues([0, (p.ry || 0) * d, 0]), Rz = rodrigues([0, 0, (p.rz || 0) * d]);
  return { r: rotVec(matMul(Rz, matMul(Ry, Rx))), t: [p.x || 0, p.y || 0, p.z || 0] };
}

async function buildComponent(f, st) {
  const { p } = f;
  if (!p.features?.length) throw new Error('This component has no geometry. Update it from its project.');
  if (!componentCaches.has(f.id)) componentCaches.set(f.id, []);
  const sub = await rebuild(p.features, componentCaches.get(f.id));
  const fin = sub.states.at(-1);
  if (!fin || !fin.bodies.size) throw new Error('The component project has no bodies');
  const T = featureT(p), local = new Map(), ids = [];
  for (const [bid, shape] of fin.bodies) {
    const id = `${f.id}/${bid}`;
    local.set(bid, shape);
    st.bodies.set(id, placeShape(shape, T));
    ids.push(id);
  }
  st.components.set(f.id, { T, local, ids, grounded: !!p.grounded, name: p.name || 'Component' });
  const errs = Object.values(sub.errors);
  if (errs.length) return { warning: `${errs.length} feature${errs.length === 1 ? '' : 's'} in the component failed: ${errs[0]}` };
}

// Geometry of a mate reference in its component's local frame: a plane (point + normal) or an axis.
function mateGeom(state, ref) {
  let shape;
  if (ref.comp) {
    const c = state.components.get(ref.comp);
    if (!c) throw new Error('A mated component was removed');
    shape = c.local.get(ref.body);
  } else shape = state.bodies.get(ref.body);
  if (!shape) throw new Error('A mated body no longer exists');
  const tol = tolFor(shape);
  let [m] = matchPicks(shape, shape.faces, [{ p: ref.p, u: undefined, s: ref.s }], tol);
  // parts change: when the exact face is gone, take the nearest face of the same kind (same normal for a
  // flat face, same radius for a round one, similar area), so a mate follows a hole that moved
  if (!m?.sub && ref.s) m = nearestLikeFace(shape, ref);
  const face = m?.sub;
  if (!face) throw new Error('A mated face no longer exists - edit the mate and pick it again');
  if (face.geomType === 'PLANE') {
    let n = ref.n;
    try { n = unit(vxyz(face.normalAt(m.q))); } catch { /* keep picked normal */ }
    return { kind: 'plane', p: m.q, n };
  }
  if (face.geomType === 'CYLINDRE' || face.geomType === 'CONE') {
    const cy = cylinderOf(face);
    return { kind: 'axis', p: cy.center, d: cy.axis, r: cy.radius, e: perpTo(cy.axis) };
  }
  throw new Error('Mates need flat faces or round faces (cylinders and cones)');
}

function nearestLikeFace(shape, ref) {
  const flat = !!ref.s.pl, want = ref.s.c || ref.p;
  let best = null, bd = Infinity;
  for (const f of shape.faces) {
    try {
      const isFlat = f.geomType === 'PLANE';
      if (isFlat !== flat || (!isFlat && f.geomType !== 'CYLINDRE' && f.geomType !== 'CONE')) continue;
      const a = measureArea(f);
      if (ref.s.a && (a > ref.s.a * 2.5 || a < ref.s.a / 2.5)) continue;
      const c = bboxOf(f).center;
      if (isFlat) { const n = unit(vxyz(f.normalAt())); if (dot(n, ref.s.n || ref.n) < 0.999) continue; }
      else if (ref.r && Math.abs(cylinderOf(f).radius - ref.r) > 1e-3 * Math.max(1, ref.r)) continue;
      const d = len(sub(c, want));
      if (d < bd) { bd = d; best = { sub: f, q: isFlat ? vxyz(f.pointOnSurface(0.5, 0.5)) : c }; }
    } catch { /* skip odd faces */ }
  }
  return best;
}

const MATE_RES = {
  // faces against each other: normals opposite, gap = offset
  mate: (A, B, m) => { const s = m.flip ? -1 : 1; return [...add(A.n, mul(B.n, s)), dot(sub(B.p, A.p), A.n) - (m.offset || 0)]; },
  // faces level with each other: normals equal, offset along the normal
  flush: (A, B, m) => { const s = m.flip ? -1 : 1; return [...sub(A.n, mul(B.n, s)), dot(sub(B.p, A.p), A.n) - (m.offset || 0)]; },
  parallel: (A, B) => cross(A.n || A.d, B.n || B.d),
  perpendicular: (A, B) => [dot(A.n || A.d, B.n || B.d)],
  angle: (A, B, m) => {
    // residual in radians, not cosines: the cosine is flat at 0° and 180°, which would stall the solver there
    const u = A.n || A.d, v = B.n || B.d, th = Math.atan2(len(cross(u, v)), dot(u, v)), D = Math.PI / 180;
    if (!m.limit) return [th - (m.angle || 0) * D];
    const lo = (m.min ?? 0) * D, hi = (m.max ?? 180) * D;
    return [th < lo ? th - lo : th > hi ? th - hi : 0];
  },
  // axes on the same line (pins in holes)
  concentric: (A, B) => { const d = A.d, w = sub(B.p, A.p); return [...cross(d, B.d), ...sub(w, mul(d, dot(w, d)))]; },
  // gears (and belts): the second part turns ratio × as far as the first, the other way unless flipped
  gear: (A, B, m) => {
    const g = gearState.get(m.id) || {};
    const a = unwrapNear(turnAngle(A), g.a), b = unwrapNear(turnAngle(B), g.b), k = (m.ratio || 1) * (m.flip ? -1 : 1);
    return [b + k * a - (g.phase ?? 0)];
  },
  // rack and pinion: the rack (second ref: an end face, whose normal is the travel direction) moves
  // pitch radius × the pinion's turn (radians)
  rack: (A, B, m) => {
    const g = gearState.get(m.id) || {};
    const a = unwrapNear(turnAngle(A), g.a), s = dot(B.p, B.n) * (m.flip ? -1 : 1);
    return [s - (m.radius || A.r || 1) * a - (g.phase ?? 0)];
  },
  // contact: the second face may touch the first or move away from it, but not pass through it
  // (flat on flat: the faces stay facing each other, so the part can't tip a corner into the other)
  contact: (A, B, m) => { const d = dot(sub(B.p, A.p), A.n) - (m.offset || 0); return [...add(A.n, B.n), d < 0 ? d : 0]; },
  // a face at a set distance out from the first face (on the side its normal points to), normals parallel either way
  distance: (A, B, m) => {
    const d = dot(sub(B.p, A.p), A.n);
    if (!m.limit) return [...cross(A.n, B.n), d - (m.offset || 0)];
    // a range of distances (a slide with end stops): no residual inside it
    const lo = m.min ?? -Infinity, hi = m.max ?? Infinity;
    return [...cross(A.n, B.n), d < lo ? d - lo : d > hi ? d - hi : 0];
  },
};
const MATE_NEEDS = { mate: 'plane', flush: 'plane', distance: 'plane', contact: 'plane', concentric: 'axis', gear: 'axis' };
const MATE_NEEDS2 = { rack: ['axis', 'plane'] };
// a unit vector perpendicular to d (deterministic)
function perpTo(d) { const a = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]; return unit(cross(d, a)); }
// how far a part has turned about its own axis: the angle of its reference vector e around d, against a
// fixed reference perpendicular to d
function turnAngle(g) { const r0 = perpTo(g.d), e = unit(sub(g.e, mul(g.d, dot(g.e, g.d)))); return Math.atan2(dot(cross(r0, e), g.d), dot(r0, e)); }
const gearState = new Map(); // mate id → { a, b, phase }: unwrapped angles at the last solution
const unwrapNear = (th, prev) => (prev == null ? th : th + 2 * Math.PI * Math.round((prev - th) / (2 * Math.PI)));

const lastSolution = new Map(); // component id → T (warm start between rebuilds)

/**
 * Solves the mates and moves component bodies. mates: [{ id, type, a: ref, b: ref, offset, angle, flip }]
 * ref: { comp: componentId | null, body: bodyId, p, n, s } in the component's local frame.
 * Returns { state, assembly: { transforms, mates: [{ id, ok, residual, error }], dof } }.
 */
export function solveAssembly(state, mates = []) {
  const comps = [...state.components.entries()];
  const transforms = {}, report = [];
  if (!comps.length) return { state, assembly: null };
  // free components (6 unknowns each); the first component is grounded when nothing else is
  const anyGround = comps.some(([, c]) => c.grounded) || state.bodies.size > comps.reduce((s, [, c]) => s + c.ids.length, 0);
  const movable = comps.filter(([, c], i) => !c.grounded && (anyGround || i > 0)).map(([id]) => id);
  const T0 = new Map(comps.map(([id, c]) => [id, lastSolution.get(id) && lastSolution.get(id).src === JSON.stringify(c.T) ? lastSolution.get(id).T : c.T]));
  const active = [];
  for (const m of mates) {
    if (m.suppressed) continue;
    try {
      const A = mateGeom(state, m.a), B = mateGeom(state, m.b);
      const need = MATE_NEEDS[m.type];
      const need2 = MATE_NEEDS2[m.type];
      if (need2 && (A.kind !== need2[0] || B.kind !== need2[1])) throw new Error('Rack and pinion: pick a round face on the pinion, then the flat end face of the rack');
      if (need && (A.kind !== need || B.kind !== need)) throw new Error(need === 'plane' ? 'This mate needs two flat faces' : `${m.type === 'gear' ? 'A gear mate' : 'Concentric'} needs two round faces`);
      if (!MATE_RES[m.type]) throw new Error(`Unknown mate ${m.type}`);
      active.push({ m, A, B });
    } catch (e) { report.push({ id: m.id, ok: false, residual: Infinity, error: errMsg(e) }); }
  }
  // only components that take part in a mate are solved for; the others keep their placement
  const mated = new Set(active.flatMap(({ m }) => [m.a.comp, m.b.comp]));
  const free = movable.filter((id) => mated.has(id));
  for (const [id, c] of comps) if (!free.includes(id)) T0.set(id, c.T);
  const world = (g, T) => (g.kind === 'plane' ? { kind: 'plane', p: transformPoint(T, g.p), n: transformDir(T, g.n) } : { kind: 'axis', p: transformPoint(T, g.p), d: transformDir(T, g.d), e: transformDir(T, g.e) });
  const tOf = (Ts, ref) => (ref.comp ? Ts.get(ref.comp) : { r: [0, 0, 0], t: [0, 0, 0] });
  for (const { m, A, B } of active) {
    if (m.type !== 'gear' && m.type !== 'rack') continue;
    const st = gearState.get(m.id), key = `${m.type}|${m.ratio}|${m.radius}|${!!m.flip}`;
    if (st && st.key === key) continue;
    // the gears mesh as they were placed: that pose sets the phase
    const wa = world(A, tOf(T0, m.a)), wb = world(B, tOf(T0, m.b)), a = turnAngle(wa);
    if (m.type === 'gear') { const b = turnAngle(wb), k = (m.ratio || 1) * (m.flip ? -1 : 1); gearState.set(m.id, { a, b, phase: b + k * a, key }); }
    else gearState.set(m.id, { a, phase: dot(wb.p, wb.n) * (m.flip ? -1 : 1) - (m.radius || A.r || 1) * a, key });
  }
  const residualOf = (set) => (Ts) => {
    const out = [], per = [];
    for (const { m, A, B } of set) {
      const r = MATE_RES[m.type](world(A, tOf(Ts, m.a)), world(B, tOf(Ts, m.b)), m);
      per.push(Math.hypot(...r));
      out.push(...r);
    }
    return { r: out, per };
  };
  // apply a 6-vector update per free component: rotation increment (left-multiplied) and translation
  const update = (Ts, x, scale = 1) => {
    const N = new Map(Ts);
    free.forEach((id, i) => {
      const T = Ts.get(id), w = [x[i * 6] * scale, x[i * 6 + 1] * scale, x[i * 6 + 2] * scale];
      const R = matMul(rodrigues(w), rodrigues(T.r));
      // rotate about the component's current position so rotation and translation stay decoupled
      const c = T.t;
      N.set(id, { r: rotVec(R), t: add(add(matVec(rodrigues(w), sub(T.t, c)), c), [x[i * 6 + 3] * scale, x[i * 6 + 4] * scale, x[i * 6 + 5] * scale]) });
    });
    return N;
  };
  const n = free.length * 6;
  let iterations = 0;
  // Levenberg–Marquardt on one set of mates from a starting pose
  const solveSet = (set, start) => {
  const residual = residualOf(set);
  let Ts = new Map(start), cur = residual(Ts), rank = 0;
  if (set.length && n) {
    let lambda = 1e-3;
    const norm = (r) => r.reduce((s, v) => s + v * v, 0);
    for (let it = 0; it < 200 && norm(cur.r) > 1e-20; it++, iterations++) {
      // numerical Jacobian
      const m = cur.r.length, J = Array.from({ length: m }, () => new Float64Array(n)), h = 1e-7;
      for (let j = 0; j < n; j++) {
        const x = new Float64Array(n); x[j] = h;
        const rp = residual(update(Ts, x)).r;
        for (let i = 0; i < m; i++) J[i][j] = (rp[i] - cur.r[i]) / h;
      }
      const JtJ = Array.from({ length: n }, () => new Float64Array(n)), Jtr = new Float64Array(n);
      for (let i = 0; i < m; i++) for (let a = 0; a < n; a++) { if (!J[i][a]) continue; Jtr[a] += J[i][a] * cur.r[i]; for (let b = 0; b < n; b++) JtJ[a][b] += J[i][a] * J[i][b]; }
      const maxDiag = Math.max(1e-12, ...JtJ.map((row, a) => row[a]));
      let improved = false;
      for (let tries = 0; tries < 12 && !improved; tries++) {
        // Marquardt damping with a floor, so directions the mates leave free (null space) take bounded steps
        const A = JtJ.map((row, a) => Float64Array.from(row, (v, b) => v + (a === b ? lambda * (v + 1e-6 * maxDiag) + 1e-10 * maxDiag : 0)));
        const dx = solveDense(A, Float64Array.from(Jtr, (v) => -v));
        if (!dx) { lambda *= 10; continue; }
        const Tn = update(Ts, dx), rn = residual(Tn);
        if (norm(rn.r) < norm(cur.r)) { Ts = Tn; cur = rn; lambda = Math.max(lambda / 5, 1e-12); improved = true; } else lambda *= 10;
      }
      if (!improved) break;
    }
    // remaining degrees of freedom: unknowns minus the rank of the Jacobian at the solution
    const m = cur.r.length, J = Array.from({ length: m }, () => new Float64Array(n)), h = 1e-6;
    for (let j = 0; j < n; j++) { const x = new Float64Array(n); x[j] = h; const rp = residual(update(Ts, x)).r; for (let i = 0; i < m; i++) J[i][j] = (rp[i] - cur.r[i]) / h; }
    rank = matRank(J, n);
  }
  return { Ts, cur, rank, ok: cur.per.every((v) => v < 1e-5) };
  };
  let sol = solveSet(active, T0);
  const conflicts = new Set();
  if (!sol.ok && active.length > 1) {
    // over-constrained: keep mates in the order they were added and drop the ones that cannot be met with the earlier ones
    let acc = [], best = solveSet([], T0);
    for (const item of active) {
      const t = solveSet([...acc, item], best.Ts);
      if (t.ok) { acc.push(item); best = t; } else conflicts.add(item.m.id);
    }
    sol = best;
  }
  const { Ts, rank } = sol, cur = residualOf(active)(Ts);
  // remember where the gears ended up, so angles keep unwrapping from there
  for (const { m, A, B } of active) {
    const st = (m.type === 'gear' || m.type === 'rack') && gearState.get(m.id);
    if (st) { st.a = unwrapNear(turnAngle(world(A, tOf(Ts, m.a))), st.a); if (m.type === 'gear') st.b = unwrapNear(turnAngle(world(B, tOf(Ts, m.b))), st.b); }
  }
  // write back: move component bodies to their solved positions
  const out = { ...state, bodies: new Map(state.bodies), components: new Map(state.components) };
  for (const [id, c] of comps) {
    const T = Ts.get(id);
    transforms[id] = T;
    lastSolution.set(id, { src: JSON.stringify(c.T), T });
    for (const [bid, shape] of c.local) out.bodies.set(`${id}/${bid}`, placeShape(shape, T));
    out.components.set(id, { ...c, T });
  }
  active.forEach(({ m, A, B }, i) => report.push({ id: m.id, ok: cur.per[i] < 1e-5, residual: cur.per[i], ...(A.r ? { ra: A.r } : {}), ...(B.r ? { rb: B.r } : {}), ...(conflicts.has(m.id) ? { error: 'Conflicts with the mates before it' } : {}) }));
  return { state: out, assembly: { transforms, mates: report, dof: Math.max(0, n - rank) + 6 * (movable.length - free.length), free: movable.length, iterations } };
}

function solveDense(A, b) {
  const n = b.length, M = A.map((r) => Float64Array.from(r)), x = Float64Array.from(b);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-18) return null;
    [M[c], M[p]] = [M[p], M[c]]; [x[c], x[p]] = [x[p], x[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; if (!f) continue; for (let k = c; k < n; k++) M[r][k] -= f * M[c][k]; x[r] -= f * x[c]; }
  }
  for (let c = n - 1; c >= 0; c--) { let s = x[c]; for (let k = c + 1; k < n; k++) s -= M[c][k] * x[k]; x[c] = s / M[c][c]; }
  return x;
}
function matRank(J, n) {
  const M = J.map((r) => Float64Array.from(r));
  const scale = Math.max(1e-12, ...M.flatMap((r) => Array.from(r, Math.abs)));
  let rank = 0;
  const rows = M.length;
  for (let c = 0; c < n && rank < rows; c++) {
    let p = rank;
    for (let r = rank + 1; r < rows; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < scale * 1e-6) continue;
    [M[rank], M[p]] = [M[p], M[rank]];
    for (let r = rank + 1; r < rows; r++) { const f = M[r][c] / M[rank][c]; for (let k = c; k < n; k++) M[r][k] -= f * M[rank][k]; }
    rank++;
  }
  return rank;
}

// ---------- feature builders ----------
const BUILDERS = {
  component: buildComponent,
  sketch(f, st) {
    const plane = resolvePlaneRef(st, f.p.planeRef) || f.p.plane || STD_PLANES.XY;
    const { sk: data, lost, proj } = reproject(st, migrateSketch(f.p), plane);
    const res = solveSketch(data);
    const geom = sketchGeom(res.sketch);
    st.sketches.set(f.id, { plane, geom, regions: computeRegions(geom), ...(proj ? { proj } : {}) });
    if (!res.ok) return { warning: 'Sketch has conflicting constraints or dimensions' };
    if (lost) return { warning: `${lost} projected edge${lost === 1 ? '' : 's'} could not be found on the changed model; ${lost === 1 ? 'it keeps its' : 'they keep their'} last position` };
  },

  plane(f, st) {
    const { p } = f;
    const base = resolvePlaneRef(st, p.base);
    if (!base) throw new Error('Select a base plane or face');
    let pl = { origin: base.origin.slice(), xDir: base.xDir.slice(), normal: base.normal.slice() };
    if (p.mode === 'offset') {
      pl.origin = add(base.origin, mul(base.normal, p.distance));
    } else if (p.mode === 'angle') {
      const axis = p.axis === 'y' ? yDirOf(base) : base.xDir;
      const a = (p.angle * Math.PI) / 180;
      pl.normal = rotateVec(base.normal, axis, a);
      pl.xDir = p.axis === 'y' ? rotateVec(base.xDir, axis, a) : base.xDir.slice();
      pl.origin = add(base.origin, mul(pl.normal, p.distance || 0));
    } else if (p.mode === 'mid') {
      const b2 = resolvePlaneRef(st, p.base2);
      if (!b2) throw new Error('Select the second plane or face');
      if (Math.abs(dot(base.normal, b2.normal)) < 0.999) throw new Error('Mid plane needs two parallel planes');
      const d2 = dot(sub(b2.origin, base.origin), base.normal);
      pl.origin = add(base.origin, mul(base.normal, d2 / 2));
    }
    st.planes.set(f.id, pl);
  },

  extrude(f, st) {
    const { p } = f;
    const sk = getSketch(st, p.sketch);
    const n = sk.plane.normal;
    if (!p.distance && p.side !== 'two') throw new Error('Distance must not be zero');
    const prof = () => toSketch(sk, p.profiles);
    let shape;
    if (p.side === 'symmetric') {
      const d = Math.abs(p.distance);
      shape = prof().extrude(2 * d).translate(mul(n, -d));
    } else if (p.side === 'two') {
      const a = prof().extrude(p.distance);
      const b = prof().extrude(p.distance2, { extrusionDirection: neg(n) });
      shape = a.fuse(b);
    } else {
      const opts = {};
      if (p.distance < 0) opts.extrusionDirection = neg(n);
      if (p.twist) opts.twistAngle = p.twist;
      shape = prof().extrude(Math.abs(p.distance), opts);
    }
    applyOp(st, f.id, shape, p.op, p.target);
  },

  revolve(f, st) {
    const { p } = f;
    const sk = getSketch(st, p.sketch);
    const ax = revolveAxis(sk, p.axis);
    if (!p.angle) throw new Error('Angle must not be zero');
    const shape = toSketch(sk, p.profiles).revolve(ax.dir, { origin: ax.origin, angle: p.angle });
    applyOp(st, f.id, shape, p.op, p.target);
  },

  loft(f, st) {
    const { p } = f;
    if (p.sketch === p.sketch2) throw new Error('Choose two different sketches');
    const a = getSketch(st, p.sketch), b = getSketch(st, p.sketch2);
    const sa = loopDrawing(largestRegion(a, p.profiles).pieces).sketchOnPlane(mkPlane(a.plane));
    const sb = loopDrawing(largestRegion(b, []).pieces).sketchOnPlane(mkPlane(b.plane));
    applyOp(st, f.id, sa.loftWith(sb, { ruled: !!p.ruled }), p.op, p.target);
  },

  sweep(f, st) {
    const { p } = f;
    const sk = getSketch(st, p.sketch);
    const path = getSketch(st, p.path, 'path');
    if (p.sketch === p.path) throw new Error('Profile and path must be different sketches');
    const spine = pathWire(path);
    const cfg = { frenet: p.orient !== 'fixed', transitionMode: 'round' };
    let shape = null;
    for (const r of pickRegions(sk, p.profiles)) {
      const wireOf = (pieces) => loopDrawing(pieces).sketchOnPlane(mkPlane(sk.plane)).wire;
      let s = genericSweep(wireOf(r.pieces), spine, cfg, false);
      for (const h of r.holes) s = s.cut(genericSweep(wireOf(h.pieces), spine, cfg, false));
      shape = shape ? shape.fuse(s) : s;
    }
    applyOp(st, f.id, shape, p.op, p.target);
  },

  box(f, st) {
    const { p } = f;
    if (p.w <= 0 || p.d <= 0 || p.h <= 0) throw new Error('Dimensions must be positive');
    applyOp(st, f.id, makeBaseBox(p.w, p.d, p.h).translate([p.x, p.y, p.z]), p.op, p.target);
  },

  cylinder(f, st) {
    const { p } = f;
    if (p.r <= 0 || p.h <= 0) throw new Error('Radius and height must be positive');
    applyOp(st, f.id, makeCylinder(p.r, p.h, [p.x, p.y, p.z], AXES[p.axis]), p.op, p.target);
  },

  sphere(f, st) {
    const { p } = f;
    if (p.r <= 0) throw new Error('Radius must be positive');
    applyOp(st, f.id, makeSphere(p.r).translate([p.x, p.y, p.z]), p.op, p.target);
  },

  torus(f, st) {
    const { p } = f;
    if (p.r <= 0 || p.R <= p.r) throw new Error('Major radius must be larger than minor radius');
    const shape = drawCircle(p.r).translate(p.R, 0)
      .sketchOnPlane(new Plane([0, 0, 0], [1, 0, 0], [0, -1, 0]))
      .revolve([0, 0, 1], { origin: [0, 0, 0] })
      .translate([p.x, p.y, p.z]);
    applyOp(st, f.id, shape, p.op, p.target);
  },

  cone(f, st) {
    const { p } = f;
    if (p.h <= 0 || p.r1 < 0 || p.r2 < 0 || (p.r1 === 0 && p.r2 === 0)) throw new Error('Invalid cone dimensions');
    const pts = [[0, 0]];
    if (p.r1 > 0) pts.push([p.r1, 0]);
    if (p.r2 > 0) pts.push([p.r2, p.h]);
    pts.push([0, p.h]);
    const shape = polyDrawing(pts).sketchOnPlane(new Plane([0, 0, 0], [1, 0, 0], [0, -1, 0])).revolve([0, 0, 1], { origin: [0, 0, 0] }).translate([p.x, p.y, p.z]);
    applyOp(st, f.id, shape, p.op, p.target);
  },

  hole(f, st) {
    const { p } = f;
    if (!p.points?.length) throw new Error('Select hole positions on a face');
    const tapped = !!p.tapped && ISO_PITCH[p.tapSize];
    if (tapped) p.diameter = tapDrill(p.tapSize); // the drill size follows the thread
    if (p.diameter <= 0) throw new Error('Diameter must be positive');
    for (const [bodyId, picks] of groupByBody(p.points)) {
      let body = getBody(st, bodyId);
      const bb = bboxOf(body);
      const pts = resolvePicks(body, body.faces, picks, tolFor(body));
      for (let i = 0; i < picks.length; i++) {
        const n = picks[i].n, at = pts[i];
        const start = add(at, mul(n, 0.05));
        // through-all holes span the whole body along the axis, so they survive the face moving
        let tool = p.through
          ? makeCylinder(p.diameter / 2, bb.diag * 4 + 20, add(at, mul(n, bb.diag * 2 + 10)), neg(n))
          : makeCylinder(p.diameter / 2, p.depth + 0.05, start, neg(n));
        if (p.cbore && p.cboreD > p.diameter) tool = tool.fuse(makeCylinder(p.cboreD / 2, p.cboreDepth + 0.05, start, neg(n)));
        if (p.csink && p.csinkD > p.diameter) {
          // countersink: cone from the face, 90° included angle
          const h = (p.csinkD - p.diameter) / 2;
          const cone = polyDrawing([[0, 0], [p.csinkD / 2, 0], [p.diameter / 2, -h], [0, -h]])
            .sketchOnPlane(new Plane([0, 0, 0], [1, 0, 0], [0, -1, 0])).revolve([0, 0, 1], { origin: [0, 0, 0] });
          tool = tool.fuse(alignShape(cone, [0, 0, 1], n, [0, 0, 0]).translate(add(at, mul(n, 0.001))));
        }
        body = body.cut(tool);
        if (tapped) {
          // modelled thread from just outside the face to the thread depth (or right through)
          const pitch = ISO_PITCH[p.tapSize];
          const tdepth = p.through ? bb.diag * 2 + 10 : Math.min(p.threadDepth > 0 ? p.threadDepth : p.depth, p.depth);
          body = cutThread(body, { start: add(at, mul(n, pitch)), axis: neg(unit(n)), r: p.diameter / 2, pitch, len: tdepth + pitch, external: false, left: p.hand === 'left' });
        }
      }
      st.bodies.set(bodyId, body);
    }
  },

  fillet(f, st) { edgeMod(f, st, 'fillet', f.p.radius); },
  chamfer(f, st) { edgeMod(f, st, 'chamfer', f.p.distance); },

  shell(f, st) {
    const { p } = f;
    if (!p.faces?.length) throw new Error('Select at least one face to remove');
    if (p.thickness <= 0) throw new Error('Thickness must be positive');
    for (const [bodyId, picks] of groupByBody(p.faces)) {
      const body = getBody(st, bodyId);
      const tol = tolFor(body);
      const t = p.dir === 'outside' ? -p.thickness : p.thickness; // replicad: positive = inward
      const faces = body.faces;
      const pts = resolvePicks(body, faces, picks, tol, { expand: true });
      if (!faces.some((fc) => pts.some((q) => near(fc, q, tol)))) throw new Error('The selected faces no longer exist - edit this feature and reselect them');
      st.bodies.set(bodyId, body.shell(t, (finder) => finder.when(({ element }) => pts.some((q) => near(element, q, tol)))));
    }
  },

  presspull(f, st) {
    const { p } = f;
    if (!p.faces?.length) throw new Error('Select planar faces to push or pull');
    if (!p.distance) throw new Error('Distance must not be zero');
    for (const [bodyId, picks] of groupByBody(p.faces)) {
      let body = getBody(st, bodyId);
      const tools = picks.map((pk) => {
        const { face } = pickedFace(st, pk);
        if (face.geomType !== 'PLANE') throw new Error('Press Pull works on planar faces');
        return basicFaceExtrusion(face, new Vector(mul(unit(pk.n), p.distance)));
      });
      for (const tool of tools) body = p.distance > 0 ? body.fuse(tool) : body.cut(tool);
      st.bodies.set(bodyId, body);
    }
  },

  draft(f, st) {
    const { p } = f;
    if (!p.faces?.length) throw new Error('Select faces to draft');
    const pl = resolvePlaneRef(st, p.plane) || STD_PLANES.XY;
    for (const [bodyId, picks] of groupByBody(p.faces)) {
      const body = getBody(st, bodyId);
      const tol = tolFor(body);
      const pts = resolvePicks(body, body.faces, picks, tol, { expand: true });
      st.bodies.set(bodyId, body.draft(p.angle, (finder) => finder.when(({ element }) => pts.some((q) => near(element, q, tol))), mkPlane(pl)));
    }
  },

  split(f, st) {
    const { p } = f;
    const body = getBody(st, p.body);
    const pl = resolvePlaneRef(st, p.plane);
    if (!pl) throw new Error('Select a splitting plane');
    const bb = bboxOf(body);
    const S = bb.diag * 2 + 100;
    const y = yDirOf(pl), d = sub(bb.center, pl.origin);
    const cu = dot(d, pl.xDir), cv = dot(d, y);
    const half = polyDrawing([[cu - S, cv - S], [cu + S, cv - S], [cu + S, cv + S], [cu - S, cv + S]]).sketchOnPlane(mkPlane(pl)).extrude(S);
    const above = body.intersect(half), below = body.cut(half);
    const amount = hasSolid(body) ? measureVolume : measureArea;
    const va = amount(above), vb = amount(below);
    if (va < 1e-9 || vb < 1e-9) throw new Error('The plane does not cut through the body');
    st.bodies.set(p.body, below);
    st.bodies.set(`${f.id}#0`, above);
  },

  combine(f, st) {
    const { p } = f;
    let t = getBody(st, p.target, 'Target body');
    const tools = (p.tools || []).filter((id) => id !== p.target);
    if (!tools.length) throw new Error('Select tool bodies');
    for (const id of tools) {
      const tool = getBody(st, id, 'Tool body');
      t = p.op === 'join' ? t.fuse(tool) : p.op === 'cut' ? t.cut(tool) : t.intersect(tool);
      if (!p.keep) st.bodies.delete(id);
    }
    st.bodies.set(p.target, t);
  },

  move(f, st) {
    const { p } = f;
    if (!p.bodies?.length) throw new Error('Select bodies to move');
    p.bodies.forEach((id, i) => {
      let s = getBody(st, id).clone();
      const c = p.pivot === 'origin' ? [0, 0, 0] : bboxOf(s).center;
      if (p.rx) s = s.rotate(p.rx, c, [1, 0, 0]);
      if (p.ry) s = s.rotate(p.ry, c, [0, 1, 0]);
      if (p.rz) s = s.rotate(p.rz, c, [0, 0, 1]);
      if (p.dx || p.dy || p.dz) s = s.translate([p.dx, p.dy, p.dz]);
      st.bodies.set(p.copy ? `${f.id}#${i}` : id, s);
    });
  },

  scale(f, st) {
    const { p } = f;
    if (!p.bodies?.length) throw new Error('Select bodies');
    if (p.factor <= 0) throw new Error('Scale factor must be positive');
    for (const id of p.bodies) {
      const s = getBody(st, id).clone();
      st.bodies.set(id, s.scale(p.factor, p.pivot === 'origin' ? [0, 0, 0] : bboxOf(s).center));
    }
  },

  mirror(f, st) {
    const { p } = f;
    if (!p.bodies?.length) throw new Error('Select bodies to mirror');
    let pl = resolvePlaneRef(st, p.plane) || STD_PLANES.YZ;
    if (p.offset) pl = { ...pl, origin: add(pl.origin, mul(pl.normal, p.offset)) };
    p.bodies.forEach((id, i) => {
      const src = getBody(st, id);
      const m = src.clone().mirror(pl.normal, pl.origin);
      if (p.join) st.bodies.set(id, src.fuse(m));
      else st.bodies.set(`${f.id}#${i}`, m);
    });
  },

  rpattern(f, st) {
    const { p } = f;
    if (!p.bodies?.length) throw new Error('Select bodies to pattern');
    const n1 = Math.max(1, Math.round(p.count1));
    const n2 = p.dir2 === 'none' ? 1 : Math.max(1, Math.round(p.count2));
    if (n1 * n2 > 400) throw new Error('Too many instances (max 400)');
    const d1 = AXES[p.dir1], d2 = p.dir2 === 'none' ? [0, 0, 0] : AXES[p.dir2];
    p.bodies.forEach((id, bi) => {
      const src = getBody(st, id);
      let acc = src;
      let k = 0;
      for (let i = 0; i < n1; i++) for (let j = 0; j < n2; j++) {
        if (!i && !j) continue;
        const inst = src.clone().translate(add(mul(d1, i * p.spacing1), mul(d2, j * (p.spacing2 || 0))));
        if (p.join) acc = acc.fuse(inst);
        else st.bodies.set(`${f.id}#${bi}_${k++}`, inst);
      }
      if (p.join) st.bodies.set(id, acc);
    });
  },

  cpattern(f, st) {
    const { p } = f;
    if (!p.bodies?.length) throw new Error('Select bodies to pattern');
    const n = Math.max(1, Math.round(p.count));
    if (n > 360) throw new Error('Too many instances (max 360)');
    const full = Math.abs(Math.abs(p.angle) - 360) < 1e-6;
    const step = full ? p.angle / n : p.angle / Math.max(1, n - 1);
    p.bodies.forEach((id, bi) => {
      const src = getBody(st, id);
      let acc = src;
      for (let i = 1; i < n; i++) {
        const inst = src.clone().rotate(step * i, [p.cx, p.cy, p.cz], AXES[p.axis]);
        if (p.join) acc = acc.fuse(inst);
        else st.bodies.set(`${f.id}#${bi}_${i}`, inst);
      }
      if (p.join) st.bodies.set(id, acc);
    });
  },

  // copies of bodies spaced along a sketch path, keeping their orientation or turning with the path
  ppattern(f, st) {
    const { p } = f;
    if (!p.bodies?.length) throw new Error('Select bodies to pattern');
    const sk = getSketch(st, p.path, 'path');
    const path = pathPolyline(sk);
    if (path.len < 1e-6) throw new Error('The path has no length');
    const n = Math.max(1, Math.round(p.count));
    if (n > 400) throw new Error('Too many instances (max 400)');
    let step;
    if (p.mode === 'spacing') {
      step = p.spacing;
      if (!(step > 0)) throw new Error('Spacing must be more than zero');
    } else step = path.closed ? path.len / n : path.len / Math.max(1, n - 1);
    const pl = sk.plane, y = yDirOf(pl);
    const to3 = (q) => add(pl.origin, add(mul(pl.xDir, q[0]), mul(y, q[1])));
    const start = path.at(0), P0 = to3(start.p);
    let warned = 0;
    p.bodies.forEach((id, bi) => {
      const src = getBody(st, id);
      let acc = src;
      for (let i = 1; i < n; i++) {
        const s = i * step;
        if (s > path.len + 1e-9) { warned++; continue; }
        const q = path.at(s), turn = p.orient === 'follow' ? ((q.ang - start.ang) * 180) / Math.PI : 0;
        let inst = src.clone();
        if (Math.abs(turn) > 1e-9) inst = inst.rotate(turn, P0, pl.normal);
        inst = inst.translate(sub(to3(q.p), P0));
        if (p.join) acc = acc.fuse(inst);
        else st.bodies.set(`${f.id}#${bi}_${i}`, inst);
      }
      if (p.join) st.bodies.set(id, acc);
    });
    if (warned) return { warning: `${warned / p.bodies.length} instance${warned / p.bodies.length === 1 ? '' : 's'} would fall past the end of the path and ${warned / p.bodies.length === 1 ? 'was' : 'were'} left out` };
  },

  joint(f, st) {
    const { p } = f;
    if (!p.moving?.length || !p.fixed?.length) throw new Error('Select a face on the moving body and a face to attach it to');
    const A = p.moving[0], B = p.fixed[0];
    if (A.body === B.body) throw new Error('Pick faces on two different bodies');
    const fa = faceFrame(st, A), fb = faceFrame(st, B);
    let target = fa.kind === 'plane' && fb.kind === 'plane' ? neg(fb.normal) : fb.normal;
    if (p.flip) target = neg(target);
    let s = getBody(st, A.body).clone();
    s = alignShape(s, fa.normal, target, fa.center);
    const spin = p.type === 'rigid' || p.type === 'slider' || p.type === 'revolute' ? p.angle || 0 : 0;
    if (spin) s = s.rotate(spin, fa.center, fb.normal);
    const slide = p.offset || 0;
    s = s.translate(sub(add(fb.center, mul(fb.normal, slide)), fa.center));
    st.bodies.set(A.body, s);
    st.joints.set(f.id, { body: A.body, type: p.type, origin: add(fb.center, mul(fb.normal, slide)), axis: fb.normal });
  },

  remove(f, st) {
    for (const id of f.p.bodies || []) st.bodies.delete(id);
  },

  // ---------- threads & springs ----------
  thread(f, st) {
    const { p } = f;
    if (!p.face?.length) throw new Error('Select a cylindrical face');
    const { body, face, q } = pickedFace(st, p.face[0]);
    if (face.geomType !== 'CYLINDRE') throw new Error('Threads need a cylindrical face (a shaft or a hole)');
    const cyl = cylinderOf(face);
    const pitch = p.size === 'custom' ? p.pitch : ISO_PITCH[p.size];
    if (!(pitch > 0)) throw new Error('Pitch must be positive');
    // external (shaft) if the face normal points away from the axis, internal (hole) otherwise
    const radial = sub(q, add(cyl.center, mul(cyl.axis, dot(sub(q, cyl.center), cyl.axis))));
    const external = dot(radial, p.face[0].n) > 0;
    const span = cyl.v1 - cyl.v0;
    const full = p.full !== false || !(p.length > 0);
    let len = full ? span - (p.offset || 0) : Math.min(p.length, span - (p.offset || 0));
    if (len < pitch) throw new Error('The face is shorter than one thread pitch');
    const axis = p.flip ? neg(cyl.axis) : cyl.axis;
    // a thread that reaches an end of the face runs out one pitch past it, so the groove cuts cleanly
    const runIn = (p.offset || 0) < 1e-9 ? pitch : 0, runOut = full ? pitch : 0;
    len += runIn + runOut;
    const start = add(cyl.center, mul(cyl.axis, p.flip ? cyl.v1 - (p.offset || 0) + runIn : cyl.v0 + (p.offset || 0) - runIn));
    const r = cyl.radius;
    const d = 0.6134 * pitch * (p.depthScale || 1);
    st.bodies.set(p.face[0].body, cutThread(body, { start, axis, r, pitch, len, external, left: p.hand === 'left', depth: d }));
    const nominal = Object.entries(ISO_DIA).find(([k]) => k === p.size)?.[1];
    const dia = external ? 2 * r : 2 * (r + d);
    if (p.size !== 'custom' && nominal && Math.abs(dia - nominal) > nominal * 0.06) return { warning: `${p.size} expects Ø${nominal} mm; this ${external ? 'shaft' : 'hole'} gives Ø${dia.toFixed(2)} mm` };
  },

  async text(f, st) {
    const { p } = f;
    const plane = resolvePlaneRef(st, p.plane) || STD_PLANES.XY;
    if (p.font && p.font !== 'builtin' && !fontLoaded(p.font)) throw new Error('The font for this text is missing. Choose it again in the Font list.');
    const cut = p.op === 'cut';
    if (!(p.depth > 0)) throw new Error('Depth must be positive');
    const solid = await textSolid({
      text: p.text, height: p.height, plane: { origin: plane.origin, xDir: plane.xDir, normal: unit(plane.normal) },
      x: p.x, y: p.y, angle: p.angle, align: p.align, spacing: p.height > 0 ? (p.spacing || 0) / p.height : 0,
      weight: { thin: 0.09, regular: 0.125, bold: 0.17 }[p.weight] || 0.125,
      // engraving starts just above the face and goes down into the body
      depth: cut ? -(p.depth + 0.05) : p.depth, start: cut ? 0.05 : 0, font: p.font,
    });
    applyOp(st, f.id, solid, p.op, p.target);
  },

  coil(f, st) {
    const { p } = f;
    if (!(p.radius > 0) || !(p.pitch > 0) || !(p.turns > 0) || !(p.section > 0)) throw new Error('Radius, pitch, turns and wire diameter must be positive');
    if (p.section >= p.pitch) throw new Error('Wire diameter must be smaller than the pitch, or the coils overlap');
    if (p.section / 2 >= p.radius) throw new Error('Wire diameter is too large for the coil radius');
    const dir = AXES[p.axis] || AXES.Z, c = [p.x, p.y, p.z];
    const helix = makeHelix(p.pitch, p.pitch * p.turns, p.radius, c, dir, p.hand === 'left');
    const e = helix.edges[0];
    const S = vxyz(e.startPoint), tg = vxyz(e.tangentAt(0));
    const rad = unit(sub(S, add(c, mul(dir, dot(sub(S, c), dir)))));
    const prof = drawCircle(p.section / 2).sketchOnPlane(new Plane(S, rad, unit(tg))).wire;
    const spring = genericSweep(prof, helix, { frenet: true }, false);
    applyOp(st, f.id, spring, p.op, p.target);
  },

  // ---------- sheet metal ----------
  sheetbase(f, st) {
    const { p } = f;
    const sk = getSketch(st, p.sketch);
    const reg = largestRegion(sk, p.profiles);
    if (!(p.thickness > 0)) throw new Error('Thickness must be positive');
    if (!(p.bendRadius >= 0)) throw new Error('Bend radius cannot be negative');
    if (!(p.kfactor >= 0 && p.kfactor <= 0.5)) throw new Error('K-factor must be between 0 and 0.5');
    const n = unit(sk.plane.normal);
    const plane = { origin: add(sk.plane.origin, mul(n, p.flip ? -p.thickness : 0)), xDir: sk.plane.xDir, normal: n };
    st.bodies.set(f.id, regionDrawing(reg).sketchOnPlane(mkPlane(plane)).extrude(p.thickness));
    const outer = loopSignedArea(reg.pieces) < 0 ? reg.pieces.slice().reverse().map(reversePiece) : reg.pieces;
    st.sheets.set(f.id, { plane, T: p.thickness, R: p.bendRadius, K: p.kfactor, outer, holes: reg.holes.map((h) => h.pieces), flanges: [] });
  },

  flange(f, st) {
    const { p } = f;
    if (!p.edges?.length) throw new Error('Select outside edges of a sheet metal base');
    if (!(p.angle > 0 && p.angle < 180)) throw new Error('Bend angle must be between 0° and 180°');
    if (!(p.length >= 0)) throw new Error('Flange length cannot be negative');
    for (const [bodyId, picks] of groupByBody(p.edges)) {
      let sh = st.sheets.get(bodyId);
      if (!sh) throw new Error('Flanges go on the edges of a Sheet Metal Base body');
      let body = getBody(st, bodyId);
      const pts = resolvePicks(body, body.edges, picks, tolFor(body));
      let k = 0;
      for (const q of pts) {
        const hit = sheetEdgeAt(sh, q);
        if (!hit) throw new Error('Pick a straight outside edge of the base plate or of a flange');
        if (sh.flanges.some((fl) => (fl.parent || 'base') === hit.pid && fl.seg === hit.seg)) throw new Error('That edge already has a flange');
        const fl = { seg: hit.seg, parent: hit.pid, angle: p.angle, length: p.length, up: p.dir !== 'down', inset0: p.inset || 0, inset1: p.inset || 0, id: `${f.id}#${k++}` };
        body = body.fuse(flangeSolid(sheetPanels(sh).get(hit.pid), fl));
        sh = { ...sh, flanges: [...sh.flanges, fl] }; // copy: cached states share the old entry
      }
      st.bodies.set(bodyId, body);
      st.sheets.set(bodyId, sh);
    }
  },

  // ---------- free-form NURBS ----------
  cvcurve(f, st) {
    const { p } = f;
    const cvs = (p.cvs || []).filter((c) => c.every(Number.isFinite));
    if (cvs.length < 2) throw new Error('A CV curve needs at least two control vertices');
    const closed = !!p.closed && cvs.length >= 3;
    const deg = Math.max(1, Math.min(+p.degree || 3, cvs.length - 1, 7));
    const edge = bsplineEdge(cvs, deg, closed);
    st.curves.set(f.id, { wire: assembleWire([edge]), plane: fitPlane(cvs), cvs, degree: deg, closed });
  },

  cvsurface(f, st) {
    const { p } = f;
    const deg = +p.degree || 3;
    // edited CVs are used while the grid size / degree still match the dialog values
    const sizeOk = p.cv && p.cv.poles?.length === p.cv.nu * p.cv.nv;
    let cv = sizeOk && (p.source === 'face' && p.method !== 'fit' ? p.cv.exact : p.cv.nu === Math.round(p.nu) && p.cv.nv === Math.round(p.nv) && (p.source === 'face' || +p.cv.du === deg)) ? p.cv : null;
    let out = null, warning = null;
    if (p.source === 'face') {
      if (!p.face?.length) throw new Error('Select a face to rebuild');
      const { face, body } = pickedFace(st, p.face[0]);
      const exact = p.method !== 'fit';
      // exact rebuilds keep the CV count of the original NURBS; edits are kept while the face is unchanged
      if (exact) {
        if (cv && !(p.cv.exact)) cv = null;
        if (!cv) {
          cv = exactFaceCV(face);
          if (!cv) { cv = fitFaceCV(face, Math.max(p.nu, 12), Math.max(p.nv, 12), 3, true); warning = 'This face type has no exact NURBS form here, so it was refitted densely'; }
          if (!p.cv) out = face.clone(); // untouched: keep the original face exactly
        }
      } else if (!cv || cv.exact) cv = fitFaceCV(face, p.nu, p.nv, deg, true);
      if (!out) {
        const dev = faceDeviation(face, cvFace(cv));
        if (!cv.edited && dev > Math.max(bboxOf(face).diag * 1e-4, 1e-3)) warning = `Refit deviates from the original by up to ${dev.toFixed(3)} mm. Increase the CV counts for a closer fit`;
      }
      if (p.replace) {
        const rest = body.faces.filter((x) => !x.isSame(face));
        if (rest.length) st.bodies.set(p.face[0].body, joinSurfaces(rest)); else st.bodies.delete(p.face[0].body);
      }
    }
    if (!cv) cv = planeCV(resolvePlaneRef(st, p.plane) || STD_PLANES.XY, p.w, p.l, p.nu, p.nv, deg);
    st.bodies.set(f.id, out || cvFace(cv));
    st.cvgrids.set(f.id, cv);
    if (warning) return { warning };
  },

  surffillet(f, st) {
    const { p } = f;
    if (!p.a?.length || !p.b?.length) throw new Error('Pick the part of each surface to keep');
    if (!(p.radius > 0)) throw new Error('Radius must be positive');
    const A = pickedFace(st, p.a[0]), B = pickedFace(st, p.b[0]);
    if (A.face.isSame(B.face)) throw new Error('Pick two different surfaces');
    const variable = p.rmode === 'variable';
    const r2 = variable ? p.radius2 : p.radius;
    const rm = variable && p.law === 'mid' ? p.radiusMid : (p.radius + r2) / 2;
    if (!(r2 > 0) || !(rm > 0)) throw new Error('Fillet sizes must be positive');
    const res = surfaceFillet(A.face, B.face, p.a[0].p, p.b[0].p, { r0: p.radius, r1: r2, rm, shape: variable ? p.law || 'linear' : 'linear', flip: !!p.flip, chord: p.size === 'chord' });
    const restA = A.body.faces.filter((x) => !x.isSame(A.face));
    const restB = p.a[0].body === p.b[0].body ? [] : B.body.faces.filter((x) => !x.isSame(B.face));
    const sewn = sew([...restA, ...restB, res.a, res.fillet, res.b], Math.max(Math.min(p.radius, r2) * 0.01, 0.02));
    if (p.a[0].body !== p.b[0].body) st.bodies.delete(p.b[0].body);
    st.bodies.set(p.a[0].body, sewn.shape);
    if (sewn.gaps) return { warning: 'The fillet could not be sewn to both surfaces everywhere; check the result with Zebra' };
  },

  surftrim(f, st) {
    const { p } = f;
    if (!p.target?.length) throw new Error('Pick the surface to trim');
    if (!p.sketch) throw new Error('Pick the trimming curve');
    const { body, face } = pickedFace(st, p.target[0]);
    const src = curveSource(st, p.sketch, 'trim');
    const oc = getOC();
    const n = p.dir === 'view' && p.viewDir?.length === 3 && len(p.viewDir) > 1e-9 ? unit(p.viewDir) : p.dir && AXES[p.dir] ? AXES[p.dir] : src.plane.normal;
    const L = bboxOf(body).diag * 2 + 50;
    let pieces = [face];
    for (const w of src.wires) {
      const cutter = shapeOf(new oc.BRepPrimAPI_MakePrism(w.wrapped, new Vector(mul(n, 2 * L)).wrapped, false, true)).translate(mul(n, -L));
      pieces = pieces.flatMap((pc) => splitShape(pc, cutter).faces);
    }
    if (pieces.length < 2) throw new Error('The curve does not cut across this surface (projected along the curve plane normal)');
    const keepPt = p.target[0].p;
    const hit = pieces.map((pc) => [pc, measureDistanceBetween(pc, makeVertex(keepPt))]).sort((x, y) => x[1] - y[1])[0][0];
    const kept = p.mode === 'remove' ? pieces.filter((pc) => pc !== hit) : [hit];
    const rest = body.faces.filter((x) => !x.isSame(face));
    st.bodies.set(p.target[0].body, joinSurfaces([...rest, ...kept]));
  },

  // ---------- surface modelling ----------
  surfextrude(f, st) {
    const { p } = f;
    const src = curveSource(st, p.sketch, 'curve');
    if (!p.distance) throw new Error('Distance must not be zero');
    const oc = getOC();
    const n = p.dir && AXES[p.dir] ? AXES[p.dir] : src.plane.normal;
    const total = p.side === 'symmetric' ? 2 * Math.abs(p.distance) : p.distance;
    const shapes = src.wires.map((w) => {
      const s = shapeOf(new oc.BRepPrimAPI_MakePrism(w.wrapped, new Vector(mul(n, total)).wrapped, false, true));
      return p.side === 'symmetric' ? s.translate(mul(n, -Math.abs(p.distance))) : s;
    });
    st.bodies.set(f.id, joinSurfaces(shapes));
  },

  surfrevolve(f, st) {
    const { p } = f;
    const src = curveSource(st, p.sketch, 'curve');
    if (!p.angle) throw new Error('Angle must not be zero');
    const oc = getOC();
    const ax = revolveAxis(src, p.axis);
    const shapes = src.wires.map((w) => shapeOf(new oc.BRepPrimAPI_MakeRevol(w.wrapped, makeAx1(ax.origin, ax.dir), (p.angle * Math.PI) / 180, false)));
    st.bodies.set(f.id, joinSurfaces(shapes));
  },

  surfloft(f, st) {
    const { p } = f;
    const ids = p.sections || [];
    if (ids.length < 2) throw new Error('Pick at least two section curves, in order');
    const wires = ids.map((id) => singleWire(st, id, 'section'));
    let shape;
    try { shape = loft(wires, { ruled: !!p.ruled }, true); } catch { throw new Error('Could not skin through these sections. They must be all open or all closed curves'); }
    st.bodies.set(f.id, shape);
  },

  surfsweep(f, st) {
    const { p } = f;
    if (p.sketch === p.path) throw new Error('Profile and rail must be different sketches');
    const spine = railWire(st, p.path);
    const oc = getOC();
    const shapes = curveSource(st, p.sketch, 'profile').wires.map((w) => {
      const mk = new oc.BRepOffsetAPI_MakePipeShell(spine.wrapped);
      mk.SetMode(p.orient !== 'fixed');
      mk.SetTransitionMode(oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RoundCorner);
      mk.Add(w.wrapped, false, false);
      mk.Build();
      if (!mk.IsDone()) { mk.delete(); throw new Error('Could not sweep the profile along this rail'); }
      return shapeOf(mk);
    });
    st.bodies.set(f.id, joinSurfaces(shapes));
  },

  patch(f, st) {
    const { p } = f;
    const oc = getOC();
    const fill = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 0.01, 0.1, 8, 9);
    let n = 0;
    for (const id of p.sections || []) for (const w of curveSource(st, id, 'boundary').wires) for (const e of w.edges) { fill.Add(e.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, true); n++; }
    for (const pk of p.edges || []) {
      const { edge, face } = pickedEdge(st, pk);
      if (p.cont === 'G1' && face) fill.Add(edge.wrapped, face.wrapped, oc.GeomAbs_Shape.GeomAbs_G1, true);
      else fill.Add(edge.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, true);
      n++;
    }
    if (!n) { fill.delete(); throw new Error('Pick boundary curves or edges that form a closed loop'); }
    let ok = false;
    try { fill.Build(); ok = fill.IsDone(); } catch { ok = false; }
    if (!ok) { fill.delete(); throw new Error('Could not fill the boundary. Make sure it forms one closed loop'); }
    st.bodies.set(f.id, shapeOf(fill));
  },

  surfoffset(f, st) {
    const { p } = f;
    if (!p.faces?.length) throw new Error('Select faces to offset');
    if (!p.distance) throw new Error('Distance must not be zero');
    const oc = getOC();
    const faces = p.faces.map((pk) => pickedFace(st, pk).face);
    const src = joinSurfaces(faces.map((x) => x.clone()));
    const mk = new oc.BRepOffsetAPI_MakeOffsetShape();
    mk.PerformBySimple(src.wrapped, p.distance);
    st.bodies.set(f.id, shapeOf(mk));
  },

  thicken(f, st) {
    const { p } = f;
    let base = getBody(st, p.body, 'Surface body');
    if (hasSolid(base)) throw new Error('Thicken works on surface bodies. Use Shell to hollow a solid');
    if (!(p.thickness > 0)) throw new Error('Thickness must be positive');
    const oc = getOC();
    let t = p.thickness;
    if (p.side === 'both') {
      const off = new oc.BRepOffsetAPI_MakeOffsetShape();
      off.PerformBySimple(base.wrapped, -t / 2);
      base = shapeOf(off);
    } else if (p.side === 'in') t = -t;
    const mk = new oc.BRepOffsetAPI_MakeThickSolid();
    mk.MakeThickSolidBySimple(base.wrapped, t);
    mk.Build();
    const s = outward(shapeOf(mk));
    if (!hasSolid(s)) throw new Error('Could not thicken this surface');
    st.bodies.set(p.body, s);
  },

  stitch(f, st) {
    const { p } = f;
    const ids = (p.bodies || []).filter((id) => st.bodies.has(id));
    if (!ids.length) throw new Error('Select surface bodies to stitch');
    const oc = getOC();
    const sew = new oc.BRepBuilderAPI_Sewing(p.tolerance > 0 ? p.tolerance : 0.01, true, true, true, false);
    for (const id of ids) sew.Add(st.bodies.get(id).wrapped);
    sew.Perform();
    const free = sew.NbFreeEdges();
    let res = cast(downcast(sew.SewedShape()));
    sew.delete();
    if (!free && res instanceof Shell) {
      const fix = new oc.ShapeFix_Solid();
      const sol = cast(fix.SolidFromShell(res.wrapped));
      fix.delete();
      res = outward(sol);
    }
    for (const id of ids) st.bodies.delete(id);
    st.bodies.set(ids[0], res);
    if (free) return { warning: `${free} open edge${free === 1 ? '' : 's'} remain, so the result is a surface, not a solid` };
  },

  async import(f, st) {
    const { p } = f;
    const bin = Uint8Array.from(atob(p.data), (c) => c.charCodeAt(0));
    const blob = new Blob([bin]);
    const shape = p.format === 'stl' ? await importSTLShape(blob) : await importSTEP(blob);
    st.bodies.set(f.id, shape);
  },
};

// STL → B-rep: OpenCascade reads the triangles as loose faces, so they are sewn into a shell, coplanar
// triangles are merged, and a closed shell becomes a solid. Open meshes come in as surface bodies.
async function importSTLShape(blob) {
  const oc = getOC();
  const name = `stl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.stl`;
  oc.FS.writeFile(`/${name}`, new Uint8Array(await blob.arrayBuffer()));
  const reader = new oc.StlAPI_Reader(), raw = new oc.TopoDS_Shell();
  let ok = false;
  try { ok = reader.Read(raw, name); } finally { oc.FS.unlink(`/${name}`); reader.delete(); }
  if (!ok) throw new Error('This STL file could not be read');
  const faces = cast(raw).faces;
  if (!faces.length) throw new Error('The STL file has no triangles');
  let shell;
  try { shell = weldShellsAndFaces(faces, true); } catch { return cast(raw); }
  if (faces.length <= 200000) {
    try {
      const u = new oc.ShapeUpgrade_UnifySameDomain(shell.wrapped, true, true, false);
      u.Build();
      const merged = cast(u.Shape());
      u.delete();
      if (merged instanceof Shell) shell = merged;
    } catch { /* keep the unmerged shell */ }
  }
  if (!(shell instanceof Shell)) return shell;
  try {
    const fix = new oc.ShapeFix_Solid();
    const solid = cast(fix.SolidFromShell(shell.wrapped));
    fix.delete();
    if (solid && measureVolume(solid) > 0) return solid;
  } catch { /* open shell */ }
  return shell;
}

function edgeMod(f, st, kind, r) {
  const picks = f.p.edges;
  if (!picks?.length) throw new Error('Select edges');
  if (!(r > 0)) throw new Error('Size must be positive');
  for (const [bodyId, list] of groupByBody(picks)) {
    const body = getBody(st, bodyId);
    const tol = tolFor(body);
    const edges = body.edges;
    const pts = resolvePicks(body, edges, list, tol, { expand: true });
    if (!edges.some((e) => pts.some((p) => near(e, p, tol)))) throw new Error('The selected edges no longer exist - edit this feature and reselect them');
    const pickFn = (edge) => (pts.some((p) => near(edge, p, tol)) ? r : null);
    st.bodies.set(bodyId, kind === 'fillet' ? body.fillet(pickFn) : body.chamfer(pickFn));
  }
}

// ---------- rebuild with prefix cache ----------
const mainCache = []; // [{ key, state, error }]

export const emptyState = () => ({ bodies: new Map(), sketches: new Map(), planes: new Map(), joints: new Map(), curves: new Map(), cvgrids: new Map(), sheets: new Map(), components: new Map() });
const cloneState = (s) => ({ bodies: new Map(s.bodies), sketches: new Map(s.sketches), planes: new Map(s.planes), joints: new Map(s.joints), curves: new Map(s.curves), cvgrids: new Map(s.cvgrids), sheets: new Map(s.sheets), components: new Map(s.components || []) });

/**
 * Replays features. Returns { states, errors, warnings } where states[i] is the state after
 * feature i (suppressed / failed features leave the state unchanged).
 */
export async function rebuild(features, cache = mainCache) {
  let state = emptyState();
  let key = 0;
  const states = [], errors = {}, warnings = {};
  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    key = hashStr(JSON.stringify(f), key);
    const c = cache[i];
    if (c && c.key === key) {
      state = c.state;
      if (c.error) errors[f.id] = c.error;
      if (c.warning) warnings[f.id] = c.warning;
    } else {
      const s = cloneState(state);
      let error = null, warning = null;
      if (!f.suppressed) {
        try {
          if (f.resolveError) throw new Error(f.resolveError);
          const b = BUILDERS[f.type];
          if (!b) throw new Error(`Unknown feature ${f.type}`);
          const out = await b(f, s);
          if (out?.warning) { warning = out.warning; warnings[f.id] = warning; }
          state = s;
        } catch (e) {
          error = errMsg(e);
          errors[f.id] = error;
        }
      }
      cache.length = i; // invalidate the cache from here on
      cache[i] = { key, state, error, warning };
    }
    states.push(state);
  }
  cache.length = features.length;
  return { states, errors, warnings };
}

// ---------- meshing ----------
const meshCache = new WeakMap();
let uidCounter = 1;
export function shapeUid(shape) {
  let m = meshCache.get(shape);
  if (!m) { m = { uid: uidCounter++ }; meshCache.set(shape, m); }
  return m.uid;
}

export function meshShape(shape) {
  const m = meshCache.get(shape) || { uid: shapeUid(shape) };
  if (!m.mesh) {
    const bb = bboxOf(shape);
    const tolerance = Math.min(Math.max(bb.diag * 4e-4, 0.005), 0.5);
    const face = shape.mesh({ tolerance, angularTolerance: 0.12 });
    const edges = shape.meshEdges({ tolerance, angularTolerance: 0.12 });
    m.mesh = {
      vertices: new Float32Array(face.vertices),
      normals: new Float32Array(face.normals),
      triangles: new Uint32Array(face.triangles),
      faceGroups: face.faceGroups,
      lines: new Float32Array(edges.lines),
      edgeGroups: edges.edgeGroups,
      bbox: [bb.lo, bb.hi],
    };
    meshCache.set(shape, m);
  }
  return m;
}

export function properties(shape) {
  const bb = bboxOf(shape);
  let com = bb.center, inertia = null;
  try {
    const vp = measureShapeVolumeProperties(shape);
    com = vp.centerOfMass;
    inertia = inertiaOf(vp.wrapped, com);
  } catch { /* keep bbox center */ }
  return { volume: measureVolume(shape), area: measureArea(shape), bbox: [bb.lo, bb.hi], centerOfMass: com, inertia };
}

// Inertia tensor about the centre of mass, for unit density (mm⁵; multiply by density for mass inertia).
// This kernel build can't return OpenCascade's matrix, but it gives the moment about any axis, I(d) = dᵀJd:
// three axes give the diagonal, and the three diagonals between them give the products. Principal moments
// and axes come from the symmetric 3×3 eigen-decomposition.
function inertiaOf(props, c) {
  const I = (d) => { const l = Math.hypot(...d), ax = makeAx1(c, d.map((v) => v / l)); try { return props.MomentOfInertia(ax); } finally { ax.delete(); } };
  const xx = I([1, 0, 0]), yy = I([0, 1, 0]), zz = I([0, 0, 1]);
  const xy = I([1, 1, 0]) - (xx + yy) / 2, yz = I([0, 1, 1]) - (yy + zz) / 2, zx = I([1, 0, 1]) - (zz + xx) / 2;
  const J = [[xx, xy, zx], [xy, yy, yz], [zx, yz, zz]];
  const { values, vectors } = sym3Eigen(J);
  const order = [0, 1, 2].sort((a, b) => values[a] - values[b]);
  return { tensor: J, principal: order.map((i) => ({ moment: values[i], axis: vectors[i] })) };
}
function sym3Eigen(A0) {
  const A = A0.map((r) => r.slice()), V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += A[p][q] ** 2;
    if (off < 1e-30 * (A[0][0] ** 2 + A[1][1] ** 2 + A[2][2] ** 2 + 1e-300)) break;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) {
      if (Math.abs(A[p][q]) < 1e-300) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), cs = 1 / Math.sqrt(t * t + 1), sn = t * cs;
      for (let k = 0; k < 3; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = cs * akp - sn * akq; A[k][q] = sn * akp + cs * akq; }
      for (let k = 0; k < 3; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = cs * apk - sn * aqk; A[q][k] = sn * apk + cs * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = cs * vkp - sn * vkq; V[k][q] = sn * vkp + cs * vkq; }
    }
  }
  return { values: [A[0][0], A[1][1], A[2][2]], vectors: [0, 1, 2].map((j) => [V[0][j], V[1][j], V[2][j]]) };
}

export function exportShapes(list, format) {
  if (format === 'step') return exportSTEP(list.map(({ shape, name, color }) => ({ shape, name, color })));
  const shape = list.length === 1 ? list[0].shape : makeCompound(list.map((l) => l.shape.clone()));
  return shape.blobSTL({ binary: true, tolerance: 0.01, angularTolerance: 0.1 });
}

// Pairwise interference between bodies: returns overlapping volumes with meshes.
export function interference(entries) {
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [ia, a] = entries[i], [ib, b] = entries[j];
      const A = bboxOf(a), B = bboxOf(b);
      if (A.hi.some((v, k) => v < B.lo[k]) || B.hi.some((v, k) => v < A.lo[k])) continue;
      try {
        const x = a.intersect(b);
        const v = measureVolume(x);
        if (v > 1e-6) out.push({ a: ia, b: ib, volume: v, mesh: meshShape(x).mesh });
      } catch { /* touching only */ }
    }
  }
  return out;
}

// 2D projections for engineering drawings (hidden-line removal by OpenCascade).
// Third-angle cameras: `dir` points toward the viewer, paper-up = dir × xAxis. SVG paths come back
// in SVG coordinates (y down); `bbox` is converted to SVG coordinates too.
const VIEW_CAMS = {
  front: { dir: [0, -1, 0], x: [1, 0, 0] },
  back: { dir: [0, 1, 0], x: [-1, 0, 0] },
  top: { dir: [0, 0, 1], x: [1, 0, 0] },
  bottom: { dir: [0, 0, -1], x: [1, 0, 0] },
  right: { dir: [1, 0, 0], x: [0, 1, 0] },
  left: { dir: [-1, 0, 0], x: [0, -1, 0] },
  iso: { dir: unit([1, -1, 1]), x: unit([1, 1, 0]) },
};
export function projectViews(shapes, views) {
  const shape = shapes.length === 1 ? shapes[0] : makeCompound(shapes.map((s) => s.clone()));
  const bb = bboxOf(shape);
  const paths = (d) => { try { return d.toSVGPaths().flat(Infinity); } catch { return []; } };
  return views.map((v) => {
    const c = VIEW_CAMS[v] || VIEW_CAMS.front;
    const cam = new ProjectionCamera(add(bb.center, mul(c.dir, bb.diag * 2 + 10)), c.dir, c.x);
    const { visible, hidden } = drawProjection(shape, cam);
    let bbox = null, proj = null;
    try { const [[x0, y0], [x1, y1]] = visible.boundingBox.bounds; bbox = [[x0, -y1], [x1, -y0]]; } catch { /* empty view */ }
    // model point → view coordinates (exact for the axis views, whose outline spans the projected bounding box)
    if (bbox && v !== 'iso') {
      const up = cross(c.dir, c.x), corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [i & 1 ? bb.hi[0] : bb.lo[0], i & 2 ? bb.hi[1] : bb.lo[1], i & 4 ? bb.hi[2] : bb.lo[2]]);
      const minX = Math.min(...corners.map((q) => dot(q, c.x))), maxU = Math.max(...corners.map((q) => dot(q, up)));
      proj = { x: c.x, up, ox: bbox[0][0] - minX, oy: bbox[0][1] + maxU };
    }
    return { view: v, visible: paths(visible), hidden: paths(hidden), bbox, proj };
  });
}

// ---------- CAM: 2.5-axis toolpaths ----------
// Operations work in model coordinates with +Z as the spindle axis. Each toolpath is a list of moves
// { r: rapid?, p: [x, y, z] } (the target of each move). Stock is the body's bounding box plus margins.
const RAPID_FEED = 5000; // mm/min used for time estimates

function camStock(body, setup) {
  const bb = bboxOf(body), m = setup.margin ?? 2, top = setup.top ?? 1;
  return { lo: [bb.lo[0] - m, bb.lo[1] - m, bb.lo[2]], hi: [bb.hi[0] + m, bb.hi[1] + m, bb.hi[2] + top], part: { lo: bb.lo, hi: bb.hi } };
}

// Closed loops (2D polylines) of the wires that offsetting a planar face by `d` produces (d > 0 grows).
function faceOffsetLoops(face, d) {
  const oc = getOC();
  let sh;
  try {
    const mk = new oc.BRepOffsetAPI_MakeOffset(face.wrapped, oc.GeomAbs_JoinType.GeomAbs_Arc, false);
    mk.Perform(d, 0);
    if (!mk.IsDone()) { mk.delete(); return []; }
    sh = cast(mk.Shape());
    mk.delete();
  } catch { return []; }
  const wires = sh instanceof Wire ? [sh] : sh.wires || [];
  return wires.map((w) => {
    const segs = w.edges.map((e) => {
      const L = e.length || 1;
      const n = e.geomType === 'LINE' ? 1 : Math.max(6, Math.min(200, Math.ceil(L / 0.5)));
      return Array.from({ length: n + 1 }, (_, i) => vxyz(e.pointAt(i / n)).slice(0, 2));
    });
    return segs.length ? chainSegments(segs) : [];
  }).filter((r) => r.length > 2);
}
const loopArea2 = (r) => { let a = 0; for (let i = 0; i < r.length; i++) { const [x0, y0] = r[i], [x1, y1] = r[(i + 1) % r.length]; a += x0 * y1 - x1 * y0; } return a / 2; };

// Z levels from top (exclusive) to bottom (inclusive) with at most `step` between them.
const levels = (top, bottom, step) => {
  const n = Math.max(1, Math.ceil((top - bottom) / Math.max(step, 0.01) - 1e-9));
  return Array.from({ length: n }, (_, i) => top - ((i + 1) * (top - bottom)) / n);
};

// ---------- 3D machining: height map and drop cutter ----------
// The part's top surface as a grid of heights (highest triangle over each cell centre), rasterised from
// its mesh. Cells outside the part hold the part's bottom.
function heightMap(body, cell, pad) {
  const { vertices: V, triangles: T } = meshShape(body).mesh, bb = bboxOf(body);
  const x0 = bb.lo[0] - pad, y0 = bb.lo[1] - pad;
  const nx = Math.max(2, Math.ceil((bb.hi[0] + pad - x0) / cell) + 1), ny = Math.max(2, Math.ceil((bb.hi[1] + pad - y0) / cell) + 1);
  const H = new Float64Array(nx * ny).fill(bb.lo[2]);
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t] * 3, b = T[t + 1] * 3, c = T[t + 2] * 3;
    const ax = V[a], ay = V[a + 1], az = V[a + 2], bx = V[b], by = V[b + 1], bz = V[b + 2], cx = V[c], cy = V[c + 1], cz = V[c + 2];
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-14) continue; // vertical triangle: its edges are covered by its neighbours
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / cell)), i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx, cx) - x0) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - y0) / cell)), j1 = Math.min(ny - 1, Math.ceil((Math.max(ay, by, cy) - y0) / cell));
    for (let j = j0; j <= j1; j++) {
      const py = y0 + j * cell;
      for (let i = i0; i <= i1; i++) {
        const px = x0 + i * cell;
        const w1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den, w2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den, w3 = 1 - w1 - w2;
        if (w1 < -1e-9 || w2 < -1e-9 || w3 < -1e-9) continue;
        const z = w1 * az + w2 * bz + w3 * cz, k = j * nx + i;
        if (z > H[k]) H[k] = z;
      }
    }
  }
  // every vertex too, so thin features narrower than a cell are not lost
  for (let v = 0; v < V.length; v += 3) {
    const i = Math.round((V[v] - x0) / cell), j = Math.round((V[v + 1] - y0) / cell);
    if (i >= 0 && j >= 0 && i < nx && j < ny && V[v + 2] > H[j * nx + i]) H[j * nx + i] = V[v + 2];
  }
  return { H, nx, ny, x0, y0, cell, floor: bb.lo[2] };
}
// Lowest tool-tip height at (x, y) that doesn't cut into the surface: flat end mills sit on the highest
// point under them; ball end mills on the highest sphere contact.
function dropCutter(hm, tool, x, y) {
  const r = tool.d / 2, { H, nx, ny, x0, y0, cell } = hm, n = Math.ceil(r / cell);
  const ci = Math.round((x - x0) / cell), cj = Math.round((y - y0) / cell), ball = tool.type === 'ball';
  let z = -Infinity;
  for (let j = Math.max(0, cj - n); j <= Math.min(ny - 1, cj + n); j++) {
    const dy = y0 + j * cell - y;
    for (let i = Math.max(0, ci - n); i <= Math.min(nx - 1, ci + n); i++) {
      const dx = x0 + i * cell - x, d2 = dx * dx + dy * dy;
      if (d2 > r * r) continue;
      const h = H[j * nx + i] + (ball ? Math.sqrt(r * r - d2) - r : 0);
      if (h > z) z = h;
    }
  }
  return z === -Infinity ? hm.floor : z;
}
// drop points that lie on a straight line between their neighbours
function simplifyPath(pts, tol = 0.002) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1], b = pts[i + 1], p = pts[i];
    const ab = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1)));
    if (len(sub(p, add(a, mul(ab, t)))) > tol) out.push(p);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// One pass around a closed loop at depth z, lifted to zTab over n evenly spaced tabs (each `span` long
// along the tool path, which is the tab width plus the tool diameter). Records the tab centres once.
function tabbedPass(loop, z, zTab, n, span, at, clear, record) {
  const P = [...loop, loop[0]], seg = [];
  let L = 0;
  for (let i = 1; i < P.length; i++) { const l = Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); seg.push(l); L += l; }
  if (L < 1e-9) return;
  const half = Math.min(span / 2, L / (2 * n) * 0.9);
  const tabs = Array.from({ length: n }, (_, k) => (L * (k + 0.5)) / n);
  const inTab = (s) => tabs.some((c) => Math.abs(s - c) < half);
  // break points: polyline vertices plus every tab edge
  const cuts = [0, ...tabs.flatMap((c) => [c - half, c + half])];
  let acc = 0;
  for (const l of seg) { acc += l; cuts.push(acc); }
  cuts.sort((a, b) => a - b);
  const pointAt = (s) => {
    let a = 0;
    for (let i = 0; i < seg.length; i++) {
      if (s <= a + seg[i] + 1e-12) { const t = seg[i] ? (s - a) / seg[i] : 0; return [P[i][0] + (P[i + 1][0] - P[i][0]) * t, P[i][1] + (P[i + 1][1] - P[i][1]) * t]; }
      a += seg[i];
    }
    return P[P.length - 1];
  };
  if (record) for (const c of tabs) record.push(pointAt(c));
  const zAt = (s) => (inTab(s) ? Math.max(z, zTab) : z);
  const p0 = pointAt(0);
  at([p0[0], p0[1], clear], true);
  at([p0[0], p0[1], zAt(1e-9)], false);
  let prevZ = zAt(1e-9);
  for (let k = 1; k < cuts.length; k++) {
    const a = cuts[k - 1], b = cuts[k];
    if (b - a < 1e-9) continue;
    const zz = zAt((a + b) / 2), q = pointAt(a);
    if (Math.abs(zz - prevZ) > 1e-9) at([q[0], q[1], zz], false); // straight up onto, or down off, a tab
    const e = pointAt(b);
    at([e[0], e[1], zz], false);
    prevZ = zz;
  }
  at([p0[0], p0[1], clear], true);
}

function horizontalFace(state, pk) {
  const { face } = pickedFace(state, pk);
  if (face.geomType !== 'PLANE') throw new Error('Pick flat faces that face up (+Z)');
  const n = unit(pk.n);
  if (Math.abs(n[2]) < 0.999) throw new Error('These operations need faces parallel to the XY plane (facing up or down)');
  return { face, z: vxyz(face.center)[2] };
}

/** Toolpaths for every operation. cam: { body, setup, tools: {id: tool}, ops: [...] } */
export function camToolpaths(state, cam) {
  const body = state.bodies.get(cam.body);
  if (!body) throw new Error('Choose the body to machine');
  const stock = camStock(body, cam.setup || {});
  const safe = stock.hi[2] + (cam.setup?.safe ?? 10), clear = stock.hi[2] + 2;
  const out = [];
  for (const op of cam.ops || []) {
    const tool = cam.tools[op.tool];
    const res = { id: op.id, moves: [], warnings: [], cut: 0, rapid: 0, time: 0 };
    out.push(res);
    if (op.suppressed) continue;
    try {
      if (!tool) throw new Error('Choose a tool');
      const r = tool.d / 2;
      const M = res.moves;
      const at = (p, rapid) => M.push({ r: rapid, p });
      const loopPass = (loop, z) => {
        at([loop[0][0], loop[0][1], clear], true);
        at([loop[0][0], loop[0][1], z], false);
        for (let i = 1; i < loop.length; i++) at([loop[i][0], loop[i][1], z], false);
        at([loop[0][0], loop[0][1], z], false);
        at([loop[0][0], loop[0][1], clear], true);
      };
      at([stock.lo[0], stock.lo[1], safe], true);
      if (op.type === 'face') {
        const top = stock.hi[2], bottom = stock.part.hi[2];
        if (top - bottom < 1e-6) throw new Error('There is no stock above the part to face. Set a top allowance in the setup.');
        const over = tool.d * (tool.stepover ?? 0.6), x0 = stock.lo[0] - r, x1 = stock.hi[0] + r;
        for (const z of levels(top, bottom, tool.stepdown)) {
          let y = stock.lo[1], dir = 1;
          at([dir > 0 ? x0 : x1, y, clear], true);
          at([dir > 0 ? x0 : x1, y, z], false);
          while (true) {
            at([dir > 0 ? x1 : x0, y, z], false);
            if (y >= stock.hi[1] - 1e-9) break;
            y = Math.min(stock.hi[1], y + over);
            at([dir > 0 ? x1 : x0, y, z], false);
            dir = -dir;
          }
          at([M[M.length - 1].p[0], y, clear], true);
        }
      } else if (op.type === 'profile' || op.type === 'pocket') {
        if (!op.faces?.length) throw new Error('Pick the faces to machine');
        for (const pk of op.faces) {
          const { face, z } = horizontalFace(state, pk);
          if (op.type === 'profile') {
            const side = op.side || 'outside';
            const d = side === 'outside' ? r : side === 'inside' ? -r : 0;
            const loops = d ? faceOffsetLoops(face, d) : faceOffsetLoops(face, 1e-4);
            if (!loops.length) throw new Error('The tool is too large for this profile');
            const bottom = op.through ? stock.part.lo[2] - (op.extra ?? 0.5) : z;
            // holding tabs: on through cuts, bridges of material left on the outer outline so the part
            // stays attached to the stock; the tool lifts over them on the passes below the tab top
            const nTabs = op.through && side !== 'inside' ? Math.max(0, Math.round(op.tabs || 0)) : 0;
            const zTab = stock.part.lo[2] + Math.max(0.1, op.tabHeight ?? 1.5);
            const outer = nTabs ? loops.reduce((a, b) => (Math.abs(loopArea2(b)) > Math.abs(loopArea2(a)) ? b : a)) : null;
            if (nTabs) res.tabs = [];
            for (const zz of levels(stock.hi[2], bottom, tool.stepdown)) for (const L of loops) {
              if (L === outer && zz < zTab - 1e-9) tabbedPass(L, zz, zTab, nTabs, (op.tabWidth ?? 6) + 2 * r, at, clear, res.tabs.length ? null : res.tabs);
              else loopPass(L, zz);
            }
          } else {
            // pocket: rings from the wall inwards, cut from the inside out at each depth
            const over = tool.d * (tool.stepover ?? 0.45), rings = [];
            for (let k = 0; k < 400; k++) {
              const loops = faceOffsetLoops(face, -(r + k * over));
              if (!loops.length || loops.every((L) => Math.abs(loopArea2(L)) < 1e-4)) break;
              rings.push(loops);
            }
            if (!rings.length) throw new Error('The tool is too large for this pocket');
            const top = op.top === 'stock' ? stock.hi[2] : stock.part.hi[2];
            if (top - z < 1e-6) throw new Error('This face is at the top of the part; pick the floor of a pocket');
            for (const zz of levels(top, z, tool.stepdown)) for (const loops of rings.slice().reverse()) for (const L of loops) loopPass(L, zz);
          }
        }
      } else if (op.type === 'drill') {
        if (!op.faces?.length) throw new Error('Pick the holes to drill');
        for (const pk of op.faces) {
          const { face } = pickedFace(state, pk);
          if (face.geomType !== 'CYLINDRE') throw new Error('Pick the round wall of each hole');
          const cyl = cylinderOf(face);
          if (Math.abs(Math.abs(cyl.axis[2]) - 1) > 1e-3) { res.warnings.push('A hole that is not vertical was skipped'); continue; }
          if (Math.abs(cyl.radius * 2 - tool.d) > 0.05) res.warnings.push(`Hole Ø${fmtN(cyl.radius * 2)} drilled with a Ø${fmtN(tool.d)} tool`);
          const zs = [cyl.v0, cyl.v1].map((v) => cyl.center[2] + v * cyl.axis[2]);
          const zTop = Math.max(...zs), zBot = Math.min(...zs) - (Math.min(...zs) <= stock.part.lo[2] + 1e-6 ? (op.extra ?? 0.6 * tool.d) : 0);
          const x = cyl.center[0], y = cyl.center[1], peck = tool.peck || tool.d;
          at([x, y, clear], true);
          let zc = zTop;
          while (zc > zBot + 1e-9) {
            const zn = Math.max(zBot, zc - peck);
            at([x, y, zc + (zc < zTop ? 0.5 : 0)], true);
            at([x, y, zn], false);
            at([x, y, clear], true);
            zc = zn;
          }
        }
      } else if (op.type === 'engrave') {
        // engrave: follow every curve of a horizontal sketch, down to a depth below the sketch plane
        const sk = state.sketches.get(op.sketch);
        if (!sk) throw new Error('Choose the sketch to engrave');
        const pl = sk.plane;
        if (Math.abs(Math.abs(pl.normal[2]) - 1) > 1e-6) throw new Error('Engraving needs a sketch on a horizontal plane or a flat top face');
        const y = yDirOf(pl), to3 = (q) => add(pl.origin, add(mul(pl.xDir, q[0]), mul(y, q[1])));
        const top = pl.origin[2], depth = Math.max(0.01, op.depth ?? 0.5), bottom = top - depth;
        let paths = sk.geom.filter((g) => !g.construction).map((g) => sampleSketchCurve(g).map(to3));
        if (!paths.length) throw new Error('The sketch has no curves to engrave');
        // visit the curves nearest-first (reversing them when that is shorter) to cut down on rapids
        const ordered = [];
        let cur = [stock.lo[0], stock.lo[1]];
        while (paths.length) {
          let bi = 0, rev = false, bd = Infinity;
          paths.forEach((q, i) => { const a = Math.hypot(q[0][0] - cur[0], q[0][1] - cur[1]), b = Math.hypot(q[q.length - 1][0] - cur[0], q[q.length - 1][1] - cur[1]); if (a < bd) { bd = a; bi = i; rev = false; } if (b < bd) { bd = b; bi = i; rev = true; } });
          const q = paths.splice(bi, 1)[0], pth = rev ? q.slice().reverse() : q;
          ordered.push(simplifyPath(pth.map((p3) => [p3[0], p3[1], 0]), 0.002));
          cur = pth[pth.length - 1];
        }
        for (const pth of ordered) for (const zz of levels(top, bottom, tool.stepdown || depth)) {
          at([pth[0][0], pth[0][1], clear], true);
          at([pth[0][0], pth[0][1], zz], false);
          for (let i = 1; i < pth.length; i++) at([pth[i][0], pth[i][1], zz], false);
          at([pth[pth.length - 1][0], pth[pth.length - 1][1], clear], true);
        }
        if (top > stock.part.hi[2] + 1e-6) res.warnings.push('The sketch is above the part, so the cut is in the air');
        if (tool.type === 'vbit') res.warnings.push(`A ${fmtN(tool.angle || 90)}° V-bit at ${fmtN(depth)} mm deep cuts lines ${fmtN(2 * depth * Math.tan(((tool.angle || 90) * Math.PI) / 360))} mm wide`);
      } else if (op.type === 'rough3d' || op.type === 'parallel') {
        // 3D: Z-level roughing (terraces that follow the surface, leaving stock) or parallel finishing
        const finish = op.type === 'parallel';
        if (finish && tool.type !== 'ball') res.warnings.push('Parallel finishing is usually done with a ball end mill');
        const leave = finish ? (op.leave ?? 0) : (op.leave ?? 0.3);
        const bbP = stock.part, pad = r + 1;
        const cell = Math.max(0.05, Math.min(op.tolerance ?? 0.2, r / 3));
        const hm = heightMap(body, cell, pad);
        const step = finish ? Math.max(cell, Math.min(0.5, r / 4)) : Math.max(cell, r / 2);
        const over = tool.d * (tool.stepover ?? (finish ? 0.1 : 0.45));
        const [xa, xb] = op.boundary === 'stock' ? [stock.lo[0] - r, stock.hi[0] + r] : [bbP.lo[0] - r, bbP.hi[0] + r];
        const [ya, yb] = op.boundary === 'stock' ? [stock.lo[1], stock.hi[1]] : [bbP.lo[1], bbP.hi[1]];
        const rows = [];
        for (let y = ya, k = 0; y <= yb + 1e-9 && k < 4000; y += over, k++) rows.push(y);
        if (rows.length && rows[rows.length - 1] < yb - 1e-6) rows.push(yb);
        const nX = Math.max(2, Math.ceil((xb - xa) / step) + 1);
        if (rows.length * nX > 600000) throw new Error('This toolpath would be too fine; use a larger stepover or tolerance');
        // tool-tip envelope on every row (the same for all levels)
        const env = rows.map((y) => Array.from({ length: nX }, (_, i) => { const x = xa + ((xb - xa) * i) / (nX - 1); return [x, y, dropCutter(hm, tool, x, y) + leave]; }));
        const zLevels = finish ? [null] : levels(stock.hi[2], bbP.lo[2] + leave, tool.stepdown);
        for (const zl of zLevels) {
          env.forEach((row, k) => {
            let pts = row.map(([x, y, ze]) => [x, y, zl == null ? ze : Math.max(zl, ze)]);
            // roughing: skip the parts of a row above the material already removed at this level
            if (zl != null && pts.every((q) => q[2] > zl + 1e-9)) return;
            if (k % 2) pts = pts.reverse(); // zig-zag
            pts = simplifyPath(pts);
            at([pts[0][0], pts[0][1], clear], true);
            at([pts[0][0], pts[0][1], pts[0][2]], false);
            for (let i = 1; i < pts.length; i++) at(pts[i], false);
            at([pts[pts.length - 1][0], pts[pts.length - 1][1], clear], true);
          });
        }
        if (!finish) res.warnings.push(`Leaves ${fmtN(leave)} mm for finishing`);
      } else throw new Error(`Unknown operation ${op.type}`);
      at([M[M.length - 1].p[0], M[M.length - 1].p[1], safe], true);
      // lengths and time
      for (let i = 1; i < M.length; i++) {
        const a = M[i - 1].p, b = M[i].p, l = len(sub(b, a));
        if (M[i].r) { res.rapid += l; res.time += (l / RAPID_FEED) * 60; } else {
          res.cut += l;
          const plunge = b[2] < a[2] - 1e-9 && Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9;
          res.time += (l / ((plunge ? tool.plunge : tool.feed) || 500)) * 60;
        }
      }
    } catch (e) { res.error = errMsg(e); res.moves = []; }
  }
  return { stock, safe, ops: out };
}
const fmtN = (v) => (+v.toFixed(2)).toString();

// Section view: the model cut by a plane normal to X or Y (or Z), seen from the side that was cut
// away. Returns the projected visible lines plus the cut faces as closed loops (for hatching), all in
// the same 2D coordinates as projectViews, and where the plane sits as a fraction of the model size.
const SECTION_CAMS = { Y: 'front', X: 'right', Z: 'top' };
export function sectionView(shapes, { axis = 'Y', at = 0.5 } = {}) {
  const k = { X: 0, Y: 1, Z: 2 }[axis];
  const all = shapes.length === 1 ? shapes[0] : makeCompound(shapes.map((s) => s.clone()));
  const bb = bboxOf(all);
  const pos = bb.lo[k] + (bb.hi[k] - bb.lo[k]) * Math.min(0.999, Math.max(0.001, at));
  const c = VIEW_CAMS[SECTION_CAMS[axis]];
  // remove the material between the viewer and the plane
  const pad = bb.diag + 10;
  const lo = bb.lo.map((v) => v - pad), hi = bb.hi.map((v) => v + pad);
  if (c.dir[k] < 0) hi[k] = pos; else lo[k] = pos;
  const tool = makeBox(lo, hi);
  const kept = [];
  for (const s of shapes) { try { const r = s.clone().cut(tool); if (r) kept.push(r); } catch { /* body not cut */ } }
  if (!kept.length) throw new Error('The section plane does not cut the model');
  const shape = kept.length === 1 ? kept[0] : makeCompound(kept);
  const cam = new ProjectionCamera(add(bb.center, mul(c.dir, bb.diag * 2 + 10)), c.dir, c.x);
  const paths = (d) => { try { return d.toSVGPaths().flat(Infinity); } catch { return []; } };
  const { visible } = drawProjection(shape, cam);
  let bbox = null;
  try { const [[x0, y0], [x1, y1]] = visible.boundingBox.bounds; bbox = [[x0, -y1], [x1, -y0]]; } catch { /* empty */ }
  // cut faces: planar faces lying on the section plane
  const up = cross(c.dir, c.x);
  const loops = [];
  const tol = Math.max(bb.diag * 1e-5, 1e-6);
  for (const s of kept) {
    for (const fc of s.faces) {
      if (fc.geomType !== 'PLANE') continue;
      const P = [0.25, 0.5, 0.75].flatMap((a) => [0.3, 0.7].map((b) => vxyz(fc.pointOnSurface(a, b))));
      if (!P.every((q) => Math.abs(q[k] - pos) < tol * 10)) continue;
      // same 2D frame as drawProjection: relative to the camera, x along the camera x, SVG y downwards
      const camPos = add(bb.center, mul(c.dir, bb.diag * 2 + 10));
      const mine = (q) => { const d = sub(q, camPos); return [dot(d, c.x), -dot(d, up)]; };
      const rings = [];
      for (const w of [fc.clone().outerWire(), ...fc.clone().innerWires()]) {
        const segs = w.edges.map((e) => {
          const n = e.geomType === 'LINE' ? 1 : 72;
          return Array.from({ length: n + 1 }, (_, i) => mine(vxyz(e.pointAt(i / n))));
        });
        rings.push(chainSegments(segs));
      }
      loops.push(rings);
    }
  }
  return { view: 'section', axis, at, visible: paths(visible), hidden: [], bbox, loops, from: SECTION_CAMS[axis] };
}

/**
 * Vertical holes for drawing callouts, in the top view's 2D frame (same as projectViews).
 * Coaxial cylinders are merged: the smallest is the hole, a wider one at its top is a counterbore.
 */
export function drawingHoles(shapes) {
  const all = shapes.length === 1 ? shapes[0] : makeCompound(shapes.map((s) => s.clone()));
  const bb = bboxOf(all);
  const c = VIEW_CAMS.top, up = cross(c.dir, c.x);
  const camPos = add(bb.center, mul(c.dir, bb.diag * 2 + 10));
  const to2 = (q) => { const d = sub(q, camPos); return [dot(d, c.x), -dot(d, up)]; };
  const cyls = [], cones = [];
  for (const s of shapes) {
    const sb = bboxOf(s);
    for (const fc of s.faces) {
      if (fc.geomType === 'CONE') {
        // countersink: a vertical cone; its widest edge gives the countersink diameter
        try {
          const cy = cylinderOf(fc);
          if (Math.abs(Math.abs(cy.axis[2]) - 1) > 1e-4) continue;
          // only cones that face the axis (a countersink), not chamfers on the outside of a boss
          const q = vxyz(fc.pointOnSurface(0.5, 0.5));
          const radial = sub(q, add(cy.center, mul(cy.axis, dot(sub(q, cy.center), cy.axis))));
          if (dot(vxyz(fc.normalAt(q)), radial) >= 0) continue;
          let rmax = 0;
          for (const e of fc.edges) for (const t of [0, 0.25, 0.5, 0.75]) { const q = vxyz(e.pointAt(t)); rmax = Math.max(rmax, Math.hypot(q[0] - cy.center[0], q[1] - cy.center[1])); }
          cones.push({ x: cy.center[0], y: cy.center[1], d: rmax * 2 });
        } catch { /* not a usable cone */ }
        continue;
      }
      if (fc.geomType !== 'CYLINDRE') continue;
      let cy;
      try { cy = cylinderOf(fc); } catch { continue; }
      if (Math.abs(Math.abs(cy.axis[2]) - 1) > 1e-4) continue;
      // a hole's surface normal points towards its axis
      const q = vxyz(fc.pointOnSurface(0.5, 0.5));
      const radial = sub(q, add(cy.center, mul(cy.axis, dot(sub(q, cy.center), cy.axis))));
      let n;
      try { n = vxyz(fc.normalAt(q)); } catch { continue; }
      if (dot(n, radial) >= 0) continue;
      const zs = [cy.v0, cy.v1].map((v) => cy.center[2] + v * cy.axis[2]);
      cyls.push({ x: cy.center[0], y: cy.center[1], d: cy.radius * 2, z0: Math.min(...zs), z1: Math.max(...zs), top: sb.hi[2], bottom: sb.lo[2] });
    }
  }
  const tol = Math.max(bb.diag * 1e-5, 1e-4), holes = [];
  for (const cl of cyls) {
    let h = holes.find((x) => Math.hypot(x.x - cl.x, x.y - cl.y) < tol);
    if (!h) holes.push((h = { x: cl.x, y: cl.y, parts: [] }));
    h.parts.push(cl);
  }
  return holes.map((h) => {
    const parts = h.parts.sort((a, b) => a.d - b.d), main = parts[0];
    // merge split faces of the same diameter
    const same = parts.filter((p) => Math.abs(p.d - main.d) < 1e-4);
    const z0 = Math.min(...same.map((p) => p.z0)), z1 = Math.max(...parts.map((p) => p.z1));
    const through = z0 <= main.bottom + 1e-4;
    const cb = parts.find((p) => p.d > main.d + 1e-4 && p.z1 >= main.top - 1e-4);
    const cs = cones.filter((k) => Math.hypot(k.x - h.x, k.y - h.y) < tol && k.d > main.d + 1e-4).sort((a, b) => b.d - a.d)[0];
    const [x, y] = to2([h.x, h.y, 0]);
    return { x, y, d: main.d, depth: z1 - z0, through, cbore: cb ? { d: cb.d, depth: cb.z1 - cb.z0 } : null, csink: cs ? { d: cs.d } : null };
  });
}

/**
 * Geometric difference between an older feature list and the current state, body by body:
 * material added since then (current − old) and removed (old − current), with meshes and volumes.
 */
export async function compareWithFeatures(current, oldFeatures) {
  const old = (await rebuild(oldFeatures, [])).states.at(-1) || emptyState();
  const ids = [...new Set([...current.bodies.keys(), ...old.bodies.keys()])];
  const vol = (s) => { try { return hasSolid(s) ? measureVolume(s) : 0; } catch { return 0; } };
  const part = (s) => {
    if (!s) return null;
    const v = vol(s);
    if (v < 1e-6) return null;
    const m = meshShape(s).mesh;
    return { volume: v, mesh: { vertices: m.vertices.slice(), normals: m.normals.slice(), triangles: m.triangles.slice() } };
  };
  const out = [];
  for (const id of ids) {
    const a = old.bodies.get(id), b = current.bodies.get(id);
    let added = null, removed = null;
    if (a && b) {
      try { added = part(b.clone().cut(a)); } catch { /* boolean failed */ }
      try { removed = part(a.clone().cut(b)); } catch { /* boolean failed */ }
    } else if (b) added = part(b);
    else if (a) removed = part(a);
    out.push({ id, status: a && b ? 'changed' : b ? 'new' : 'deleted', volOld: a ? vol(a) : 0, volNew: b ? vol(b) : 0, added, removed });
  }
  return out;
}

// Joins polyline pieces end to end into one closed ring (pieces may come in any order or direction).
function chainSegments(segs) {
  const left = segs.slice();
  const ring = left.shift().slice();
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  while (left.length) {
    const end = ring[ring.length - 1];
    let bi = 0, rev = false, bd = Infinity;
    left.forEach((s, i) => { const a = d2(s[0], end), b = d2(s[s.length - 1], end); if (a < bd) { bd = a; bi = i; rev = false; } if (b < bd) { bd = b; bi = i; rev = true; } });
    const s = left.splice(bi, 1)[0];
    ring.push(...(rev ? s.slice().reverse() : s).slice(1));
  }
  return ring;
}

// ---------- measurement ----------
const circR = (a, b, c) => {
  const ab = len(sub(a, b)), bc = len(sub(b, c)), ca = len(sub(c, a));
  const area = len(cross(sub(b, a), sub(c, a))) / 2;
  return area > 1e-12 ? (ab * bc * ca) / (4 * area) : Infinity;
};
const GT = { LINE: 'Line', CIRCLE: 'Circle', ELLIPSE: 'Ellipse', BSPLINE_CURVE: 'Spline', BEZIER_CURVE: 'Bezier', PLANE: 'Plane', CYLINDRE: 'Cylinder', CONE: 'Cone', SPHERE: 'Sphere', TORUS: 'Torus' };

/** picks: [{ kind: 'edge' | 'face', body, p, n? }] → per-entity info plus pairwise distance/angle. */
export function measurePicks(state, picks) {
  const ents = picks.map((pk) => {
    const body = state.bodies.get(pk.body);
    if (!body) throw new Error('Body not found');
    const tol = tolFor(body);
    if (pk.kind === 'edge') {
      const e = body.edges.find((x) => near(x, pk.p, tol));
      if (!e) throw new Error('Edge not found');
      const info = { kind: 'edge', type: GT[e.geomType] || e.geomType, length: e.length, shape: e };
      const p0 = vxyz(e.startPoint), p1 = vxyz(e.endPoint);
      info.dir = unit(sub(p1, p0));
      if (e.geomType === 'CIRCLE') info.radius = circR(vxyz(e.pointAt(0)), vxyz(e.pointAt(0.33)), vxyz(e.pointAt(0.66)));
      return info;
    }
    const f = body.faces.find((x) => near(x, pk.p, tol));
    if (!f) throw new Error('Face not found');
    const info = { kind: 'face', type: GT[f.geomType] || f.geomType, area: measureArea(f), shape: f, normal: pk.n };
    if (f.geomType === 'CYLINDRE') {
      const P = [0, 1, 2].map((i) => vxyz(f.pointOnSurface((i + 0.5) / 3, 0.5)));
      info.radius = circR(...P);
    }
    return info;
  });
  const out = { items: ents.map(({ shape, dir, normal, ...rest }) => rest) };
  if (ents.length === 2) {
    const [a, b] = ents;
    try { out.distance = measureDistanceBetween(a.shape, b.shape); } catch { /* ignore */ }
    const dirOf = (e) => (e.kind === 'edge' && e.type === 'Line' ? { v: e.dir, line: true } : e.kind === 'face' && e.type === 'Plane' ? { v: unit(e.normal), line: false } : null);
    const da = dirOf(a), db = dirOf(b);
    if (da && db) {
      let ang = (Math.acos(Math.min(1, Math.abs(dot(da.v, db.v)))) * 180) / Math.PI;
      if (da.line !== db.line) ang = 90 - ang; // line vs plane
      out.angle = ang;
    }
  }
  return out;
}

// ---------- surface evaluation ----------
const surfOf = (face) => { const h = getOC().BRep_Tool.Surface(face.wrapped); return h.get ? h.get() : h; };
const v3 = (v) => [v.X(), v.Y(), v.Z()];

// Gaussian (K) and mean (H, convex positive) curvature of a surface at (u, v).
function surfCurv(surf, u, v, sign) {
  const d = surf.EvalD2(u, v);
  const Su = v3(d.D1U), Sv = v3(d.D1V), Suu = v3(d.D2U), Svv = v3(d.D2V), Suv = v3(d.D2UV);
  for (const k of ['Point', 'D1U', 'D1V', 'D2U', 'D2V', 'D2UV']) d[k]?.delete?.();
  const N = unit(cross(Su, Sv));
  const E = dot(Su, Su), F = dot(Su, Sv), G = dot(Sv, Sv);
  const L = dot(Suu, N), M = dot(Suv, N), Nn = dot(Svv, N);
  const den = E * G - F * F;
  if (den < 1e-18) return [0, 0];
  return [(L * Nn - M * M) / den, (-sign * (E * Nn - 2 * F * M + G * L)) / (2 * den)];
}

/** Per-vertex curvature of the display mesh of a body: Float32Array [K0, H0, K1, H1, ...]. */
export function curvatureField(shape) {
  const oc = getOC();
  const { mesh } = meshShape(shape);
  const nv = mesh.vertices.length / 3;
  const out = new Float32Array(nv * 2);
  const byHash = new Map(shape.faces.map((fc) => [fc.hashCode, fc]));
  for (const g of mesh.faceGroups) {
    const face = byHash.get(g.faceId);
    if (!face || face.geomType === 'PLANE') continue;
    const surf = surfOf(face);
    const handle = oc.BRep_Tool.Surface(face.wrapped);
    const sign = face.wrapped.Orientation() === oc.TopAbs_Orientation.TopAbs_FORWARD ? 1 : -1;
    const verts = new Set();
    for (let i = g.start; i < g.start + g.count; i++) verts.add(mesh.triangles[i]);
    const constant = face.geomType === 'CYLINDRE' || face.geomType === 'SPHERE';
    let cached = null;
    for (const vi of verts) {
      if (!cached || !constant) {
        const P = new oc.gp_Pnt(mesh.vertices[vi * 3], mesh.vertices[vi * 3 + 1], mesh.vertices[vi * 3 + 2]);
        const pr = new oc.GeomAPI_ProjectPointOnSurf(P, handle);
        let kh = [0, 0];
        if (pr.NbPoints() > 0) { const uv = pr.LowerDistanceParameters(); kh = surfCurv(surf, uv.U, uv.V, sign); }
        pr.delete(); P.delete();
        cached = kh;
      }
      out[vi * 2] = cached[0];
      out[vi * 2 + 1] = cached[1];
    }
  }
  return out;
}

/** Curvature combs along picked edges: [{ pts, k, n, length }]. */
export function curvatureCombs(state, picks, samples = 90) {
  return picks.map((pk) => {
    const { edge } = pickedEdge(state, pk);
    const c = getOC().BRep_Tool.Curve(edge.wrapped, 0, 1);
    const crv = c.returnValue.get ? c.returnValue.get() : c.returnValue;
    const pts = [], ks = [], ns = [];
    for (let i = 0; i <= samples; i++) {
      const t = c.First + ((c.Last - c.First) * i) / samples;
      const d = crv.EvalD2(t);
      const P = v3(d.Point), V1 = v3(d.D1), V2 = v3(d.D2);
      for (const k of ['Point', 'D1', 'D2']) d[k]?.delete?.();
      const s1 = len(V1);
      const k = s1 > 1e-12 ? len(cross(V1, V2)) / s1 ** 3 : 0;
      const T = unit(V1);
      const nn = sub(V2, mul(T, dot(V2, T)));
      pts.push(P); ks.push(k); ns.push(len(nn) > 1e-12 ? unit(nn) : [0, 0, 0]);
    }
    return { pts, k: ks, n: ns, length: edge.length };
  });
}

/** Display polyline of a curve wire (sampled per edge). */
export function curvePolyline(wire, perEdge = 120) {
  const pts = [];
  for (const e of wire.edges) for (let i = 0; i <= perEdge; i++) { const q = e.pointAt(i / perEdge); pts.push(q.x, q.y, q.z); }
  return pts;
}

// ---------- DXF export ----------
// Writes the boundary of a planar face as a 2D DXF (R12 ASCII, millimetres) in the face's own plane:
// lines and arcs exactly, other curves as fine polylines. Coordinates start at the face's lower-left corner.
export function faceDXF(state, pick) {
  const { face } = pickedFace(state, pick);
  if (face.geomType !== 'PLANE') throw new Error('DXF export needs a flat face');
  const n = unit(pick.n);
  // in-plane axes: the longest straight edge sets X, so rectangular plates come out square to the sheet
  let xd = null, best = 0;
  for (const e of face.edges) if (e.geomType === 'LINE') { const v = sub(vxyz(e.endPoint), vxyz(e.startPoint)); const l = len(v); if (l > best) { best = l; xd = v; } }
  if (!xd) xd = Math.abs(n[2]) < 0.9 ? cross([0, 0, 1], n) : [1, 0, 0];
  const X = unit(sub(xd, mul(n, dot(xd, n)))), Y = cross(n, X);
  const to2 = (q) => [dot(q, X), dot(q, Y)];
  const ents = edgeEnts(face.edges, to2);
  // shift so the drawing starts at the origin
  let mx = Infinity, my = Infinity;
  const each = (q) => { mx = Math.min(mx, q[0]); my = Math.min(my, q[1]); };
  for (const e of ents) {
    if (e.t === 'LINE') { each(e.a); each(e.b); }
    else if (e.t === 'POLY') e.pts.forEach(each);
    else { each([e.c[0] - e.r, e.c[1] - e.r]); }
  }
  const sh = (q) => [q[0] - mx, q[1] - my];
  for (const e of ents) {
    if (e.t === 'LINE') { e.a = sh(e.a); e.b = sh(e.b); }
    else if (e.t === 'POLY') e.pts = e.pts.map(sh);
    else e.c = sh(e.c);
  }
  return writeDXF(ents);
}

// Model edges → 2D DXF entities through a planar mapping `to2` (lines and arcs stay exact).
function edgeEnts(edges, to2) {
  const ents = [];
  for (const e of edges) {
    if (e.geomType === 'LINE') { ents.push({ t: 'LINE', a: to2(vxyz(e.startPoint)), b: to2(vxyz(e.endPoint)) }); continue; }
    if (e.geomType === 'CIRCLE') {
      const P = [0, 0.25, 0.5, 1].map((t) => to2(vxyz(e.pointAt(t))));
      const c = circumcentre2(P[0], P[1], P[2]);
      if (c) {
        const r = Math.hypot(P[0][0] - c[0], P[0][1] - c[1]);
        if (Math.hypot(P[3][0] - P[0][0], P[3][1] - P[0][1]) < 1e-7 * Math.max(1, r)) { ents.push({ t: 'CIRCLE', c, r }); continue; }
        const ang = (q) => (Math.atan2(q[1] - c[1], q[0] - c[0]) * 180) / Math.PI;
        const a0 = ang(P[0]), a1 = ang(P[3]), am = ang(P[1]);
        const ccw = (((am - a0) % 360) + 360) % 360 < (((a1 - a0) % 360) + 360) % 360;
        ents.push(ccw ? { t: 'ARC', c, r, a0, a1 } : { t: 'ARC', c, r, a0: a1, a1: a0 });
        continue;
      }
    }
    const pts = [];
    for (let i = 0; i <= 64; i++) pts.push(to2(vxyz(e.pointAt(i / 64))));
    ents.push({ t: 'POLY', pts });
  }
  return ents;
}

