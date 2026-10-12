// Text for embossing and engraving.
// Built-in font: a single-stroke engraving font drawn on a 4 × 6 grid (cap height 6). Each stroke is
// a polyline that OpenCascade offsets into a closed outline with round ends and joins, so the result
// looks like a ball-nose engraving and cuts cleanly. Custom fonts (TTF / OTF) go through replicad's
// opentype.js loader instead.
import { getOC, makeLine, makeThreePointArc, makeCircle, assembleWire, cast, Face, Wire, Plane, drawText, loadFont, basicFaceExtrusion, Vector, measureArea } from 'replicad';

const D2R = Math.PI / 180;
// elliptical arc from a0 to a1 (degrees, either direction), ~10° steps
const arc = (cx, cy, rx, ry, a0, a1) => {
  const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / 10));
  return Array.from({ length: n + 1 }, (_, i) => { const a = (a0 + ((a1 - a0) * i) / n) * D2R; return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)]; });
};
const join = (...parts) => parts.flat();
const ellipse = (cx, cy, rx, ry) => arc(cx, cy, rx, ry, 0, 360);
const dot = (x, y) => [[x, y], [x, y]];

// glyph: { w: advance width (before spacing), s: [strokes] }; a stroke is a point list
const G = {
  A: { s: [[[0, 0], [2, 6], [4, 0]], [[0.75, 2.2], [3.25, 2.2]]] },
  B: { s: [join([[0, 3.1], [0, 0], [2.6, 0]], arc(2.6, 1.55, 1.55, 1.55, -90, 90), [[0, 3.1]]), join([[0, 3.1], [0, 6], [2.5, 6]], arc(2.5, 4.55, 1.45, 1.45, 90, -90), [[0, 3.1]])] },
  C: { s: [arc(2.1, 3, 2.1, 3, 45, 315)] },
  D: { s: [join([[0, 0], [0, 6], [1.6, 6]], arc(1.6, 3, 2.4, 3, 90, -90), [[0, 0]])] },
  E: { s: [[[4, 6], [0, 6], [0, 0], [4, 0]], [[0, 3.1], [3, 3.1]]] },
  F: { s: [[[4, 6], [0, 6], [0, 0]], [[0, 3.1], [3, 3.1]]] },
  G: { s: [join(arc(2.1, 3, 2.1, 3, 45, 335), [[4.08, 2.6], [2.4, 2.6]])] },
  H: { s: [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3.1], [4, 3.1]]] },
  I: { w: 2, s: [[[1, 0], [1, 6]], [[0, 6], [2, 6]], [[0, 0], [2, 0]]] },
  J: { s: [join([[4, 6], [4, 2]], arc(2, 2, 2, 2, 0, -180))] },
  K: { s: [[[0, 0], [0, 6]], [[4, 6], [0, 2]], [[1.35, 3.35], [4, 0]]] },
  L: { s: [[[0, 6], [0, 0], [4, 0]]] },
  M: { w: 4.6, s: [[[0, 0], [0, 6], [2.3, 2], [4.6, 6], [4.6, 0]]] },
  N: { s: [[[0, 0], [0, 6], [4, 0], [4, 6]]] },
  O: { s: [ellipse(2, 3, 2, 3)] },
  P: { s: [[[0, 0], [0, 6]], join([[0, 6], [2.4, 6]], arc(2.4, 4.4, 1.6, 1.6, 90, -90), [[0, 2.8]])] },
  Q: { s: [ellipse(2, 3, 2, 3), [[2.5, 1.5], [4.2, -0.3]]] },
  R: { s: [[[0, 0], [0, 6]], join([[0, 6], [2.4, 6]], arc(2.4, 4.4, 1.6, 1.6, 90, -90), [[0, 2.8]]), [[2, 2.8], [4, 0]]] },
  S: { s: [join(arc(2, 4.5, 1.9, 1.5, 20, 270), arc(2, 1.5, 2, 1.5, 90, -160))] },
  T: { s: [[[0, 6], [4, 6]], [[2, 6], [2, 0]]] },
  U: { s: [join([[0, 6], [0, 2]], arc(2, 2, 2, 2, 180, 360), [[4, 6]])] },
  V: { s: [[[0, 6], [2, 0], [4, 6]]] },
  W: { w: 5, s: [[[0, 6], [1.25, 0], [2.5, 4.2], [3.75, 0], [5, 6]]] },
  X: { s: [[[0, 0], [4, 6]], [[0, 6], [4, 0]]] },
  Y: { s: [[[0, 6], [2, 3], [4, 6]], [[2, 3], [2, 0]]] },
  Z: { s: [[[0, 6], [4, 6], [0, 0], [4, 0]]] },
  0: { w: 3.6, s: [ellipse(1.8, 3, 1.8, 3), [[0.75, 1.1], [2.85, 4.9]]] },
  1: { w: 2.6, s: [[[0, 4.7], [1.4, 6], [1.4, 0]], [[0.2, 0], [2.6, 0]]] },
  2: { s: [join(arc(2, 4.2, 1.9, 1.8, 160, -35), [[0, 0], [4, 0]])] },
  3: { s: [join(arc(2, 4.55, 1.8, 1.45, 150, -90), arc(2, 1.55, 2, 1.55, 90, -150))] },
  4: { s: [[[3, 0], [3, 6]], [[3, 6], [0, 1.8], [4, 1.8]]] },
  5: { s: [join([[3.8, 6], [0.5, 6], [0.3, 3.3]], arc(2, 1.9, 2, 1.9, 125, -150))] },
  6: { s: [arc(3.6, 2, 3.6, 4, 90, 180), ellipse(2, 1.9, 2, 1.9)] },
  7: { s: [[[0, 6], [4, 6], [1.4, 0]]] },
  8: { s: [ellipse(2, 4.6, 1.7, 1.4), ellipse(2, 1.6, 2, 1.6)] },
  9: { s: [arc(0.4, 4, 3.6, 4, -90, 0), ellipse(2, 4.1, 2, 1.9)] },
  '.': { w: 0.6, s: [dot(0.3, 0)] },
  ',': { w: 0.8, s: [[[0.6, 0.3], [0.1, -1]]] },
  ':': { w: 0.6, s: [dot(0.3, 0.6), dot(0.3, 3.6)] },
  ';': { w: 0.8, s: [dot(0.6, 3.6), [[0.6, 0.3], [0.1, -1]]] },
  '-': { w: 2.6, s: [[[0, 3], [2.6, 3]]] },
  '+': { w: 3.4, s: [[[0, 3], [3.4, 3]], [[1.7, 1.3], [1.7, 4.7]]] },
  '=': { w: 3.4, s: [[[0, 2.2], [3.4, 2.2]], [[0, 3.8], [3.4, 3.8]]] },
  '/': { w: 3, s: [[[0, -0.2], [3, 6.2]]] },
  '\\': { w: 3, s: [[[0, 6.2], [3, -0.2]]] },
  '(': { w: 1.6, s: [arc(3.6, 3, 3.4, 3.8, 128, 232)] },
  ')': { w: 1.6, s: [arc(-2, 3, 3.4, 3.8, 52, -52)] },
  '[': { w: 1.6, s: [[[1.6, 6.4], [0, 6.4], [0, -0.4], [1.6, -0.4]]] },
  ']': { w: 1.6, s: [[[0, 6.4], [1.6, 6.4], [1.6, -0.4], [0, -0.4]]] },
  '!': { w: 0.6, s: [[[0.3, 6], [0.3, 2]], dot(0.3, 0)] },
  '?': { s: [join(arc(2, 4.3, 1.9, 1.7, 160, -50), [[2, 2.6], [2, 2]]), dot(2, 0)] },
  "'": { w: 0.6, s: [[[0.3, 6], [0.3, 4.6]]] },
  '"': { w: 1.8, s: [[[0.3, 6], [0.3, 4.6]], [[1.5, 6], [1.5, 4.6]]] },
  '°': { w: 2, s: [ellipse(1, 5, 1, 1)] },
  '#': { s: [[[1.3, 0], [1.7, 6]], [[2.7, 0], [3.1, 6]], [[0, 2], [4, 2]], [[0.2, 4], [4.2, 4]]] },
  _: { s: [[[0, -0.6], [4, -0.6]]] },
  '*': { w: 3, s: [[[1.5, 1.8], [1.5, 5.2]], [[0, 2.65], [3, 4.35]], [[0, 4.35], [3, 2.65]]] },
  '%': { w: 4.4, s: [ellipse(1, 4.8, 0.9, 1.2), [[0, 0], [4.4, 6]], ellipse(3.4, 1.2, 0.9, 1.2)] },
  '&': { w: 4.4, s: [ellipse(1.9, 4.85, 1.15, 1.15), join([[1.25, 3.9]], arc(1.9, 1.7, 1.9, 1.7, 125, 300), [[4.2, 3.1]]), [[1.25, 3.9], [4.4, 0]]] },
  ' ': { w: 2.4, s: [] },
};
const SPACING = 1.6;
export const BUILTIN_CHARS = Object.keys(G).join('');

/** Stroke layout for a string: { strokes: [[x, y], ...][], width, height } in units of cap height = 1. */
export function strokeLayout(text, { spacing = 0, align = 'center' } = {}) {
  const lines = String(text).toUpperCase().split(/\r?\n/);
  const out = [];
  let maxW = 0;
  const lineWidths = lines.map((ln) => {
    let w = 0;
    for (const ch of ln) w += ((G[ch] || G['?']).w ?? 4) + SPACING + spacing * 6;
    return Math.max(0, w - SPACING - spacing * 6);
  });
  lines.forEach((ln, li) => {
    const lw = lineWidths[li];
    maxW = Math.max(maxW, lw);
    let x = align === 'left' ? 0 : align === 'right' ? -lw : -lw / 2;
    const y = -li * 9.5;
    for (const ch of ln) {
      const g = G[ch] || G['?'];
      for (const s of g.s) out.push(s.map(([px, py]) => [(x + px) / 6, (y + py) / 6]));
      x += (g.w ?? 4) + SPACING + spacing * 6;
    }
  });
  return { strokes: out, width: maxW / 6, height: (lines.length - 1) * (9.5 / 6) + 1 };
}

const closedPoly = (s) => s.length > 2 && Math.hypot(s[0][0] - s[s.length - 1][0], s[0][1] - s[s.length - 1][1]) < 1e-6;

// Solid for one stroke, extruded by `dir`. Straight strokes are exact capsules; bent polylines are
// offset by OpenCascade (round ends and joins); closed loops are the ring between two offsets.
const sub3 = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const add3 = (p, q) => [p[0] + q[0], p[1] + q[1], p[2] + q[2]];
const mul3 = (p, k) => [p[0] * k, p[1] * k, p[2] * k];
const unit3 = (p) => mul3(p, 1 / (Math.hypot(...p) || 1));
const cross3 = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];

function capsuleFace(p, q, r, n) {
  const d = sub3(q, p);
  if (Math.hypot(...d) < 1e-6) return wireFace(assembleWire([makeCircle(r, p, n)])); // a dot
  const t = unit3(d), e = mul3(unit3(cross3(n, t)), r), tr = mul3(t, r);
  const wire = assembleWire([
    makeLine(add3(p, e), add3(q, e)),
    makeThreePointArc(add3(q, e), add3(q, tr), sub3(q, e)),
    makeLine(sub3(q, e), sub3(p, e)),
    makeThreePointArc(sub3(p, e), sub3(p, tr), add3(p, e)),
  ]);
  return wireFace(wire);
}

function strokeSolid(pts3, r, closed, dir, n) {
  const oc = getOC();
  const clean = pts3.filter((p, i) => i === 0 || Math.hypot(...sub3(p, pts3[i - 1])) > 1e-9);
  const ext = (face) => basicFaceExtrusion(face, new Vector(dir));
  // straight (or a single point): capsule from the first to the last point
  const t0 = clean.length > 1 ? unit3(sub3(clean[clean.length - 1], clean[0])) : null;
  const straight = !closed && (clean.length < 3 || clean.every((p) => Math.hypot(...cross3(sub3(p, clean[0]), t0)) < 1e-7));
  if (straight) return ext(capsuleFace(clean[0], clean[clean.length - 1] || clean[0], r, n));
  if (closed) clean[clean.length - 1] = clean[0];
  const edges = [];
  for (let i = 0; i + 1 < clean.length; i++) edges.push(makeLine(clean[i], clean[i + 1]));
  const wire = assembleWire(edges);
  const offset = (dist) => {
    const mk = new oc.BRepOffsetAPI_MakeOffset(wire.wrapped, oc.GeomAbs_JoinType.GeomAbs_Arc, false);
    mk.Perform(dist, 0);
    if (!mk.IsDone()) { mk.delete(); throw new Error('Could not outline a text stroke'); }
    const sh = cast(mk.Shape());
    mk.delete();
    if (sh instanceof Wire) return sh;
    const ws = sh.wires || [];
    if (ws.length) return ws.sort((x, y) => faceArea(y) - faceArea(x))[0];
    throw new Error('Could not outline a text stroke');
  };
  if (!closed) return ext(wireFace(offset(r)));
  const w1 = offset(r), w2 = offset(-r);
  const [outer, inner] = faceArea(w1) >= faceArea(w2) ? [w1, w2] : [w2, w1];
  return ext(wireFace(outer)).cut(ext(wireFace(inner)));
}
function wireFace(w) {
  const oc = getOC();
  const mk = new oc.BRepBuilderAPI_MakeFace(w.wrapped, true);
  const f = new Face(mk.Face());
  mk.delete();
  return f;
}
function faceArea(w) { try { return Math.abs(measureArea(wireFace(w))); } catch { return 0; } }

/**
 * Solid text on a plane. opts: { text, height, plane: {origin, xDir, normal}, x, y, angle (deg),
 * align, spacing (fraction of height), weight (stroke width / height), depth (signed, along the normal),
 * start (offset of the bottom face along the normal), font: 'builtin' | font id }
 */
export async function textSolid(opts) {
  let { text, height, plane, depth, start = 0 } = opts;
  // always extrude along the normal (an extrusion against the face orientation comes out inside-out)
  if (depth < 0) { start += depth; depth = -depth; }
  if (!String(text || '').trim()) throw new Error('Type some text');
  if (!(height > 0)) throw new Error('Text height must be positive');
  if (!depth) throw new Error('Depth must not be zero');
  const n = plane.normal, X = plane.xDir, Y = [n[1] * X[2] - n[2] * X[1], n[2] * X[0] - n[0] * X[2], n[0] * X[1] - n[1] * X[0]];
  const ca = Math.cos((opts.angle || 0) * D2R), sa = Math.sin((opts.angle || 0) * D2R);
  const to3 = (u, v, w = 0) => {
    const x = (opts.x || 0) + u * ca - v * sa, y = (opts.y || 0) + u * sa + v * ca;
    return [0, 1, 2].map((k) => plane.origin[k] + X[k] * x + Y[k] * y + n[k] * w);
  };
  const dir = n.map((v) => v * depth);
  if (opts.font && opts.font !== 'builtin') {
    // custom font through opentype.js (loaded into replicad under the font id)
    const sk = drawText(String(text), { startX: 0, startY: 0, fontSize: height * 1.42, fontFamily: opts.font });
    const bb = sk.boundingBox;
    const w = bb.width, lo = bb.bounds[0];
    const dx = opts.align === 'left' ? -lo[0] : opts.align === 'right' ? -lo[0] - w : -lo[0] - w / 2;
    const placed = sk.translate(dx, -lo[1]).rotate(opts.angle || 0, [0, 0]).translate(opts.x || 0, opts.y || 0);
    const pl = new Plane(to3Abs(plane, start), plane.xDir, plane.normal);
    return placed.sketchOnPlane(pl).extrude(depth);
  }
  const lay = strokeLayout(text, { spacing: opts.spacing || 0, align: opts.align || 'center' });
  const r = (height * (opts.weight || 0.125)) / 2;
  const solids = [];
  for (const s of lay.strokes) {
    const pts = s.map(([u, v]) => to3(u * height, v * height, start));
    solids.push(strokeSolid(pts, r, closedPoly(s), dir, n));
  }
  // overlapping strokes of a glyph fuse into one solid; glyphs are combined at the end
  let acc = null;
  for (const sld of solids.filter(Boolean)) acc = acc ? acc.fuse(sld) : sld;
  if (!acc) throw new Error('The text has no printable characters');
  return acc;
}
const to3Abs = (plane, w) => plane.origin.map((o, k) => o + plane.normal[k] * w);

const loaded = new Set();
export async function registerFont(id, buffer) {
  if (loaded.has(id)) return;
  await loadFont(buffer, id);
  loaded.add(id);
}
export const fontLoaded = (id) => loaded.has(id);
