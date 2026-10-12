// Wall thickness: for each vertex, cast a ray from the surface straight into the material (against
// the outward normal) and measure the distance to the opposite surface. A uniform grid over the
// triangles keeps it fast (Amanatides–Woo traversal, Möller–Trumbore intersection).

export function buildGrid(P, I) {
  const nt = I.length / 3;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P[i + k]); hi[k] = Math.max(hi[k], P[i + k]); }
  const size = [0, 1, 2].map((k) => Math.max(hi[k] - lo[k], 1e-6));
  // about one triangle per cell on average
  const cellVol = (size[0] * size[1] * size[2]) / Math.max(1, nt);
  const cs = Math.max(Math.cbrt(cellVol), Math.max(...size) / 256);
  const n = size.map((s) => Math.max(1, Math.min(256, Math.ceil(s / cs))));
  const cell = size.map((s, k) => s / n[k]);
  const lists = new Map();
  for (let t = 0; t < nt; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const r = [0, 1, 2].map((k) => {
      const mn = Math.min(P[a + k], P[b + k], P[c + k]), mx = Math.max(P[a + k], P[b + k], P[c + k]);
      return [Math.min(n[k] - 1, Math.max(0, Math.floor((mn - lo[k]) / cell[k]))), Math.min(n[k] - 1, Math.floor((mx - lo[k]) / cell[k]))];
    });
    for (let z = r[2][0]; z <= r[2][1]; z++) for (let y = r[1][0]; y <= r[1][1]; y++) for (let x = r[0][0]; x <= r[0][1]; x++) {
      const key = (z * n[1] + y) * n[0] + x;
      let l = lists.get(key);
      if (!l) lists.set(key, (l = []));
      l.push(t);
    }
  }
  return { P, I, lo, n, cell, lists, stamp: new Int32Array(nt).fill(-1) };
}

// Nearest hit distance along o + t·d (t > tMin), or Infinity.
export function castRay(G, o, d, tMin = 1e-6, rayId = 0) {
  const { P, I, lo, n, cell, lists, stamp } = G;
  // start cell (clamp the origin into the grid)
  const idx = [0, 1, 2].map((k) => Math.min(n[k] - 1, Math.max(0, Math.floor((o[k] - lo[k]) / cell[k]))));
  const step = d.map((v) => (v > 0 ? 1 : v < 0 ? -1 : 0));
  const tMax = [0, 1, 2].map((k) => (d[k] !== 0 ? ((lo[k] + (idx[k] + (step[k] > 0 ? 1 : 0)) * cell[k]) - o[k]) / d[k] : Infinity));
  const tDelta = [0, 1, 2].map((k) => (d[k] !== 0 ? Math.abs(cell[k] / d[k]) : Infinity));
  let best = Infinity;
  for (let guard = 0; guard < 2048; guard++) {
    const list = lists.get((idx[2] * n[1] + idx[1]) * n[0] + idx[0]);
    if (list) for (const t of list) {
      if (stamp[t] === rayId) continue;
      stamp[t] = rayId;
      const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
      const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
      const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
      const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-14) continue;
      const inv = 1 / det, sx = o[0] - P[a], sy = o[1] - P[a + 1], sz = o[2] - P[a + 2];
      const u = (sx * px + sy * py + sz * pz) * inv;
      if (u < -1e-9 || u > 1 + 1e-9) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
      if (v < -1e-9 || u + v > 1 + 1e-9) continue;
      const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (tt > tMin && tt < best) best = tt;
    }
    // advance to the next cell; stop once the best hit lies inside the cells already visited
    const k = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : tMax[1] < tMax[2] ? 1 : 2;
    if (best <= tMax[k]) break;
    idx[k] += step[k];
    if (idx[k] < 0 || idx[k] >= n[k]) break;
    tMax[k] += tDelta[k];
  }
  return best;
}

/** Thickness at each vertex of (P, N, I). Vertices whose inward ray escapes get NaN. */
export function wallThickness(P, N, I, onProgress = () => {}) {
  const G = buildGrid(P, I);
  const nv = P.length / 3, out = new Float32Array(nv);
  const eps = Math.max(...G.cell) * 1e-4;
  for (let v = 0; v < nv; v++) {
    const nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2], l = Math.hypot(nx, ny, nz) || 1;
    const d = [-nx / l, -ny / l, -nz / l];
    const o = [P[v * 3] + d[0] * eps, P[v * 3 + 1] + d[1] * eps, P[v * 3 + 2] + d[2] * eps];
    let t = castRay(G, o, d, eps, v * 3);
    // a ray along an edge can slip between triangles: retry with two slightly tilted rays
    if (!Number.isFinite(t)) {
      const a = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const u = [d[1] * a[2] - d[2] * a[1], d[2] * a[0] - d[0] * a[2], d[0] * a[1] - d[1] * a[0]];
      for (const s of [1e-3, -1e-3]) {
        const dj = [d[0] + u[0] * s, d[1] + u[1] * s, d[2] + u[2] * s], l2 = Math.hypot(...dj);
        t = Math.min(t, castRay(G, o, dj.map((x) => x / l2), eps, v * 3 + (s > 0 ? 1 : 2)));
      }
    }
    out[v] = Number.isFinite(t) ? t + eps : NaN;
    if (v % 4000 === 0) onProgress(v / nv);
  }
  return out;
}
