// Geometric signatures of picked faces and edges, measured on display meshes. The kernel uses them to
// find the same face or edge again after the model changes (see matchPicks in kernel/build.js).
const r5 = (x) => +x.toFixed(5);

/** Face signature from a triangle range [start, start + count) of an indexed mesh. */
export function faceSigFromMesh(P, I, start, count) {
  let A = 0;
  const c = [0, 0, 0], n = [0, 0, 0], lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], ns = [];
  for (let q = start; q < start + count; q += 3) {
    const a = I[q] * 3, b = I[q + 1] * 3, d = I[q + 2] * 3;
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[d] - P[a], P[d + 1] - P[a + 1], P[d + 2] - P[a + 2]];
    const nn = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], ar = Math.hypot(...nn) / 2;
    A += ar;
    for (let k = 0; k < 3; k++) {
      c[k] += ((P[a + k] + P[b + k] + P[d + k]) / 3) * ar;
      n[k] += nn[k] / 2;
      for (const o of [a, b, d]) { lo[k] = Math.min(lo[k], P[o + k]); hi[k] = Math.max(hi[k], P[o + k]); }
    }
    if (ar > 1e-12) ns.push(nn.map((x) => x / (2 * ar)));
  }
  if (!(A > 0)) return null;
  const nl = Math.hypot(...n) || 1, nu = n.map((x) => x / nl);
  const planar = ns.every((x) => x[0] * nu[0] + x[1] * nu[1] + x[2] * nu[2] > 0.99999);
  return { k: 'f', c: c.map((x) => r5(x / A)), n: nu.map(r5), a: r5(A), pl: planar, b: [lo.map(r5), hi.map(r5)] };
}

/** Edge signature from an ordered list of polyline segments [[p, q], ...]. */
export function edgeSigFromSegments(segs) {
  if (!segs.length) return null;
  const L = segs.map(([p, q]) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2])), tot = L.reduce((s, x) => s + x, 0);
  let acc = 0, m = segs[0][0];
  for (let i = 0; i < segs.length; i++) { if (acc + L[i] >= tot / 2) { const t = L[i] ? (tot / 2 - acc) / L[i] : 0; m = segs[i][0].map((v, k) => v + (segs[i][1][k] - v) * t); break; } acc += L[i]; }
  const a = segs[0][0], z = segs[segs.length - 1][1];
  const d0 = [z[0] - a[0], z[1] - a[1], z[2] - a[2]], dl = Math.hypot(...d0) || 1, d = d0.map((x) => x / dl);
  const straight = Math.abs(dl - tot) < tot * 1e-6 && segs.every(([p, q], i) => { const s = [q[0] - p[0], q[1] - p[1], q[2] - p[2]].map((x) => x / (L[i] || 1)); return Math.abs(s[0] * d[0] + s[1] * d[1] + s[2] * d[2]) > 0.99999; });
  return { k: 'e', m: m.map(r5), d: d.map(r5), l: r5(tot), st: straight, a: a.map(r5), z: z.map(r5) };
}
