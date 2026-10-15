// Trim and offset for sketch splines (Catmull-Rom curves through fit points, drawn as cubic Béziers).
// A trimmed or offset spline is refitted: trimming keeps the fit points on the kept side plus the cut
// points; offsetting moves points along the curve (the fit points and three more per span) sideways by the distance.
import { intersect } from './model.js';

const bez = ([p0, c1, c2, p1], t) => {
  const u = 1 - t;
  return [0, 1].map((k) => u * u * u * p0[k] + 3 * u * u * t * c1[k] + 3 * u * t * t * c2[k] + t * t * t * p1[k]);
};
const bezTan = ([p0, c1, c2, p1], t) => {
  const u = 1 - t;
  return [0, 1].map((k) => 3 * u * u * (c1[k] - p0[k]) + 6 * u * t * (c2[k] - c1[k]) + 3 * t * t * (p1[k] - c2[k]));
};

/** Points along a spline geometry ({ bez }) with their arc length s, span index and span parameter. */
export function splineSamples(g, perSpan = 32) {
  const out = [];
  let s = 0, prev = null;
  g.bez.forEach((b, i) => {
    for (let k = 0; k <= perSpan; k++) { // each span starts with its fit point (repeating the previous end, length 0)
      const u = k / perSpan, p = bez(b, u);
      if (prev) s += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
      out.push({ p, s, span: i, u });
      prev = p;
    }
  });
  return out;
}

/** Arc length at the start of each fit point (the last entry is the full length; closed: the start again). */
export function fitPointLengths(samples, spans) {
  const at = new Array(spans + 1).fill(0);
  for (const q of samples) if (q.u === 0) at[q.span] = q.s;
  at[spans] = samples[samples.length - 1].s;
  return at;
}

/** Where a spline crosses other curve geometries: [{ s, p, other }] sorted by s. */
export function splineCrossings(samples, others) {
  const hits = [];
  for (const { id, g, samples: os } of others) {
    const segs = g.type === 'spline' ? os.slice(1).map((q, i) => ({ type: 'line', a: os[i].p, b: q.p })) : [g];
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i], line = { type: 'line', a: a.p, b: b.p };
      for (const og of segs) for (const x of intersect(line, og, 1e-9)) hits.push({ s: a.s + (b.s - a.s) * x.s, p: x.p, other: g.type === 'spline' ? null : id });
    }
  }
  hits.sort((x, y) => x.s - y.s);
  // the same crossing found on two neighbouring sample segments
  return hits.filter((h, i) => !i || h.s - hits[i - 1].s > 1e-6);
}

/**
 * Pieces left after trimming the part of a spline around arc length sClick.
 * fit: [{ id, xy }] fit points, lengths: their arc lengths; returns [{ pts: [{ id } | { xy, other }] }].
 * An open spline keeps what lies before and after the nearest crossings; a closed one keeps the loop
 * from the crossing after the click round to the crossing before it. No crossings: nothing is kept.
 */
export function trimSplinePieces(fit, lengths, closed, crossings, sClick, total) {
  const eps = 1e-6;
  const xs = crossings.filter((h) => closed || (h.s > eps && h.s < total - eps));
  if (!closed) {
    const lo = [...xs].reverse().find((h) => h.s < sClick), hi = xs.find((h) => h.s > sClick);
    if (!lo && !hi) return [];
    const pieces = [];
    if (lo) pieces.push({ pts: [...fit.filter((f, i) => lengths[i] < lo.s - eps).map((f) => ({ id: f.id })), { xy: lo.p, other: lo.other }] });
    if (hi) pieces.push({ pts: [{ xy: hi.p, other: hi.other }, ...fit.filter((f, i) => lengths[i] > hi.s + eps).map((f) => ({ id: f.id }))] });
    return pieces.filter((pc) => pc.pts.length >= 2);
  }
  if (xs.length < 2) return [];
  const hi = xs.find((h) => h.s > sClick) || xs[0];
  const lo = [...xs].reverse().find((h) => h.s < sClick) || xs[xs.length - 1];
  // fit points from hi forwards (wrapping past the start) up to lo
  const order = fit.map((f, i) => ({ f, s: lengths[i] }));
  const after = order.filter((x) => x.s > hi.s + eps), before = order.filter((x) => x.s < lo.s - eps);
  const middle = hi.s < lo.s ? order.filter((x) => x.s > hi.s + eps && x.s < lo.s - eps) : [...after, ...before];
  return [{ pts: [{ xy: hi.p, other: hi.other }, ...middle.map((x) => ({ id: x.f.id })), { xy: lo.p, other: lo.other }] }];
}

/** Which side of a spline a point is: +1 left of its direction, -1 right. */
export function splineSide(samples, p) {
  let best = 0, bd = Infinity;
  samples.forEach((q, i) => { const d = Math.hypot(q.p[0] - p[0], q.p[1] - p[1]); if (d < bd) { bd = d; best = i; } });
  const a = samples[Math.max(0, best - 1)].p, b = samples[Math.min(samples.length - 1, best + 1)].p, q = samples[best].p;
  const cr = (b[0] - a[0]) * (p[1] - q[1]) - (b[1] - a[1]) * (p[0] - q[0]);
  return cr >= 0 ? 1 : -1;
}

/** Fit points of a spline offset by d (positive: to the left of its direction): each fit point and three more per span. */
export function offsetSplinePoints(g, d) {
  const out = [];
  const push = (b, t) => {
    const p = bez(b, t), tg = bezTan(b, t), l = Math.hypot(tg[0], tg[1]) || 1;
    out.push([p[0] - (tg[1] / l) * d, p[1] + (tg[0] / l) * d]);
  };
  g.bez.forEach((b) => { for (const t of [0, 0.25, 0.5, 0.75]) push(b, t); });
  if (!g.closed) push(g.bez[g.bez.length - 1], 1);
  return out;
}
