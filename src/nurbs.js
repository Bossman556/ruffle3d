// Lightweight B-spline evaluation (de Boor) for live previews while CVs are dragged.
// Matches the kernel: clamped uniform knots for open curves / surfaces, uniform periodic for closed curves.

export function clampedKnots(n, deg) {
  const spans = n - deg, U = [];
  for (let i = 0; i <= deg; i++) U.push(0);
  for (let i = 1; i < spans; i++) U.push(i / spans);
  for (let i = 0; i <= deg; i++) U.push(1);
  return U;
}
const expand = (k, m) => k.flatMap((v, i) => Array(m[i]).fill(v));

function deBoor(deg, U, P, t) {
  // find span
  let k = deg;
  const last = U.length - deg - 2;
  while (k < last && t >= U[k + 1]) k++;
  const d = [];
  for (let j = 0; j <= deg; j++) d.push(P[k - deg + j].slice());
  for (let r = 1; r <= deg; r++) {
    for (let j = deg; j >= r; j--) {
      const i = k - deg + j;
      const den = U[i + deg - r + 1] - U[i];
      const a = den > 1e-12 ? (t - U[i]) / den : 0;
      for (let c = 0; c < d[j].length; c++) d[j][c] = (1 - a) * d[j - 1][c] + a * d[j][c];
    }
  }
  return d[deg];
}

/** Sampled points of a CV curve. */
export function curvePoints(cvs, deg, closed, samples = 160) {
  const n = cvs.length;
  if (n < 2) return cvs.slice();
  deg = Math.max(1, Math.min(deg, n - 1));
  let P = cvs, U, t0, t1;
  if (closed && n >= 3) {
    P = [...cvs, ...cvs.slice(0, deg)];
    U = Array.from({ length: P.length + deg + 1 }, (_, i) => i);
    t0 = deg; t1 = P.length;
  } else {
    U = clampedKnots(n, deg); t0 = 0; t1 = 1;
  }
  const out = [];
  for (let i = 0; i <= samples; i++) out.push(deBoor(deg, U, P, t0 + ((t1 - t0) * i) / samples - (i === samples ? 1e-9 : 0)));
  return out;
}

/** Iso-parametric lines of a CV surface: flat [x,y,z,x,y,z...] line-segment array. */
export function surfaceIsolines(cv, lines = 10, samples = 40) {
  const { nu, nv } = cv;
  const du = Math.max(1, Math.min(cv.du || 3, nu - 1)), dv = Math.max(1, Math.min(cv.dv || 3, nv - 1));
  const Uu = cv.uk ? expand(cv.uk, cv.um) : clampedKnots(nu, du);
  const Uv = cv.vk ? expand(cv.vk, cv.vm) : clampedKnots(nv, dv);
  const u0 = Uu[0], u1 = Uu[Uu.length - 1], v0 = Uv[0], v1 = Uv[Uv.length - 1];
  // rational surfaces are evaluated in homogeneous coordinates
  const W = cv.w?.length === nu * nv ? cv.w : null;
  const H = cv.poles.map((p, k) => (W ? [p[0] * W[k], p[1] * W[k], p[2] * W[k], W[k]] : p));
  const rows = [];
  for (let i = 0; i < nu; i++) rows.push(H.slice(i * nv, i * nv + nv));
  // column curve along u for a given v
  const at = (u, v) => {
    const col = rows.map((r) => deBoor(dv, Uv, r, v));
    const q = deBoor(du, Uu, col, u);
    return W ? [q[0] / q[3], q[1] / q[3], q[2] / q[3]] : q;
  };
  const clampT = (t, a, b) => Math.min(t, b - 1e-9 * (b - a));
  const seg = [];
  for (let l = 0; l <= lines; l++) {
    const v = clampT(v0 + ((v1 - v0) * l) / lines, v0, v1), u = clampT(u0 + ((u1 - u0) * l) / lines, u0, u1);
    let pu = null, pv = null;
    for (let s = 0; s <= samples; s++) {
      const t = s / samples;
      const a = at(clampT(u0 + (u1 - u0) * t, u0, u1), v), b = at(u, clampT(v0 + (v1 - v0) * t, v0, v1));
      if (pu) seg.push(...pu, ...a);
      if (pv) seg.push(...pv, ...b);
      pu = a; pv = b;
    }
  }
  return seg;
}
