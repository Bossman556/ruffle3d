// Linear static stress analysis on a voxel mesh.
// The body's surface mesh is voxelised into equal cubes; each cube is an 8-node hexahedron with
// Wilson incompatible modes (statically condensed), which removes the shear locking of plain
// trilinear bricks so bending is accurate even with a few elements through the thickness.
// Because every element is the same cube, one 24×24 stiffness matrix serves the whole model and
// the system is solved matrix-free with Jacobi-preconditioned conjugate gradients.
// Units: mm, N, MPa.

const GP = [-1 / Math.sqrt(3), 1 / Math.sqrt(3)];
const NODE = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];

function elasticity(nu) {
  // E = 1; strain order xx, yy, zz, xy, yz, zx (engineering shear)
  const l = nu / ((1 + nu) * (1 - 2 * nu)), m = 1 / (2 * (1 + nu));
  const D = new Float64Array(36);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) D[i * 6 + j] = l + (i === j ? 2 * m : 0);
  for (let i = 3; i < 6; i++) D[i * 6 + i] = m;
  return D;
}

// Strain-displacement rows for a field with derivatives (dx, dy, dz) on dof slot `c` of `cols` columns.
function addB(B, cols, col, dx, dy, dz) {
  // u component (col), v (col+1), w (col+2)
  B[0 * cols + col] = dx; B[1 * cols + col + 1] = dy; B[2 * cols + col + 2] = dz;
  B[3 * cols + col] = dy; B[3 * cols + col + 1] = dx;
  B[4 * cols + col + 1] = dz; B[4 * cols + col + 2] = dy;
  B[5 * cols + col] = dz; B[5 * cols + col + 2] = dx;
}

// B matrix (6×24) of the compatible part at natural point (x, y, z) for a unit cube.
function bCompat(x, y, z) {
  const B = new Float64Array(6 * 24);
  NODE.forEach(([a, b, c], i) => {
    // N = (1 + aξ)(1 + bη)(1 + cζ)/8 ; d/dx = 2 d/dξ for a unit cube
    const dx = (a * (1 + b * y) * (1 + c * z)) / 4, dy = (b * (1 + a * x) * (1 + c * z)) / 4, dz = (c * (1 + a * x) * (1 + b * y)) / 4;
    addB(B, 24, i * 3, dx, dy, dz);
  });
  return B;
}

function invert(A, n) {
  const M = Float64Array.from(A), I = new Float64Array(n * n);
  for (let i = 0; i < n; i++) I[i * n + i] = 1;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n + c]) > Math.abs(M[p * n + c])) p = r;
    if (p !== c) for (let k = 0; k < n; k++) { [M[c * n + k], M[p * n + k]] = [M[p * n + k], M[c * n + k]]; [I[c * n + k], I[p * n + k]] = [I[p * n + k], I[c * n + k]]; }
    const d = M[c * n + c];
    for (let k = 0; k < n; k++) { M[c * n + k] /= d; I[c * n + k] /= d; }
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r * n + c];
      if (!f) continue;
      for (let k = 0; k < n; k++) { M[r * n + k] -= f * M[c * n + k]; I[r * n + k] -= f * I[c * n + k]; }
    }
  }
  return I;
}

/** Condensed 24×24 stiffness of a unit cube with E = 1 (scale by E·h for a cube of side h). */
export function hexStiffness(nu) {
  const D = elasticity(nu), n = 33;
  const K = new Float64Array(n * n);
  const detJ = 1 / 8;
  for (const x of GP) for (const y of GP) for (const z of GP) {
    const B = new Float64Array(6 * n);
    const Bc = bCompat(x, y, z);
    for (let r = 0; r < 6; r++) for (let c = 0; c < 24; c++) B[r * n + c] = Bc[r * 24 + c];
    // incompatible modes 1-ξ², 1-η², 1-ζ² for u, v, w: d/dx(1-ξ²) = -4ξ on a unit cube
    addB(B, n, 24, -4 * x, 0, 0);
    addB(B, n, 27, 0, -4 * y, 0);
    addB(B, n, 30, 0, 0, -4 * z);
    const DB = new Float64Array(6 * n);
    for (let r = 0; r < 6; r++) for (let c = 0; c < n; c++) { let s = 0; for (let k = 0; k < 6; k++) s += D[r * 6 + k] * B[k * n + c]; DB[r * n + c] = s; }
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) { let s = 0; for (let k = 0; k < 6; k++) s += B[k * n + a] * DB[k * n + b]; K[a * n + b] += s * detJ; }
  }
  const Kaa = new Float64Array(81);
  for (let a = 0; a < 9; a++) for (let b = 0; b < 9; b++) Kaa[a * 9 + b] = K[(24 + a) * n + 24 + b];
  const Ai = invert(Kaa, 9);
  const Kc = new Float64Array(576);
  for (let a = 0; a < 24; a++) for (let b = 0; b < 24; b++) {
    let s = 0;
    for (let i = 0; i < 9; i++) { let t = 0; for (let j = 0; j < 9; j++) t += Ai[i * 9 + j] * K[(24 + j) * n + b]; s += K[a * n + 24 + i] * t; }
    Kc[a * 24 + b] = K[a * n + b] - s;
  }
  // internal mode amplitudes α = R·u, used to recover strains at the corners
  const R = new Float64Array(9 * 24);
  for (let i = 0; i < 9; i++) for (let b = 0; b < 24; b++) { let t = 0; for (let j = 0; j < 9; j++) t += Ai[i * 9 + j] * K[(24 + j) * n + b]; R[i * 24 + b] = -t; }
  Kc.recover = R;
  return Kc;
}

// Strain operators (6×24, unit cube) at the 8 corners, including the condensed internal modes.
function cornerStrain(R) {
  return NODE.map(([x, y, z]) => {
    const Bc = bCompat(x, y, z), Ba = new Float64Array(6 * 9);
    addB(Ba, 9, 0, -4 * x, 0, 0); addB(Ba, 9, 3, 0, -4 * y, 0); addB(Ba, 9, 6, 0, 0, -4 * z);
    const out = new Float64Array(6 * 24);
    for (let r = 0; r < 6; r++) for (let b = 0; b < 24; b++) { let t = Bc[r * 24 + b]; for (let i = 0; i < 9; i++) t += Ba[r * 9 + i] * R[i * 24 + b]; out[r * 24 + b] = t; }
    return out;
  });
}
const vonMises = (sg) => Math.sqrt(0.5 * ((sg[0] - sg[1]) ** 2 + (sg[1] - sg[2]) ** 2 + (sg[2] - sg[0]) ** 2) + 3 * (sg[3] ** 2 + sg[4] ** 2 + sg[5] ** 2));

// ---------- voxelisation ----------
function triangles(positions, index) {
  const nt = index ? index.length / 3 : positions.length / 9;
  const at = (t, k) => (index ? index[t * 3 + k] : t * 3 + k);
  return { nt, at };
}

/**
 * Voxel grid of a closed triangle mesh. Each cell gets the fraction of its volume inside the mesh,
 * measured with S×S rays along X per cell row (exact coverage along each ray). Cells with a fraction
 * above `minFrac` are solid; their stiffness is scaled by the fraction, so boundaries that cut
 * through cells keep close to their true position.
 */
export function voxelize(positions, index, h, pad = 1, S = 3, minFrac = 0.02) {
  const { nt, at } = triangles(positions, index);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], positions[i + k]); hi[k] = Math.max(hi[k], positions[i + k]); }
  // the grid starts exactly at the bounding-box minimum, so faces there (and, with a matching h,
  // the opposite faces) fall on cell boundaries
  const n = [0, 1, 2].map((k) => Math.max(1, Math.ceil((hi[k] - lo[k]) / h - 1e-9)) + 2 * pad);
  const origin = [0, 1, 2].map((k) => lo[k] - pad * h);
  const [nx, ny, nz] = n;
  const NYs = ny * S, NZs = nz * S, hs = h / S;
  const rows = Array.from({ length: NYs * NZs }, () => []);
  // a tiny irrational offset keeps rays off mesh edges and vertices
  const oy = hs * 0.0013617, oz = hs * 0.0021933;
  for (let t = 0; t < nt; t++) {
    const a = at(t, 0) * 3, b = at(t, 1) * 3, c = at(t, 2) * 3;
    const A = [positions[a], positions[a + 1], positions[a + 2]], B = [positions[b], positions[b + 1], positions[b + 2]], C = [positions[c], positions[c + 1], positions[c + 2]];
    const j0 = Math.max(0, Math.floor((Math.min(A[1], B[1], C[1]) - origin[1]) / hs - 0.5)), j1 = Math.min(NYs - 1, Math.ceil((Math.max(A[1], B[1], C[1]) - origin[1]) / hs - 0.5));
    const k0 = Math.max(0, Math.floor((Math.min(A[2], B[2], C[2]) - origin[2]) / hs - 0.5)), k1 = Math.min(NZs - 1, Math.ceil((Math.max(A[2], B[2], C[2]) - origin[2]) / hs - 0.5));
    const det = (B[1] - A[1]) * (C[2] - A[2]) - (C[1] - A[1]) * (B[2] - A[2]);
    if (Math.abs(det) < 1e-14) continue;
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) {
      const y = origin[1] + (j + 0.5) * hs + oy, z = origin[2] + (k + 0.5) * hs + oz;
      const u = ((y - A[1]) * (C[2] - A[2]) - (C[1] - A[1]) * (z - A[2])) / det;
      const v = ((B[1] - A[1]) * (z - A[2]) - (y - A[1]) * (B[2] - A[2])) / det;
      if (u < 0 || v < 0 || u + v > 1) continue;
      rows[k * NYs + j].push(A[0] + u * (B[0] - A[0]) + v * (C[0] - A[0]));
    }
  }
  const frac = new Float32Array(nx * ny * nz), w = 1 / (S * S * h);
  for (let k = 0; k < NZs; k++) for (let j = 0; j < NYs; j++) {
    const xs = rows[k * NYs + j].sort((p, q) => p - q), cell = (Math.floor(k / S) * ny + Math.floor(j / S)) * nx;
    for (let s = 0; s + 1 < xs.length; s += 2) {
      const a = (xs[s] - origin[0]) / h, b = (xs[s + 1] - origin[0]) / h;
      for (let i = Math.max(0, Math.floor(a)); i <= Math.min(nx - 1, Math.floor(b)); i++) frac[cell + i] += (Math.min(b, i + 1) - Math.max(a, i)) * h * w;
    }
  }
  const solid = new Uint8Array(nx * ny * nz);
  for (let i = 0; i < frac.length; i++) { if (frac[i] > 1) frac[i] = 1; solid[i] = frac[i] > minFrac ? 1 : 0; }
  return { n, origin, h, solid, frac };
}

// ---------- boundary conditions from mesh faces ----------
// Samples the triangles of the given faces at about h/2 spacing; each sample carries its area and
// outward normal and is snapped to the nearest active node.
function faceSamples(positions, index, faceGroups, faces, h, sign) {
  const out = [];
  for (const fi of faces) {
    const g = faceGroups[fi];
    if (!g) continue;
    for (let q = g.start; q < g.start + g.count; q += 3) {
      const ia = (index ? index[q] : q) * 3, ib = (index ? index[q + 1] : q + 1) * 3, ic = (index ? index[q + 2] : q + 2) * 3;
      const A = [positions[ia], positions[ia + 1], positions[ia + 2]], B = [positions[ib], positions[ib + 1], positions[ib + 2]], C = [positions[ic], positions[ic + 1], positions[ic + 2]];
      const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      const nrm = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const a2 = Math.hypot(...nrm);
      if (a2 < 1e-14) continue;
      const nn = nrm.map((x) => (sign * x) / a2);
      const m = Math.max(1, Math.ceil(Math.max(Math.hypot(...u), Math.hypot(...v), Math.hypot(C[0] - B[0], C[1] - B[1], C[2] - B[2])) / (h / 2)));
      const pts = [];
      for (let i = 0; i < m; i++) for (let j = 0; j < m - i; j++) {
        // centroids of the m² sub-triangles (upright ones; the inverted ones are covered by spacing)
        const s = (i + 1 / 3) / m, t = (j + 1 / 3) / m;
        pts.push([A[0] + s * u[0] + t * v[0], A[1] + s * u[1] + t * v[1], A[2] + s * u[2] + t * v[2]]);
      }
      const area = a2 / 2 / pts.length;
      for (const p of pts) out.push({ p, n: nn, area });
    }
  }
  return out;
}

// ---------- display mesh ----------
/**
 * Subdivides each triangle into m² smaller ones so no edge is longer than `target`, so results can
 * be shown smoothly on large flat faces. Face groups (index ranges per CAD face) are carried over.
 */
export function refineMesh(positions, normals, index, faceGroups, target, maxTris = 600000) {
  const { nt, at } = triangles(positions, index);
  const edge = (a, b) => Math.hypot(positions[a * 3] - positions[b * 3], positions[a * 3 + 1] - positions[b * 3 + 1], positions[a * 3 + 2] - positions[b * 3 + 2]);
  const longest = new Float64Array(nt);
  for (let t = 0; t < nt; t++) { const a = at(t, 0), b = at(t, 1), c = at(t, 2); longest[t] = Math.max(edge(a, b), edge(b, c), edge(c, a)); }
  const mOf = (tg) => Uint16Array.from(longest, (L) => Math.min(64, Math.max(1, Math.ceil(L / tg))));
  let ms = mOf(target), total = ms.reduce((s, m) => s + m * m, 0);
  if (total > maxTris) { ms = mOf(target * Math.sqrt(total / maxTris)); total = ms.reduce((s, m) => s + m * m, 0); }
  let nv = 0;
  for (let t = 0; t < nt; t++) nv += ((ms[t] + 1) * (ms[t] + 2)) / 2;
  const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), I = new Uint32Array(total * 3), triStart = new Uint32Array(nt + 1);
  let v = 0, q = 0;
  for (let t = 0; t < nt; t++) {
    const m = ms[t], ia = at(t, 0), ib = at(t, 1), ic = at(t, 2), v0 = v;
    triStart[t] = q;
    const id = (i, j) => v0 + (i * (2 * m + 3 - i)) / 2 + j; // row i has m + 1 - i vertices
    for (let i = 0; i <= m; i++) for (let j = 0; j <= m - i; j++) {
      const s = i / m, r = j / m, w = 1 - s - r;
      for (let k = 0; k < 3; k++) {
        P[v * 3 + k] = w * positions[ia * 3 + k] + s * positions[ib * 3 + k] + r * positions[ic * 3 + k];
        N[v * 3 + k] = normals ? w * normals[ia * 3 + k] + s * normals[ib * 3 + k] + r * normals[ic * 3 + k] : 0;
      }
      if (normals) { const l = Math.hypot(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]) || 1; N[v * 3] /= l; N[v * 3 + 1] /= l; N[v * 3 + 2] /= l; }
      v++;
    }
    for (let i = 0; i < m; i++) for (let j = 0; j < m - i; j++) {
      I[q++] = id(i, j); I[q++] = id(i + 1, j); I[q++] = id(i, j + 1);
      if (j < m - i - 1) { I[q++] = id(i + 1, j); I[q++] = id(i + 1, j + 1); I[q++] = id(i, j + 1); }
    }
  }
  triStart[nt] = q;
  const groups = (faceGroups || []).map((g) => ({ ...g, start: triStart[g.start / 3], count: triStart[(g.start + g.count) / 3] - triStart[g.start / 3] }));
  return { positions: P, normals: N, index: I, faceGroups: groups };
}

// ---------- multigrid ----------
// Stencil product y = A·x over the rows in `rows` (other entries of y are left at zero).
function stencilMul(L, x, y) {
  y.fill(0);
  const { rows, nbr, blk } = L;
  for (let q = 0; q < rows.length; q++) {
    const n = rows[q], nb = n * 27, base = n * 243;
    let s0 = 0, s1 = 0, s2 = 0;
    for (let t = 0; t < 27; t++) {
      const m = nbr[nb + t];
      if (m < 0) continue;
      const x0 = x[m * 3], x1 = x[m * 3 + 1], x2 = x[m * 3 + 2], o = base + t * 9;
      s0 += blk[o] * x0 + blk[o + 1] * x1 + blk[o + 2] * x2;
      s1 += blk[o + 3] * x0 + blk[o + 4] * x1 + blk[o + 5] * x2;
      s2 += blk[o + 6] * x0 + blk[o + 7] * x1 + blk[o + 8] * x2;
    }
    y[n * 3] = s0; y[n * 3 + 1] = s1; y[n * 3 + 2] = s2;
  }
}

// Coarse level: cells merge 2×2×2; each coarse brick is weighted by the solid fraction of its children.
function coarseLevel(dimsF, fracF, h, Kc, E) {
  const [fx, fy, fz] = dimsF, dims = [Math.ceil(fx / 2), Math.ceil(fy / 2), Math.ceil(fz / 2)];
  const [nx, ny, nz] = dims, frac = new Float32Array(nx * ny * nz);
  for (let k = 0; k < fz; k++) for (let j = 0; j < fy; j++) for (let i = 0; i < fx; i++) {
    const v = fracF[(k * fy + j) * fx + i];
    if (v) frac[((k >> 1) * ny + (j >> 1)) * nx + (i >> 1)] += v / 8;
  }
  const NX = nx + 1, NY = ny + 1, NZ = nz + 1, gridId = new Int32Array(NX * NY * NZ).fill(-1);
  const corner = NODE.map(([a, b, c]) => [(a + 1) / 2, (b + 1) / 2, (c + 1) / 2]);
  let nn = 0;
  const cells = [];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (frac[(k * ny + j) * nx + i] > 0) cells.push(i, j, k);
  const ids = new Int32Array(cells.length / 3 * 8);
  for (let c = 0; c < cells.length / 3; c++) for (let a = 0; a < 8; a++) {
    const g = ((cells[c * 3 + 2] + corner[a][2]) * NY + cells[c * 3 + 1] + corner[a][1]) * NX + cells[c * 3] + corner[a][0];
    if (gridId[g] < 0) gridId[g] = nn++;
    ids[c * 8 + a] = gridId[g];
  }
  const nbr = new Int32Array(nn * 27).fill(-1), blk = new Float64Array(nn * 243);
  const sc = E * h * 2;
  for (let c = 0; c < cells.length / 3; c++) {
    const i = cells[c * 3], j = cells[c * 3 + 1], k = cells[c * 3 + 2], w = sc * frac[(k * ny + j) * nx + i];
    for (let a = 0; a < 8; a++) {
      const A = ids[c * 8 + a];
      for (let b = 0; b < 8; b++) {
        const t = (corner[b][2] - corner[a][2] + 1) * 9 + (corner[b][1] - corner[a][1] + 1) * 3 + (corner[b][0] - corner[a][0] + 1);
        nbr[A * 27 + t] = ids[c * 8 + b];
        const o = A * 243 + t * 9;
        for (let r = 0; r < 3; r++) for (let cc = 0; cc < 3; cc++) blk[o + r * 3 + cc] += Kc[(a * 3 + r) * 24 + b * 3 + cc] * w;
      }
    }
  }
  return { dims, frac, h: h * 2, gridId, NX, NY, nn, nbr, blk };
}

// Trilinear prolongation from coarse nodes to the fine level's nodes (≤ 8 coarse nodes each).
function prolongation(fineIJK, nnF, C) {
  const idx = new Int32Array(nnF * 8).fill(-1), w = new Float64Array(nnF * 8);
  for (let n = 0; n < nnF; n++) {
    const opts = [0, 1, 2].map((d) => { const I = fineIJK[n * 3 + d]; return I % 2 ? [[(I - 1) / 2, 0.5], [(I + 1) / 2, 0.5]] : [[I / 2, 1]]; });
    let s = 0;
    for (const [i, wi] of opts[0]) for (const [j, wj] of opts[1]) for (const [k, wk] of opts[2]) {
      const id = C.gridId[(k * C.NY + j) * C.NX + i];
      if (id < 0) continue;
      idx[n * 8 + s] = id; w[n * 8 + s] = wi * wj * wk; s++;
    }
  }
  return { idx, w };
}

// ---------- model: mesh, boundary conditions, assembly and solver ----------
/**
 * Voxel finite-element model of one body.
 * opts: { positions, index, faceGroups, E (MPa), nu, elements (target count), fixed: [faceIndex],
 *         loads: [{ faces, type: 'force'|'pressure', value, dir }], onProgress }
 * Returns an object with assemble(weights), solve(rhs, x0), stresses(u) and sampling helpers.
 */
export function buildModel(opts) {
  const { positions, index, faceGroups, E, elements = 20000, fixed = [], loads = [], onProgress = () => {} } = opts;
  const nu = Math.min(Math.max(opts.nu ?? 0.3, 0), 0.45); // near-incompressible materials lock; cap ν
  if (!fixed.length) throw new Error('Add at least one fixed face so the part cannot float away');
  // mesh volume (sign tells which way the triangle normals face)
  const { nt, at } = triangles(positions, index);
  let vol = 0;
  for (let t = 0; t < nt; t++) {
    const a = at(t, 0) * 3, b = at(t, 1) * 3, c = at(t, 2) * 3;
    vol += (positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1]) - positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c]) + positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c])) / 6;
  }
  const sign = vol < 0 ? -1 : 1;
  vol = Math.abs(vol);
  if (vol < 1e-9) throw new Error('The body has no volume');
  // element size: about `elements` cells, rounded so the thinnest overall dimension is a whole number
  // of cells (plates and beams then have exact faces in their bending direction)
  const blo = [Infinity, Infinity, Infinity], bhi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) { blo[k] = Math.min(blo[k], positions[i + k]); bhi[k] = Math.max(bhi[k], positions[i + k]); }
  const thin = Math.min(...[0, 1, 2].map((k) => bhi[k] - blo[k]));
  const snap = (hh) => thin / Math.max(2, Math.round(thin / hh));
  let h = snap(Math.cbrt(vol / elements));
  onProgress(0.02, 'Meshing');
  let vox = voxelize(positions, index, h);
  const count = (s) => s.reduce((a, b) => a + b, 0); // solid cells
  let nsolid = count(vox.solid);
  // thin-walled parts can voxelise to too few cells; refine until the count is near the target
  for (let tries = 0; tries < 3 && nsolid < elements * 0.6; tries++) { h = snap(h * (Math.cbrt(nsolid / elements) || 0.7)); vox = voxelize(positions, index, h); nsolid = count(vox.solid); }
  if (nsolid < 8) throw new Error('The part is too thin to mesh at this resolution; choose a finer mesh');
  const [nx, ny, nz] = vox.n, O = vox.origin;
  const NX = nx + 1, NY = ny + 1, NZ = nz + 1;
  const gnode = (i, j, k) => (k * NY + j) * NX + i;
  const cornerOff = NODE.map(([a, b, c]) => [(a + 1) / 2, (b + 1) / 2, (c + 1) / 2]);

  // active nodes and element connectivity
  const nodeId = new Int32Array(NX * NY * NZ).fill(-1);
  const elems = [];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (vox.solid[(k * ny + j) * nx + i]) elems.push(i, j, k);
  const ne = elems.length / 3;
  const conn = new Int32Array(ne * 8), efrac = new Float64Array(ne);
  for (let e = 0; e < ne; e++) efrac[e] = vox.frac[(elems[e * 3 + 2] * ny + elems[e * 3 + 1]) * nx + elems[e * 3]];
  let nn = 0;
  for (let e = 0; e < ne; e++) {
    const i = elems[e * 3], j = elems[e * 3 + 1], k = elems[e * 3 + 2];
    for (let c = 0; c < 8; c++) {
      const g = gnode(i + cornerOff[c][0], j + cornerOff[c][1], k + cornerOff[c][2]);
      if (nodeId[g] < 0) nodeId[g] = nn++;
      conn[e * 8 + c] = nodeId[g];
    }
  }
  const nodeXYZ = new Float64Array(nn * 3), nodeIJK = new Int32Array(nn * 3);
  for (let k = 0; k < NZ; k++) for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const id = nodeId[gnode(i, j, k)];
    if (id >= 0) {
      nodeXYZ[id * 3] = O[0] + i * h; nodeXYZ[id * 3 + 1] = O[1] + j * h; nodeXYZ[id * 3 + 2] = O[2] + k * h;
      nodeIJK[id * 3] = i; nodeIJK[id * 3 + 1] = j; nodeIJK[id * 3 + 2] = k;
    }
  }
  const nearestNode = (p, r = 2) => {
    const fi = Math.round((p[0] - O[0]) / h), fj = Math.round((p[1] - O[1]) / h), fk = Math.round((p[2] - O[2]) / h);
    let best = -1, bd = Infinity;
    for (let dk = -r; dk <= r; dk++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const i = fi + di, j = fj + dj, k = fk + dk;
      if (i < 0 || j < 0 || k < 0 || i >= NX || j >= NY || k >= NZ) continue;
      const id = nodeId[gnode(i, j, k)];
      if (id < 0) continue;
      const d = (nodeXYZ[id * 3] - p[0]) ** 2 + (nodeXYZ[id * 3 + 1] - p[1]) ** 2 + (nodeXYZ[id * 3 + 2] - p[2]) ** 2;
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  };

  // boundary conditions
  const ndof = nn * 3;
  const isFixed = new Uint8Array(nn), isLoaded = new Uint8Array(nn);
  let nFixed = 0;
  for (const s of faceSamples(positions, index, faceGroups, fixed, h, sign)) {
    const id = nearestNode(s.p);
    if (id >= 0 && !isFixed[id]) { isFixed[id] = 1; nFixed++; }
  }
  if (!nFixed) throw new Error('The fixed faces could not be found on the mesh');
  const f = new Float64Array(ndof);
  const applied = [0, 0, 0];
  for (const L of loads) {
    const samples = faceSamples(positions, index, faceGroups, L.faces, h, sign);
    const area = samples.reduce((a, s) => a + s.area, 0);
    if (!area) continue;
    for (const s of samples) {
      const id = nearestNode(s.p);
      if (id < 0) continue;
      let F;
      if (L.type === 'pressure') F = s.n.map((x) => -x * L.value * s.area); // pressure pushes into the surface
      else if (L.dir === 'normal' || !L.dir) F = s.n.map((x) => (-x * L.value * s.area) / area);
      else { const d = Math.hypot(...L.dir) || 1; F = L.dir.map((x) => (x / d) * L.value * (s.area / area)); }
      for (let c = 0; c < 3; c++) { f[id * 3 + c] += F[c]; applied[c] += F[c]; }
      isLoaded[id] = 1;
    }
  }

  // drop islands that are not connected to a fixed node (they would make the system singular)
  const parent = Int32Array.from({ length: nn }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let e = 0; e < ne; e++) { const r0 = find(conn[e * 8]); for (let c = 1; c < 8; c++) { const r = find(conn[e * 8 + c]); if (r !== r0) parent[r] = r0; } }
  const anchored = new Uint8Array(nn);
  for (let i = 0; i < nn; i++) if (isFixed[i]) anchored[find(i)] = 1;
  const keep = new Uint8Array(ne);
  let dropped = 0;
  for (let e = 0; e < ne; e++) { keep[e] = anchored[find(conn[e * 8])]; if (!keep[e]) dropped++; }
  const live = new Uint8Array(nn);
  for (let e = 0; e < ne; e++) if (keep[e]) for (let c = 0; c < 8; c++) live[conn[e * 8 + c]] = 1;
  for (let i = 0; i < nn; i++) if (!live[i]) { f[i * 3] = f[i * 3 + 1] = f[i * 3 + 2] = 0; }
  const free = new Uint8Array(ndof);
  for (let i = 0; i < nn; i++) if (live[i] && !isFixed[i]) free[i * 3] = free[i * 3 + 1] = free[i * 3 + 2] = 1;
  const rows = Int32Array.from({ length: nn }, (_, i) => i).filter((i) => live[i] && !isFixed[i]);
  const Kc = hexStiffness(nu);
  const scale = E * h;

  const M = {
    h, O, dims: [nx, ny, nz], NX, NY, NZ, nodeId, gnode, cornerOff, nn, ne, ndof, conn, elems, efrac, keep, live, isFixed, isLoaded,
    free, rows, nodeXYZ, nodeIJK, nearestNode, f, applied, nFixed, dropped, Kc, E, nu, vol, positions, index, faceGroups, onProgress,
  };

  /** Assembles K with element weights w[e] (stiffness multipliers on top of the cut-cell fraction). */
  M.assemble = (w = null) => {
    const nbr = new Int32Array(nn * 27).fill(-1), blk = new Float64Array(nn * 243);
    const cw = new Float64Array(ne);
    for (let e = 0; e < ne; e++) cw[e] = keep[e] ? efrac[e] * (w ? w[e] : 1) : 0;
    for (let e = 0; e < ne; e++) {
      if (!keep[e]) continue;
      const se = scale * cw[e];
      for (let a = 0; a < 8; a++) {
        const A = conn[e * 8 + a];
        for (let b = 0; b < 8; b++) {
          const t = (cornerOff[b][2] - cornerOff[a][2] + 1) * 9 + (cornerOff[b][1] - cornerOff[a][1] + 1) * 3 + (cornerOff[b][0] - cornerOff[a][0] + 1);
          nbr[A * 27 + t] = conn[e * 8 + b];
          const o = A * 243 + t * 9;
          for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) blk[o + r * 3 + c] += Kc[(a * 3 + r) * 24 + b * 3 + c] * se;
        }
      }
    }
    const diag = new Float64Array(ndof);
    for (let n = 0; n < nn; n++) for (let d = 0; d < 3; d++) diag[n * 3 + d] = blk[n * 243 + 13 * 9 + d * 4] || 1;
    // multigrid hierarchy: cells merge 2×2×2, weighted by their children's stiffness
    const L0 = { nn, nbr, blk, rows, free, diag, ijk: nodeIJK, dims: [nx, ny, nz] };
    const fracF = new Float32Array(nx * ny * nz);
    for (let e = 0; e < ne; e++) if (keep[e]) fracF[(elems[e * 3 + 2] * ny + elems[e * 3 + 1]) * nx + elems[e * 3]] = cw[e];
    const levels = [L0];
    let fr = fracF;
    while (opts.multigrid !== false && levels.length < 7 && levels[levels.length - 1].nn > 1200 && levels[levels.length - 1].dims.some((d) => d > 2)) {
      const F = levels[levels.length - 1];
      const C = coarseLevel(F.dims, fr, h * 2 ** (levels.length - 1), Kc, E);
      C.ijk = new Int32Array(C.nn * 3);
      for (let k = 0; k <= C.dims[2]; k++) for (let j = 0; j <= C.dims[1]; j++) for (let i = 0; i <= C.dims[0]; i++) {
        const id = C.gridId[(k * C.NY + j) * C.NX + i];
        if (id >= 0) { C.ijk[id * 3] = i; C.ijk[id * 3 + 1] = j; C.ijk[id * 3 + 2] = k; }
      }
      F.P = prolongation(F.ijk, F.nn, C);
      // a coarse node is held if any fine node it feeds is held (over-constraining is safe here)
      const cfree = new Uint8Array(C.nn * 3).fill(1);
      for (let n = 0; n < F.nn; n++) if (!F.free[n * 3]) for (let s = 0; s < 8; s++) { const id = F.P.idx[n * 8 + s]; if (id >= 0) cfree[id * 3] = cfree[id * 3 + 1] = cfree[id * 3 + 2] = 0; }
      C.free = cfree;
      C.rows = Int32Array.from({ length: C.nn }, (_, i) => i).filter((i) => cfree[i * 3]);
      C.diag = new Float64Array(C.nn * 3);
      for (let m = 0; m < C.nn; m++) for (let d = 0; d < 3; d++) C.diag[m * 3 + d] = C.blk[m * 243 + 13 * 9 + d * 4] || 1;
      levels.push(C);
      fr = C.frac;
    }
    for (const Lv of levels) { const N = Lv.nn * 3; Lv.t1 = new Float64Array(N); Lv.t2 = new Float64Array(N); Lv.rc = new Float64Array(N); Lv.zc = new Float64Array(N); }
    // damped Jacobi needs ω < 2/λmax(D⁻¹A) to smooth; cut cells widen the spectrum, so λmax is
    // estimated per level with a few power iterations and ω = 1/λmax
    for (const Lv of levels) {
      const N = Lv.nn * 3, x = new Float64Array(N), y = Lv.t1;
      for (let i = 0; i < N; i++) x[i] = Lv.free[i] ? Math.sin(i * 12.9898 + 1) * 0.5 + 0.75 : 0;
      let lam = 1;
      for (let k = 0; k < 12; k++) {
        stencilMul(Lv, x, y);
        let sx = 0, sy = 0;
        for (let i = 0; i < N; i++) { if (!Lv.free[i]) { y[i] = 0; continue; } y[i] /= Lv.diag[i]; sy += y[i] * y[i]; sx += x[i] * x[i]; }
        lam = Math.sqrt(sy / (sx || 1));
        const s = 1 / (Math.sqrt(sy) || 1);
        for (let i = 0; i < N; i++) x[i] = y[i] * s;
      }
      Lv.omega = 1 / (lam * 1.1 || 1);
    }
    M.L0 = L0; M.levels = levels; M.diag = diag; M.cw = cw;
  };

  const NU = 2;
  const smooth = (Lv, rhs, zz) => {
    for (let s = 0; s < NU; s++) {
      stencilMul(Lv, zz, Lv.t1);
      for (let i = 0; i < zz.length; i++) if (Lv.free[i]) zz[i] += (Lv.omega * (rhs[i] - Lv.t1[i])) / Lv.diag[i];
    }
  };
  const coarseSolve = (Lv, rhs, zz) => {
    // Jacobi-preconditioned CG to a loose tolerance (the outer solver is flexible CG)
    const N = zz.length, rr = Float64Array.from(rhs, (v, i) => (Lv.free[i] ? v : 0)), pp = new Float64Array(N), qq = Lv.t1;
    zz.fill(0);
    let zr = 0;
    for (let i = 0; i < N; i++) { pp[i] = Lv.free[i] ? rr[i] / Lv.diag[i] : 0; zr += rr[i] * pp[i]; }
    const r0 = Math.sqrt(rr.reduce((a, v) => a + v * v, 0)) || 1;
    for (let k = 0; k < 120; k++) {
      stencilMul(Lv, pp, qq);
      let pq = 0;
      for (let i = 0; i < N; i++) pq += pp[i] * qq[i];
      if (!(pq > 0)) break;
      const al = zr / pq;
      let rn = 0;
      for (let i = 0; i < N; i++) { zz[i] += al * pp[i]; rr[i] -= al * qq[i]; rn += rr[i] * rr[i]; }
      if (Math.sqrt(rn) < 1e-3 * r0) break;
      let zr2 = 0;
      for (let i = 0; i < N; i++) { const zi = Lv.free[i] ? rr[i] / Lv.diag[i] : 0; Lv.t2[i] = zi; zr2 += rr[i] * zi; }
      const be = zr2 / zr;
      zr = zr2;
      for (let i = 0; i < N; i++) pp[i] = Lv.t2[i] + be * pp[i];
    }
  };
  const vcycle = (l, rhs, zz) => {
    const levels = M.levels, Lv = levels[l];
    if (l === levels.length - 1) return coarseSolve(Lv, rhs, zz);
    zz.fill(0);
    smooth(Lv, rhs, zz);
    stencilMul(Lv, zz, Lv.t1);
    const C = levels[l + 1], rc = C.rc, zc = C.zc, P = Lv.P;
    rc.fill(0);
    for (let n = 0; n < Lv.nn; n++) {
      if (!Lv.free[n * 3]) continue;
      const r0 = rhs[n * 3] - Lv.t1[n * 3], r1 = rhs[n * 3 + 1] - Lv.t1[n * 3 + 1], r2 = rhs[n * 3 + 2] - Lv.t1[n * 3 + 2];
      for (let s = 0; s < 8; s++) { const id = P.idx[n * 8 + s]; if (id < 0) break; const w = P.w[n * 8 + s]; rc[id * 3] += w * r0; rc[id * 3 + 1] += w * r1; rc[id * 3 + 2] += w * r2; }
    }
    for (let i = 0; i < rc.length; i++) if (!C.free[i]) rc[i] = 0;
    vcycle(l + 1, rc, zc);
    for (let n = 0; n < Lv.nn; n++) {
      if (!Lv.free[n * 3]) continue;
      for (let s = 0; s < 8; s++) { const id = P.idx[n * 8 + s]; if (id < 0) break; const w = P.w[n * 8 + s]; zz[n * 3] += w * zc[id * 3]; zz[n * 3 + 1] += w * zc[id * 3 + 1]; zz[n * 3 + 2] += w * zc[id * 3 + 2]; }
    }
    smooth(Lv, rhs, zz);
  };
  M.matvec = (x, y) => stencilMul(M.L0, x, y);

  const r = new Float64Array(ndof), z = new Float64Array(ndof), p = new Float64Array(ndof), q = new Float64Array(ndof), rOld = new Float64Array(ndof);
  /** Solves K u = rhs (warm start from x0). Returns { u, iterations, residual, converged }. */
  M.solve = (rhs, x0 = null, { tol = 1e-6, report = true, label = 'Solving' } = {}) => {
    const u = x0 ? Float64Array.from(x0) : new Float64Array(ndof);
    const fn = Math.sqrt(rhs.reduce((a, v, i) => a + (free[i] ? v * v : 0), 0));
    if (!(fn > 0)) throw new Error('The loads act only on fixed faces, so nothing moves');
    let it = 0, rel = 1, total = 0;
    const jacobi = (rr, zz) => { for (let i = 0; i < ndof; i++) zz[i] = free[i] ? rr[i] / M.diag[i] : 0; };
    const runCG = (precond, maxIter, every, start) => {
      if (start) u.set(start); else u.fill(0);
      M.matvec(u, q);
      for (let i = 0; i < ndof; i++) r[i] = free[i] ? rhs[i] - q[i] : 0;
      precond(r, z);
      p.set(z);
      let rz = 0;
      for (let i = 0; i < ndof; i++) rz += r[i] * z[i];
      it = 0;
      rel = Math.sqrt(r.reduce((a, v) => a + v * v, 0)) / fn;
      for (; it < maxIter && rel >= tol; it++) {
        M.matvec(p, q);
        let pq = 0;
        for (let i = 0; i < ndof; i++) pq += p[i] * q[i];
        const alpha = rz / pq;
        let rr = 0;
        rOld.set(r);
        for (let i = 0; i < ndof; i++) { u[i] += alpha * p[i]; r[i] -= alpha * q[i]; rr += r[i] * r[i]; }
        rel = Math.sqrt(rr) / fn;
        if (rel < tol) { it++; break; }
        precond(r, z);
        let rz2 = 0, zdr = 0;
        for (let i = 0; i < ndof; i++) { rz2 += r[i] * z[i]; zdr += z[i] * (r[i] - rOld[i]); }
        const beta = Math.max(0, zdr / rz); // Polak–Ribière form tolerates the variable V-cycle
        rz = rz2;
        for (let i = 0; i < ndof; i++) p[i] = z[i] + beta * p[i];
        if (report && it % every === 0) onProgress(0.05 + 0.9 * Math.min(1, Math.max(0, Math.log(rel) / Math.log(tol))), `${label} · iteration ${total + it}`);
        if (!(rel < 1e6)) break; // diverging
      }
      total += it;
    };
    if (M.levels.length > 1) runCG((rr, zz) => vcycle(0, rr, zz), opts.maxIter ?? 150, 2, x0);
    // fall back to plain Jacobi CG if the multigrid cycle did not converge (very irregular meshes)
    if (M.levels.length === 1 || !(rel < tol * 10)) runCG(jacobi, opts.maxIter ?? Math.max(3000, Math.round(160 * Math.cbrt(ne))), 25, null);
    return { u, iterations: total, residual: rel, converged: rel < tol * 10 };
  };

  const ue = new Float64Array(24);
  const gather = (u, e) => { for (let c = 0; c < 8; c++) { const b = conn[e * 8 + c] * 3; ue[c * 3] = u[b]; ue[c * 3 + 1] = u[b + 1]; ue[c * 3 + 2] = u[b + 2]; } return ue; };
  /** Strain energy uᵀKu of each element (unit stiffness weight). */
  M.elementEnergy = (u) => {
    const out = new Float64Array(ne);
    for (let e = 0; e < ne; e++) {
      if (!keep[e]) continue;
      gather(u, e);
      let s = 0;
      for (let a = 0; a < 24; a++) { let t = 0; for (let b = 0; b < 24; b++) t += Kc[a * 24 + b] * ue[b]; s += ue[a] * t; }
      out[e] = s * scale * efrac[e];
    }
    return out;
  };

  /** Nodal von Mises stress (corner stresses averaged as tensors) and element-centre maximum. */
  M.stresses = (u) => {
    const B0 = bCompat(0, 0, 0), D = elasticity(nu), BC = cornerStrain(Kc.recover);
    const nodeVM = new Float64Array(nn), nodeCnt = new Float64Array(nn), nodeS = new Float64Array(nn * 6);
    const stressOf = (Bm) => {
      const eps = [0, 0, 0, 0, 0, 0], sg = [0, 0, 0, 0, 0, 0];
      for (let rI = 0; rI < 6; rI++) { let t = 0; for (let b = 0; b < 24; b++) t += Bm[rI * 24 + b] * ue[b]; eps[rI] = t / h; }
      for (let rI = 0; rI < 6; rI++) { let t = 0; for (let k = 0; k < 6; k++) t += D[rI * 6 + k] * eps[k]; sg[rI] = t * E; }
      return sg;
    };
    let maxVME = 0;
    for (let e = 0; e < ne; e++) {
      if (!keep[e]) continue;
      gather(u, e);
      maxVME = Math.max(maxVME, vonMises(stressOf(B0)));
      for (let c = 0; c < 8; c++) {
        const sg = stressOf(BC[c]), id = conn[e * 8 + c];
        for (let k = 0; k < 6; k++) nodeS[id * 6 + k] += sg[k];
        nodeCnt[id]++;
      }
    }
    for (let i = 0; i < nn; i++) if (nodeCnt[i]) nodeVM[i] = vonMises(Array.from(nodeS.subarray(i * 6, i * 6 + 6), (v) => v / nodeCnt[i]));
    return { nodeVM, maxVME };
  };

  /** Element-centre stress (MPa, Voigt order xx, yy, zz, xy, yz, zx) for every element. */
  M.elementStress = (u) => {
    const B0 = bCompat(0, 0, 0), D = elasticity(nu), out = new Float64Array(ne * 6);
    for (let e = 0; e < ne; e++) {
      if (!keep[e]) continue;
      gather(u, e);
      const eps = [0, 0, 0, 0, 0, 0];
      for (let rI = 0; rI < 6; rI++) { let t = 0; for (let b = 0; b < 24; b++) t += B0[rI * 24 + b] * ue[b]; eps[rI] = t / h; }
      for (let rI = 0; rI < 6; rI++) { let t = 0; for (let k = 0; k < 6; k++) t += D[rI * 6 + k] * eps[k]; out[e * 6 + rI] = t * E; }
    }
    return out;
  };

  /** Root-mean-square von Mises stress over each element's 2×2×2 Gauss points (MPa), from the
   *  centre stress and the corner stresses (which include the incompatible-mode strains). */
  M.elementGaussVM = (u) => {
    const B0 = bCompat(0, 0, 0), D = elasticity(nu), BC = cornerStrain(Kc.recover), g = 1 / Math.sqrt(3), out = new Float64Array(ne);
    const stressOf = (Bm) => {
      const eps = [0, 0, 0, 0, 0, 0], sg = [0, 0, 0, 0, 0, 0];
      for (let rI = 0; rI < 6; rI++) { let t = 0; for (let b = 0; b < 24; b++) t += Bm[rI * 24 + b] * ue[b]; eps[rI] = t / h; }
      for (let rI = 0; rI < 6; rI++) { let t = 0; for (let k = 0; k < 6; k++) t += D[rI * 6 + k] * eps[k]; sg[rI] = t * E; }
      return sg;
    };
    for (let e = 0; e < ne; e++) {
      if (!keep[e]) continue;
      gather(u, e);
      const c0 = stressOf(B0);
      let sum = 0;
      for (let c = 0; c < 8; c++) { const sc = stressOf(BC[c]); sum += vonMises(c0.map((v, k) => v + g * (sc[k] - v))) ** 2; }
      out[e] = Math.sqrt(sum / 8);
    }
    return out;
  };

  /** Samples nodal fields at mesh vertices (trilinear over the active corners of each cell). */
  M.sample = (pts, scalar, vec) => {
    const nv = pts.length / 3, S = scalar ? new Float32Array(nv) : null, V = vec ? new Float32Array(nv * 3) : null;
    for (let v = 0; v < nv; v++) {
      const P = [pts[v * 3], pts[v * 3 + 1], pts[v * 3 + 2]];
      const fx = (P[0] - O[0]) / h, fy = (P[1] - O[1]) / h, fz = (P[2] - O[2]) / h;
      const i0 = Math.floor(fx), j0 = Math.floor(fy), k0 = Math.floor(fz);
      let wsum = 0, s = 0, d0 = 0, d1 = 0, d2 = 0;
      for (let c = 0; c < 8; c++) {
        const [a, b, cc] = cornerOff[c];
        const i = i0 + a, j = j0 + b, k = k0 + cc;
        if (i < 0 || j < 0 || k < 0 || i >= NX || j >= NY || k >= NZ) continue;
        const id = nodeId[gnode(i, j, k)];
        if (id < 0 || !live[id]) continue;
        const w = (a ? fx - i0 : 1 - (fx - i0)) * (b ? fy - j0 : 1 - (fy - j0)) * (cc ? fz - k0 : 1 - (fz - k0)) + 1e-9;
        wsum += w;
        if (scalar) s += w * scalar[id];
        if (vec) { d0 += w * vec[id * 3]; d1 += w * vec[id * 3 + 1]; d2 += w * vec[id * 3 + 2]; }
      }
      if (!wsum) {
        const id = nearestNode(P, 2);
        if (id >= 0 && live[id]) { wsum = 1; if (scalar) s = scalar[id]; if (vec) { d0 = vec[id * 3]; d1 = vec[id * 3 + 1]; d2 = vec[id * 3 + 2]; } }
      }
      if (wsum) { if (S) S[v] = s / wsum; if (V) { V[v * 3] = d0 / wsum; V[v * 3 + 1] = d1 / wsum; V[v * 3 + 2] = d2 / wsum; } }
    }
    return { scalar: S, vec: V };
  };

  /** Marks nodes within `r` cells of a fixed node. */
  M.nearFixed = (r = 2) => {
    const out = new Uint8Array(nn);
    for (let n = 0; n < nn; n++) {
      if (!isFixed[n]) continue;
      const I = nodeIJK[n * 3], J = nodeIJK[n * 3 + 1], K = nodeIJK[n * 3 + 2];
      for (let dk = -r; dk <= r; dk++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        const i = I + di, j = J + dj, k = K + dk;
        if (i < 0 || j < 0 || k < 0 || i >= NX || j >= NY || k >= NZ) continue;
        const id = nodeId[gnode(i, j, k)];
        if (id >= 0) out[id] = 1;
      }
    }
    return out;
  };
  return M;
}

/**
 * Runs a linear static analysis.
 * opts: { positions, normals?, index, faceGroups, E (MPa), nu, elements, fixed, loads, onProgress, tol }
 */
export function solveStatic(opts) {
  if (!opts.loads?.length) throw new Error('Add a force or pressure load');
  const M = buildModel(opts);
  M.onProgress(0.04, 'Assembling');
  M.assemble();
  M.onProgress(0.05, 'Solving');
  const sol = M.solve(M.f, null, { tol: opts.tol ?? 1e-6 });
  const u = sol.u;
  const { nodeVM, maxVME } = M.stresses(u);
  const display = opts.normals ? refineMesh(opts.positions, opts.normals, opts.index, opts.faceGroups, M.h) : null;
  const smp = M.sample(display ? display.positions : opts.positions, nodeVM, u);
  let maxDisp = 0, maxVM = 0, maxAway = 0;
  // stress right at a support is singular in theory, so also report the peak two cells away from it
  const nearFix = M.nearFixed(2);
  for (let i = 0; i < M.nn; i++) {
    if (!M.live[i]) continue;
    maxDisp = Math.max(maxDisp, Math.hypot(u[i * 3], u[i * 3 + 1], u[i * 3 + 2]));
    maxVM = Math.max(maxVM, nodeVM[i]);
    if (!nearFix[i]) maxAway = Math.max(maxAway, nodeVM[i]);
  }
  M.onProgress(1, 'Done');
  return {
    vonMises: smp.scalar, displacement: smp.vec, display,
    maxVonMises: maxVM, maxAwayFromSupports: maxAway || maxVM, maxElementVonMises: maxVME, maxDisplacement: maxDisp,
    elements: M.ne - M.dropped, dropped: M.dropped, nodes: M.nn, h: M.h, iterations: sol.iterations, converged: sol.converged, residual: sol.residual,
    appliedForce: M.applied, fixedNodes: M.nFixed,
  };
}

// ---------- nonlinear material (plasticity) ----------
/**
 * Static stress with yielding: bilinear elastic–plastic material (yield stress σy, hardening modulus
 * Et = hardening × E), monotonic loading, by deformation-theory (secant) iterations. Each element's
 * stiffness is reduced to the secant modulus for its von Mises stress until the stresses settle. Past
 * the collapse load (a plastic mechanism forms) the deflection runs away and the result says so.
 */
export function solvePlastic(opts) {
  if (!opts.loads?.length) throw new Error('Add a force or pressure load');
  const sy = opts.yield ?? 250, Er = Math.max(1e-4, opts.hardening ?? 0.01);
  const M = buildModel(opts);
  const { ne, nn, conn, keep } = M, E = opts.E ?? 200000;
  const w = new Float64Array(ne).fill(1), sTrue = new Float64Array(ne);
  let u = null, linearMax = 0, it = 0, collapsed = false, change = 1, plastic = 0;
  const maxIt = opts.maxIter || 30;
  for (; it < maxIt; it++) {
    M.assemble(w);
    const sol = M.solve(M.f, u, { tol: 1e-6, report: false });
    u = sol.u;
    let umax = 0;
    for (let i = 0; i < nn; i++) if (M.live[i]) umax = Math.max(umax, Math.hypot(u[i * 3], u[i * 3 + 1], u[i * 3 + 2]));
    if (!it) linearMax = umax;
    if (umax > 50 * linearMax || !sol.converged && it > 2) { collapsed = true; break; }
    // stresses from the strains at full modulus (s = E ε_eq), then the material curve gives the real stress
    const VM = M.elementGaussVM(u);
    change = 0; plastic = 0;
    for (let e = 0; e < ne; e++) {
      if (!keep[e]) continue;
      // stress at full modulus from the element's actual strain (E ε); the material curve gives the real one
      const s = VM[e];
      const st = s <= sy ? s : sy + Er * (s - sy);
      const wn = s > 1e-12 ? st / s : 1;
      const upd = it < 2 ? wn : 0.5 * (w[e] + wn);
      change = Math.max(change, Math.abs(upd - w[e]));
      w[e] = upd; sTrue[e] = st;
      if (s > sy) plastic++;
    }
    M.onProgress(0.05 + 0.9 * Math.min(1, (it + 1) / 12), `Yielding · iteration ${it + 1}`);
    if (change < 2e-3) { it++; break; }
  }
  // nodal fields: true von Mises stress and equivalent plastic strain, averaged from the elements
  const nodeS = new Float64Array(nn), nodeP = new Float64Array(nn), cnt = new Float64Array(nn);
  let maxP = 0, maxS = 0, nKeep = 0;
  for (let e = 0; e < ne; e++) {
    if (!keep[e]) continue;
    nKeep++;
    const sFull = w[e] > 0 ? sTrue[e] / w[e] : 0, ep = Math.max(0, (sFull - sTrue[e]) / E);
    maxP = Math.max(maxP, ep); maxS = Math.max(maxS, sTrue[e]);
    for (let c = 0; c < 8; c++) { const id = conn[e * 8 + c]; nodeS[id] += sTrue[e]; nodeP[id] += ep; cnt[id]++; }
  }
  for (let i = 0; i < nn; i++) if (cnt[i]) { nodeS[i] /= cnt[i]; nodeP[i] /= cnt[i]; }
  const display = opts.normals ? refineMesh(opts.positions, opts.normals, opts.index, opts.faceGroups, M.h) : null;
  const pts = display ? display.positions : opts.positions;
  const smp = M.sample(pts, nodeS, u), smpP = M.sample(pts, nodeP, null);
  let maxDisp = 0;
  for (let i = 0; i < nn; i++) if (M.live[i]) maxDisp = Math.max(maxDisp, Math.hypot(u[i * 3], u[i * 3 + 1], u[i * 3 + 2]));
  M.onProgress(1, 'Done');
  return {
    vonMises: smp.scalar, displacement: smp.vec, plasticStrain: smpP.scalar, display,
    maxVonMises: maxS, maxAwayFromSupports: maxS, maxElementVonMises: maxS, maxDisplacement: maxDisp, linearDisplacement: linearMax,
    maxPlasticStrain: maxP, plasticFraction: plastic / (nKeep || 1), collapsed, nearCollapse: collapsed || maxDisp > 5 * linearMax, plastic: true,
    elements: M.ne - M.dropped, dropped: M.dropped, nodes: M.nn, h: M.h, iterations: it, converged: !collapsed && change < 2e-3, residual: change, appliedForce: M.applied, fixedNodes: M.nFixed,
  };
}

// ---------- natural frequencies ----------
// Symmetric eigen-decomposition of a small dense matrix (cyclic Jacobi). Returns { values, vectors }.
function jacobiEigen(A, n) {
  const a = Float64Array.from(A), V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i * n + j] ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      const apq = a[p * n + q];
      if (Math.abs(apq) < 1e-300) continue;
      const th = (a[q * n + q] - a[p * n + p]) / (2 * apq);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) {
        const akp = a[k * n + p], akq = a[k * n + q];
        a[k * n + p] = c * akp - s * akq; a[k * n + q] = s * akp + c * akq;
      }
      for (let k = 0; k < n; k++) {
        const apk = a[p * n + k], aqk = a[q * n + k];
        a[p * n + k] = c * apk - s * aqk; a[q * n + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < n; k++) {
        const vkp = V[k * n + p], vkq = V[k * n + q];
        V[k * n + p] = c * vkp - s * vkq; V[k * n + q] = s * vkp + c * vkq;
      }
    }
  }
  return { values: Array.from({ length: n }, (_, i) => a[i * n + i]), vectors: V };
}

/**
 * Lowest natural frequencies and mode shapes with the fixed faces held.
 * opts: buildModel options plus { density (g/cm³), modes (default 4) }.
 * Uses subspace iteration with the multigrid solver for K⁻¹M products and lumped masses.
 */
export function solveModal(opts) {
  const nModes = Math.max(1, Math.min(8, opts.modes || 4));
  const M = buildModel({ ...opts, loads: [] });
  M.onProgress(0.04, 'Assembling');
  M.assemble();
  const { ndof, nn, ne, conn, efrac, keep, free, h } = M;
  // lumped mass in tonnes (N·s²/mm): ρ [g/cm³] × 1e-9 t/mm³ per g/cm³
  const rho = (opts.density || 1) * 1e-9;
  const mass = new Float64Array(ndof);
  for (let e = 0; e < ne; e++) {
    if (!keep[e]) continue;
    const m = (rho * h ** 3 * efrac[e]) / 8;
    for (let c = 0; c < 8; c++) { const b = conn[e * 8 + c] * 3; mass[b] += m; mass[b + 1] += m; mass[b + 2] += m; }
  }
  const p = Math.min(nModes * 2, nModes + 8); // guard vectors speed up convergence
  let X = Array.from({ length: p }, (_, j) => {
    const v = new Float64Array(ndof);
    for (let i = 0; i < ndof; i++) if (free[i]) v[i] = Math.sin((i + 1) * (j + 1) * 0.618 + j) + (j === 0 ? 1 : 0);
    return v;
  });
  // start vector 0: uniform direction per axis gives good overlap with bending modes
  for (let i = 0; i < ndof; i++) if (free[i]) { X[0][i] = i % 3 === 2 ? 1 : 0.2; if (p > 1) X[1][i] = i % 3 === 1 ? 1 : 0.2; if (p > 2) X[2][i] = i % 3 === 0 ? 1 : 0.2; }
  let lambdas = [], prev = null, iter = 0;
  const maxIter = opts.maxIter || 30;
  for (; iter < maxIter; iter++) {
    // Y = K⁻¹ M X (warm-started from the previous Y)
    // after the first pass K⁻¹MX ≈ X/λ, which is an excellent starting guess for each solve
    const Y = X.map((x, j) => {
      const rhs = Float64Array.from(x, (v, i) => (free[i] ? v * mass[i] : 0));
      const guess = iter > 0 && lambdas[j] > 0 ? Float64Array.from(x, (v) => v / lambdas[j]) : null;
      return M.solve(rhs, guess, { tol: iter > 1 ? 1e-5 : 1e-6, report: false }).u;
    });
    // Rayleigh–Ritz on span(Y): Kr = YᵀKY, Mr = YᵀMY
    const KY = Y.map((y) => { const out = new Float64Array(ndof); M.matvec(y, out); return out; });
    const Kr = new Float64Array(p * p), Mr = new Float64Array(p * p);
    for (let a = 0; a < p; a++) for (let b = a; b < p; b++) {
      let k = 0, m = 0;
      for (let i = 0; i < ndof; i++) { if (!free[i]) continue; k += Y[a][i] * KY[b][i]; m += Y[a][i] * Y[b][i] * mass[i]; }
      Kr[a * p + b] = Kr[b * p + a] = k; Mr[a * p + b] = Mr[b * p + a] = m;
    }
    // generalised eigenproblem via Mr = LLᵀ: (L⁻¹ Kr L⁻ᵀ) z = λ z
    const L = new Float64Array(p * p);
    for (let i = 0; i < p; i++) for (let j = 0; j <= i; j++) {
      let s = Mr[i * p + j];
      for (let k = 0; k < j; k++) s -= L[i * p + k] * L[j * p + k];
      L[i * p + j] = i === j ? Math.sqrt(Math.max(s, 1e-300)) : s / L[j * p + j];
    }
    const Li = new Float64Array(p * p);
    for (let i = 0; i < p; i++) { Li[i * p + i] = 1 / L[i * p + i]; for (let j = 0; j < i; j++) { let s = 0; for (let k = j; k < i; k++) s += L[i * p + k] * Li[k * p + j]; Li[i * p + j] = -s / L[i * p + i]; } }
    const T = new Float64Array(p * p), A = new Float64Array(p * p);
    for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) { let s = 0; for (let k = 0; k < p; k++) s += Li[i * p + k] * Kr[k * p + j]; T[i * p + j] = s; }
    for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) { let s = 0; for (let k = 0; k < p; k++) s += T[i * p + k] * Li[j * p + k]; A[i * p + j] = s; }
    const { values, vectors } = jacobiEigen(A, p);
    const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
    lambdas = order.map((i) => values[i]);
    // Ritz vectors: Q = L⁻ᵀ Z, X = Y Q
    X = order.map((col) => {
      const qv = new Float64Array(p);
      for (let i = 0; i < p; i++) { let s = 0; for (let k = 0; k < p; k++) s += Li[k * p + i] * vectors[k * p + col]; qv[i] = s; }
      const x = new Float64Array(ndof);
      for (let a = 0; a < p; a++) { const w = qv[a]; if (w) { const ya = Y[a]; for (let i = 0; i < ndof; i++) x[i] += w * ya[i]; } }
      return x;
    });
    M.onProgress(0.08 + 0.85 * Math.min(1, (iter + 1) / 12), `Finding modes · iteration ${iter + 1}`);
    if (prev && lambdas.slice(0, nModes).every((l, i) => Math.abs(l - prev[i]) <= 1e-5 * Math.abs(l))) { iter++; break; }
    prev = lambdas.slice();
  }
  // mode shapes, mass-normalised then scaled so the largest displacement is 1
  const display = opts.normals ? refineMesh(opts.positions, opts.normals, opts.index, opts.faceGroups, h) : null;
  const pts = display ? display.positions : opts.positions;
  let totalMass = 0;
  for (let i = 0; i < ndof; i += 3) totalMass += mass[i];
  const modes = lambdas.slice(0, nModes).map((lam, j) => {
    const x = X[j];
    let mx = 0;
    for (let n = 0; n < nn; n++) mx = Math.max(mx, Math.hypot(x[n * 3], x[n * 3 + 1], x[n * 3 + 2]));
    const s = 1 / (mx || 1);
    const sh = Float64Array.from(x, (v) => v * s);
    // effective mass participation along X, Y and Z
    let mm = 0;
    const g = [0, 0, 0];
    for (let i = 0; i < ndof; i++) { mm += mass[i] * sh[i] * sh[i]; g[i % 3] += mass[i] * sh[i]; }
    const part = g.map((v) => (v * v) / (mm || 1) / (totalMass || 1));
    return { frequency: Math.sqrt(Math.max(lam, 0)) / (2 * Math.PI), shape: M.sample(pts, null, sh).vec, participation: part };
  });
  M.onProgress(1, 'Done');
  return { modes, display, elements: M.ne - M.dropped, h, iterations: iter, mass: totalMass * 1e3 /* t → kg */ };
}

// ---------- linear buckling ----------
// Geometric stiffness of a unit-cube hex: Q[i*3+j] = ∫ ∂N/∂x_i ∂N/∂x_j dV (8 × 8), by 2×2×2 Gauss.
const GEOM_Q = (() => {
  const g = 1 / Math.sqrt(3), Q = Array.from({ length: 9 }, () => new Float64Array(64));
  for (const x of [-g, g]) for (const y of [-g, g]) for (const z of [-g, g]) {
    const dN = NODE.map(([a, b, c]) => [(a * (1 + b * y) * (1 + c * z)) / 4, (b * (1 + a * x) * (1 + c * z)) / 4, (c * (1 + a * x) * (1 + b * y)) / 4]);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) Q[i * 3 + j][a * 8 + b] += (dN[a][i] * dN[b][j]) / 8;
  }
  return Q;
})();

/**
 * Linear (eigenvalue) buckling: the load factors λ at which the part buckles under the applied loads
 * (critical load = λ × applied load) and the buckled shapes. Solves K φ = λ (−Kσ) φ, where Kσ is the
 * geometric stiffness from the static stresses, by subspace iteration on K⁻¹(−Kσ).
 */
export function solveBuckling(opts) {
  if (!opts.loads?.length) throw new Error('Add a force or pressure load: buckling factors scale the loads you apply');
  const nModes = Math.max(1, Math.min(6, opts.modes || 3));
  const M = buildModel(opts);
  M.onProgress(0.04, 'Assembling');
  M.assemble();
  const { ndof, nn, ne, conn, efrac, keep, free, h } = M;
  M.onProgress(0.06, 'Static solve');
  const u = M.solve(M.f, null, { tol: 1e-7, report: false }).u;
  const S = M.elementStress(u);
  // element geometric stiffness H_e = h Σ S_ij Q_ij (the same for x, y and z displacements)
  const H = new Float64Array(ne * 64);
  for (let e = 0; e < ne; e++) {
    if (!keep[e]) continue;
    const s = S.subarray(e * 6, e * 6 + 6), T = [s[0], s[3], s[5], s[3], s[1], s[4], s[5], s[4], s[2]], w = h * efrac[e];
    for (let ij = 0; ij < 9; ij++) { const t = T[ij] * w; if (!t) continue; const q = GEOM_Q[ij]; for (let k = 0; k < 64; k++) H[e * 64 + k] += t * q[k]; }
  }
  const negKs = (x, y) => {
    y.fill(0);
    for (let e = 0; e < ne; e++) {
      if (!keep[e]) continue;
      for (let a = 0; a < 8; a++) {
        const ia = conn[e * 8 + a] * 3;
        let s0 = 0, s1 = 0, s2 = 0;
        for (let b = 0; b < 8; b++) { const hv = H[e * 64 + a * 8 + b], ib = conn[e * 8 + b] * 3; s0 += hv * x[ib]; s1 += hv * x[ib + 1]; s2 += hv * x[ib + 2]; }
        y[ia] -= s0; y[ia + 1] -= s1; y[ia + 2] -= s2;
      }
    }
    for (let i = 0; i < ndof; i++) if (!free[i]) y[i] = 0;
  };
  const p = Math.min(nModes * 2, nModes + 6);
  let X = Array.from({ length: p }, (_, j) => Float64Array.from({ length: ndof }, (_, i) => (free[i] ? Math.sin((i + 1) * (j + 1) * 0.618 + j) : 0)));
  X[0] = Float64Array.from(u); // the static deflection overlaps well with the first buckled shape
  let mus = [], prev = null, iter = 0;
  const tmp = new Float64Array(ndof);
  for (; iter < (opts.maxIter || 40); iter++) {
    const Y = X.map((x) => { negKs(x, tmp); return M.solve(tmp.slice(), null, { tol: 1e-6, report: false }).u; });
    const KY = Y.map((y) => { const o = new Float64Array(ndof); M.matvec(y, o); return o; });
    const BY = Y.map((y) => { const o = new Float64Array(ndof); negKs(y, o); return o; });
    const Kr = new Float64Array(p * p), Br = new Float64Array(p * p);
    for (let a = 0; a < p; a++) for (let b = a; b < p; b++) {
      let k = 0, m = 0;
      for (let i = 0; i < ndof; i++) { if (!free[i]) continue; k += Y[a][i] * KY[b][i]; m += Y[a][i] * BY[b][i]; }
      Kr[a * p + b] = Kr[b * p + a] = k; Br[a * p + b] = Br[b * p + a] = m;
    }
    // (L⁻¹ Br L⁻ᵀ) z = μ z with Kr = LLᵀ; μ = 1/λ
    const L = new Float64Array(p * p);
    for (let i = 0; i < p; i++) for (let j = 0; j <= i; j++) {
      let sv = Kr[i * p + j];
      for (let k = 0; k < j; k++) sv -= L[i * p + k] * L[j * p + k];
      L[i * p + j] = i === j ? Math.sqrt(Math.max(sv, 1e-300)) : sv / L[j * p + j];
    }
    const Li = new Float64Array(p * p);
    for (let i = 0; i < p; i++) { Li[i * p + i] = 1 / L[i * p + i]; for (let j = 0; j < i; j++) { let sv = 0; for (let k = j; k < i; k++) sv += L[i * p + k] * Li[k * p + j]; Li[i * p + j] = -sv / L[i * p + i]; } }
    const T = new Float64Array(p * p), A = new Float64Array(p * p);
    for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) { let sv = 0; for (let k = 0; k < p; k++) sv += Li[i * p + k] * Br[k * p + j]; T[i * p + j] = sv; }
    for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) { let sv = 0; for (let k = 0; k < p; k++) sv += T[i * p + k] * Li[j * p + k]; A[i * p + j] = sv; }
    const { values, vectors } = jacobiEigen(A, p);
    const order = values.map((v, i) => i).sort((a, b) => values[b] - values[a]);
    mus = order.map((i) => values[i]);
    X = order.map((col) => {
      const qv = new Float64Array(p);
      for (let i = 0; i < p; i++) { let sv = 0; for (let k = 0; k < p; k++) sv += Li[k * p + i] * vectors[k * p + col]; qv[i] = sv; }
      const x = new Float64Array(ndof);
      for (let a = 0; a < p; a++) { const w = qv[a]; if (w) { const ya = Y[a]; for (let i = 0; i < ndof; i++) x[i] += w * ya[i]; } }
      return x;
    });
    M.onProgress(0.1 + 0.85 * Math.min(1, (iter + 1) / 15), `Finding buckling modes · iteration ${iter + 1}`);
    const top = mus.slice(0, nModes);
    if (prev && top.every((m, i) => Math.abs(m - prev[i]) <= 1e-5 * Math.abs(m))) { iter++; break; }
    prev = top;
  }
  const display = opts.normals ? refineMesh(opts.positions, opts.normals, opts.index, opts.faceGroups, h) : null;
  const pts = display ? display.positions : opts.positions;
  const modes = mus.map((mu, j) => ({ mu, j })).filter((m) => m.mu > 0).slice(0, nModes).map(({ mu, j }) => {
    const x = X[j];
    let mx = 0;
    for (let n = 0; n < nn; n++) mx = Math.max(mx, Math.hypot(x[n * 3], x[n * 3 + 1], x[n * 3 + 2]));
    return { factor: 1 / mu, shape: M.sample(pts, null, Float64Array.from(x, (v) => v / (mx || 1))).vec };
  });
  if (!modes.length) throw new Error('The loads do not compress the part anywhere, so it cannot buckle under them');
  M.onProgress(1, 'Done');
  return { modes, display, elements: M.ne - M.dropped, h, iterations: iter, appliedForce: M.applied };
}

// ---------- topology optimisation ----------
/**
 * Minimum-compliance topology optimisation (SIMP with a sensitivity filter and optimality-criteria
 * updates). Material next to supports and loads is kept. Returns the element densities and a closed
 * surface mesh of the optimised shape (surface nets on the nodal density field).
 * opts: buildModel options plus { volume (fraction to keep, 0.05–0.95), iterations, penal, radius (cells) }
 */
export function optimizeTopology(opts) {
  if (!opts.loads?.length) throw new Error('Add a force or pressure load');
  const M = buildModel(opts);
  const { ne, conn, keep, elems, efrac, isFixed, isLoaded } = M;
  const [nx, ny, nz] = M.dims;
  const vf = Math.min(0.95, Math.max(0.05, opts.volume ?? 0.35));
  const penal = opts.penal ?? 3, rmin = opts.radius ?? 1.6, Emin = 1e-3, iters = opts.iterations ?? 40;
  // passive (always solid) elements: those touching a support or a load
  const passive = new Uint8Array(ne);
  for (let e = 0; e < ne; e++) for (let c = 0; c < 8; c++) { const n = conn[e * 8 + c]; if (isFixed[n] || isLoaded[n]) passive[e] = 1; }
  const x = new Float64Array(ne).fill(vf);
  for (let e = 0; e < ne; e++) if (passive[e]) x[e] = 1;
  const cellOf = new Int32Array(nx * ny * nz).fill(-1);
  for (let e = 0; e < ne; e++) cellOf[(elems[e * 3 + 2] * ny + elems[e * 3 + 1]) * nx + elems[e * 3]] = e;
  // filter neighbourhood (cells within rmin)
  const R = Math.ceil(rmin), offs = [];
  for (let dk = -R; dk <= R; dk++) for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) { const d = Math.hypot(di, dj, dk); if (d < rmin) offs.push([di, dj, dk, rmin - d]); }
  const total = efrac.reduce((a, v, e) => a + (keep[e] ? v : 0), 0);
  const w = new Float64Array(ne);
  // stiffness of the full part, to report how much the optimised shape keeps
  M.onProgress(0.03, 'Solving the full part');
  M.assemble();
  const full = M.solve(M.f, null, { tol: 1e-5, report: false });
  let fullCompliance = 0;
  for (let i = 0; i < M.ndof; i++) fullCompliance += M.f[i] * full.u[i];
  let u = full.u, compliance = 0, change = 1, it = 0;
  const history = [];
  for (; it < iters; it++) {
    for (let e = 0; e < ne; e++) w[e] = Emin + x[e] ** penal * (1 - Emin);
    M.assemble(w);
    const sol = M.solve(M.f, u, { tol: 1e-5, report: false });
    u = sol.u;
    const en = M.elementEnergy(u);
    compliance = 0;
    const dc = new Float64Array(ne);
    for (let e = 0; e < ne; e++) { if (!keep[e]) continue; compliance += w[e] * en[e]; dc[e] = -penal * x[e] ** (penal - 1) * (1 - Emin) * en[e]; }
    // sensitivity filter (Sigmund)
    const dcf = new Float64Array(ne);
    for (let e = 0; e < ne; e++) {
      if (!keep[e]) continue;
      const i = elems[e * 3], j = elems[e * 3 + 1], k = elems[e * 3 + 2];
      let num = 0, den = 0;
      for (const [di, dj, dk, H] of offs) {
        const ii = i + di, jj = j + dj, kk = k + dk;
        if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) continue;
        const g = cellOf[(kk * ny + jj) * nx + ii];
        if (g < 0 || !keep[g]) continue;
        num += H * x[g] * dc[g]; den += H;
      }
      dcf[e] = num / (Math.max(1e-3, x[e]) * (den || 1));
    }
    // optimality criteria update with a bisection on the volume multiplier
    let l1 = 0, l2 = 1e9;
    const move = 0.2, xnew = new Float64Array(ne);
    while ((l2 - l1) / (l1 + l2) > 1e-4) {
      const lm = 0.5 * (l1 + l2);
      let v = 0;
      for (let e = 0; e < ne; e++) {
        if (!keep[e]) continue;
        if (passive[e]) { xnew[e] = 1; v += efrac[e]; continue; }
        const be = Math.sqrt(Math.max(0, -dcf[e]) / (lm * efrac[e] || 1e-30));
        xnew[e] = Math.max(0.001, Math.max(x[e] - move, Math.min(1, Math.min(x[e] + move, x[e] * be))));
        v += xnew[e] * efrac[e];
      }
      if (v > vf * total) l1 = lm; else l2 = lm;
    }
    change = 0;
    for (let e = 0; e < ne; e++) { change = Math.max(change, Math.abs(xnew[e] - x[e])); x[e] = xnew[e]; }
    history.push(compliance);
    M.onProgress(0.05 + 0.85 * ((it + 1) / iters), `Optimising · step ${it + 1} of ${iters}`);
    if (it > 8 && change < 0.01) { it++; break; }
  }
  // nodal density (average of the surrounding cells) and a closed surface at 0.5
  const NX = nx + 1, NY = ny + 1, NZ = nz + 1;
  const rhoN = new Float32Array(NX * NY * NZ), cnt = new Float32Array(NX * NY * NZ);
  for (let e = 0; e < ne; e++) {
    if (!keep[e]) continue;
    const i = elems[e * 3], j = elems[e * 3 + 1], k = elems[e * 3 + 2];
    for (const [a, b, c] of M.cornerOff) { const g = ((k + c) * NY + j + b) * NX + i + a; rhoN[g] += x[e] * Math.min(1, efrac[e] * 1.5); cnt[g] += 1; }
  }
  // a node's value averages over all 8 cells around it (empty cells count as 0), so the surface closes
  for (let g = 0; g < rhoN.length; g++) rhoN[g] /= 8;
  void cnt;
  const surface = surfaceNets(rhoN, [NX, NY, NZ], M.O, M.h, 0.35);
  let kept = 0;
  for (let e = 0; e < ne; e++) if (keep[e]) kept += x[e] * efrac[e];
  M.onProgress(1, 'Done');
  return { density: Float32Array.from(x), surface, compliance, fullCompliance, stiffnessRatio: fullCompliance / compliance, history, iterations: it, volumeFraction: kept / total, elements: ne, h: M.h, initialCompliance: history[0] };
}

// Surface nets: one vertex per cell that the iso-surface crosses (at the mean of its edge crossings),
// one quad per crossed grid edge. Gives a closed, smooth mesh. field is indexed (k * NY + j) * NX + i.
export function surfaceNets(field, [NX, NY, NZ], O, h, iso) {
  const at = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= NX || j >= NY || k >= NZ ? 0 : field[(k * NY + j) * NX + i]);
  // cells span nodes (i..i+1); include a ring of empty cells outside so the surface closes
  const CX = NX + 1, CY = NY + 1, CZ = NZ + 1;
  const cid = (i, j, k) => ((k + 1) * CY + (j + 1)) * CX + (i + 1);
  const vidx = new Int32Array(CX * CY * CZ).fill(-1);
  const P = [];
  const E = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const C = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  for (let k = -1; k < NZ; k++) for (let j = -1; j < NY; j++) for (let i = -1; i < NX; i++) {
    const v = C.map(([a, b, c]) => at(i + a, j + b, k + c));
    let inside = 0;
    for (const s of v) if (s > iso) inside++;
    if (inside === 0 || inside === 8) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, b] of E) {
      if ((v[a] > iso) === (v[b] > iso)) continue;
      const t = (iso - v[a]) / (v[b] - v[a]);
      sx += C[a][0] + t * (C[b][0] - C[a][0]); sy += C[a][1] + t * (C[b][1] - C[a][1]); sz += C[a][2] + t * (C[b][2] - C[a][2]); n++;
    }
    vidx[cid(i, j, k)] = P.length / 3;
    P.push(O[0] + (i + sx / n) * h, O[1] + (j + sy / n) * h, O[2] + (k + sz / n) * h);
  }
  const I = [];
  // for each grid edge along axis d between node (i,j,k) and its +d neighbour, connect the 4 cells around it
  const quad = (a, b, c, d, flip) => { if (a < 0 || b < 0 || c < 0 || d < 0) return; if (flip) I.push(a, c, b, a, d, c); else I.push(a, b, c, a, c, d); };
  for (let k = 0; k < NZ; k++) for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const s0 = at(i, j, k) > iso;
    if (at(i + 1, j, k) > iso !== s0) quad(vidx[cid(i, j - 1, k - 1)], vidx[cid(i, j, k - 1)], vidx[cid(i, j, k)], vidx[cid(i, j - 1, k)], !s0);
    if (at(i, j + 1, k) > iso !== s0) quad(vidx[cid(i - 1, j, k - 1)], vidx[cid(i - 1, j, k)], vidx[cid(i, j, k)], vidx[cid(i, j, k - 1)], !s0);
    if (at(i, j, k + 1) > iso !== s0) quad(vidx[cid(i - 1, j - 1, k)], vidx[cid(i, j - 1, k)], vidx[cid(i, j, k)], vidx[cid(i - 1, j, k)], !s0);
  }
  // two passes of Laplacian smoothing soften the voxel steps
  const pos = new Float32Array(P), nv = pos.length / 3;
  const nb = Array.from({ length: nv }, () => new Set());
  for (let t = 0; t < I.length; t += 3) for (let a = 0; a < 3; a++) { const p0 = I[t + a], p1 = I[t + ((a + 1) % 3)]; nb[p0].add(p1); nb[p1].add(p0); }
  for (let pass = 0; pass < 2; pass++) {
    const nxt = new Float32Array(pos);
    for (let v = 0; v < nv; v++) {
      if (!nb[v].size) continue;
      let sx = 0, sy = 0, sz = 0;
      for (const m of nb[v]) { sx += pos[m * 3]; sy += pos[m * 3 + 1]; sz += pos[m * 3 + 2]; }
      const k = nb[v].size;
      nxt[v * 3] = pos[v * 3] * 0.5 + (sx / k) * 0.5; nxt[v * 3 + 1] = pos[v * 3 + 1] * 0.5 + (sy / k) * 0.5; nxt[v * 3 + 2] = pos[v * 3 + 2] * 0.5 + (sz / k) * 0.5;
    }
    pos.set(nxt);
  }
  return { positions: pos, index: new Uint32Array(I) };
}

// ---------- steady-state heat conduction ----------
// Conduction matrix of a unit cube (8-node brick, k = 1): K = ∫ ∇N ∇Nᵀ dV, scaled by k·h for side h.
function heatStiffness() {
  const K = new Float64Array(64);
  for (const x of GP) for (const y of GP) for (const z of GP) {
    const g = NODE.map(([a, b, c]) => [(a * (1 + b * y) * (1 + c * z)) / 4, (b * (1 + a * x) * (1 + c * z)) / 4, (c * (1 + a * x) * (1 + b * y)) / 4]);
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) K[i * 8 + j] += (g[i][0] * g[j][0] + g[i][1] * g[j][1] + g[i][2] * g[j][2]) / 8;
  }
  return K;
}

/**
 * Steady-state temperatures.
 * opts: { positions, normals?, index, faceGroups, k (W/m·K), elements,
 *         loads: [{ faces, type: 'temp', value (°C) } | { faces, type: 'heat', value (W) } | { faces, type: 'conv', value (h, W/m²·K), ambient (°C) }] }
 */
export function solveThermal(opts) {
  const { positions, index, faceGroups, elements = 20000, loads = [], onProgress = () => {} } = opts;
  const kmm = (opts.k ?? 50) / 1000; // W/(mm·K)
  if (!loads.some((l) => l.type === 'temp' || l.type === 'conv')) throw new Error('Add a fixed temperature or a convection face, so the heat has somewhere to go');
  const { nt, at } = triangles(positions, index);
  let vol = 0;
  for (let t = 0; t < nt; t++) {
    const a = at(t, 0) * 3, b = at(t, 1) * 3, c = at(t, 2) * 3;
    vol += (positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1]) - positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c]) + positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c])) / 6;
  }
  const sign = vol < 0 ? -1 : 1;
  vol = Math.abs(vol);
  const blo = [Infinity, Infinity, Infinity], bhi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) { blo[k] = Math.min(blo[k], positions[i + k]); bhi[k] = Math.max(bhi[k], positions[i + k]); }
  const thin = Math.min(...[0, 1, 2].map((k) => bhi[k] - blo[k]));
  const h = thin / Math.max(2, Math.round(thin / Math.cbrt(vol / elements)));
  onProgress(0.05, 'Meshing');
  const vox = voxelize(positions, index, h);
  const [nx, ny, nz] = vox.n, O = vox.origin, NX = nx + 1, NY = ny + 1, NZ = nz + 1;
  const gnode = (i, j, k) => (k * NY + j) * NX + i;
  const corner = NODE.map(([a, b, c]) => [(a + 1) / 2, (b + 1) / 2, (c + 1) / 2]);
  const nodeId = new Int32Array(NX * NY * NZ).fill(-1);
  const cells = [];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (vox.solid[(k * ny + j) * nx + i]) cells.push(i, j, k);
  const ne = cells.length / 3, conn = new Int32Array(ne * 8);
  let nn = 0;
  for (let e = 0; e < ne; e++) for (let c = 0; c < 8; c++) {
    const g = gnode(cells[e * 3] + corner[c][0], cells[e * 3 + 1] + corner[c][1], cells[e * 3 + 2] + corner[c][2]);
    if (nodeId[g] < 0) nodeId[g] = nn++;
    conn[e * 8 + c] = nodeId[g];
  }
  const xyz = new Float64Array(nn * 3);
  for (let k = 0; k < NZ; k++) for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) { const id = nodeId[gnode(i, j, k)]; if (id >= 0) { xyz[id * 3] = O[0] + i * h; xyz[id * 3 + 1] = O[1] + j * h; xyz[id * 3 + 2] = O[2] + k * h; } }
  const nearest = (p) => {
    const fi = Math.round((p[0] - O[0]) / h), fj = Math.round((p[1] - O[1]) / h), fk = Math.round((p[2] - O[2]) / h);
    let best = -1, bd = Infinity;
    for (let dk = -2; dk <= 2; dk++) for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
      const i = fi + di, j = fj + dj, k = fk + dk;
      if (i < 0 || j < 0 || k < 0 || i >= NX || j >= NY || k >= NZ) continue;
      const id = nodeId[gnode(i, j, k)];
      if (id < 0) continue;
      const d = (xyz[id * 3] - p[0]) ** 2 + (xyz[id * 3 + 1] - p[1]) ** 2 + (xyz[id * 3 + 2] - p[2]) ** 2;
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  };
  // assemble the 27-point stencil
  onProgress(0.1, 'Assembling');
  const Ke = heatStiffness(), nbr = new Int32Array(nn * 27).fill(-1), val = new Float64Array(nn * 27);
  for (let e = 0; e < ne; e++) {
    const w = kmm * h * vox.frac[(cells[e * 3 + 2] * ny + cells[e * 3 + 1]) * nx + cells[e * 3]];
    for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) {
      const t = (corner[b][2] - corner[a][2] + 1) * 9 + (corner[b][1] - corner[a][1] + 1) * 3 + (corner[b][0] - corner[a][0] + 1);
      nbr[conn[e * 8 + a] * 27 + t] = conn[e * 8 + b];
      val[conn[e * 8 + a] * 27 + t] += Ke[a * 8 + b] * w;
    }
  }
  // boundary conditions
  const rhs = new Float64Array(nn), robin = new Float64Array(nn), fixedT = new Float64Array(nn).fill(NaN);
  let power = 0, convArea = 0;
  for (const L of loads) {
    const samples = faceSamples(positions, index, faceGroups, L.faces, h, sign);
    const area = samples.reduce((s, x) => s + x.area, 0);
    for (const s of samples) {
      const id = nearest(s.p);
      if (id < 0) continue;
      if (L.type === 'temp') fixedT[id] = L.value;
      else if (L.type === 'heat') { const q = (L.value * s.area) / (area || 1); rhs[id] += q; power += q; }
      else if (L.type === 'conv') { const hc = (L.value / 1e6) * s.area; robin[id] += hc; rhs[id] += hc * (L.ambient ?? 20); convArea += s.area; }
    }
  }
  const diag = new Float64Array(nn);
  for (let n = 0; n < nn; n++) diag[n] = val[n * 27 + 13] + robin[n];
  const mul = (x, y) => {
    for (let n = 0; n < nn; n++) {
      let s = robin[n] * x[n];
      for (let t = 0; t < 27; t++) { const m = nbr[n * 27 + t]; if (m >= 0) s += val[n * 27 + t] * x[m]; }
      y[n] = s;
    }
  };
  // Jacobi-preconditioned CG on the free nodes (fixed temperatures moved to the right-hand side).
  // cdt: optional extra diagonal (heat capacity / time step) for transient steps.
  const T = new Float64Array(nn);
  const free = new Uint8Array(nn);
  for (let n = 0; n < nn; n++) { if (Number.isNaN(fixedT[n])) free[n] = 1; else T[n] = fixedT[n]; }
  let it = 0, rel = 1;
  const cg = (b, cdt, progress) => {
    const mulc = (x, y) => { mul(x, y); if (cdt) for (let n = 0; n < nn; n++) y[n] += cdt[n] * x[n]; };
    const r = new Float64Array(nn), z = new Float64Array(nn), p = new Float64Array(nn), q = new Float64Array(nn);
    const dg = cdt ? diag.map((d, n) => d + cdt[n]) : diag;
    mulc(T, q);
    for (let n = 0; n < nn; n++) r[n] = free[n] ? b[n] - q[n] : 0;
    const bn = Math.sqrt(b.reduce((s2, v, n) => s2 + (free[n] ? v * v : 0), 0)) || 1;
    for (let n = 0; n < nn; n++) z[n] = free[n] ? r[n] / dg[n] : 0;
    p.set(z);
    let rz = r.reduce((s2, v, n) => s2 + v * z[n], 0), k = 0;
    rel = Math.sqrt(r.reduce((s2, v) => s2 + v * v, 0)) / bn;
    const maxIter = Math.max(2000, 30 * Math.cbrt(nn) * 10);
    for (; k < maxIter && rel >= 1e-8; k++) {
      mulc(p, q);
      for (let n = 0; n < nn; n++) if (!free[n]) q[n] = 0;
      let pq = 0;
      for (let n = 0; n < nn; n++) pq += p[n] * q[n];
      if (!pq) break;
      const al = rz / pq;
      let rr = 0;
      for (let n = 0; n < nn; n++) { T[n] += al * p[n]; r[n] -= al * q[n]; rr += r[n] * r[n]; }
      rel = Math.sqrt(rr) / bn;
      if (rel < 1e-8) { k++; break; }
      let rz2 = 0;
      for (let n = 0; n < nn; n++) { z[n] = free[n] ? r[n] / dg[n] : 0; rz2 += r[n] * z[n]; }
      const be = rz2 / rz;
      rz = rz2;
      for (let n = 0; n < nn; n++) p[n] = z[n] + be * p[n];
      if (progress && k % 50 === 0) onProgress(0.15 + 0.8 * Math.min(1, Math.log(rel) / Math.log(1e-8)), `Solving · iteration ${k}`);
    }
    it += k;
  };
  // transient: implicit Euler from a uniform starting temperature, with lumped heat capacity per node
  const tr = opts.transient;
  let history = null, frames = null;
  if (tr) {
    const steps = Math.max(1, Math.min(400, Math.round(tr.steps || 40))), dt = (tr.duration || 60) / steps;
    const rhoCp = (opts.density ?? 7.85) * 1e-6 * (opts.cp ?? 500); // J/(mm³·K)
    const cap = new Float64Array(nn);
    for (let e = 0; e < ne; e++) {
      const c = (rhoCp * h * h * h * vox.frac[(cells[e * 3 + 2] * ny + cells[e * 3 + 1]) * nx + cells[e * 3]]) / 8;
      for (let a = 0; a < 8; a++) cap[conn[e * 8 + a]] += c;
    }
    const cdt = cap.map((c) => c / dt), b = new Float64Array(nn);
    for (let n = 0; n < nn; n++) if (free[n]) T[n] = tr.initial ?? 20;
    const stat = () => { let lo = Infinity, hi = -Infinity, sum = 0, w = 0; for (let n = 0; n < nn; n++) { lo = Math.min(lo, T[n]); hi = Math.max(hi, T[n]); sum += T[n] * cap[n]; w += cap[n]; } return { min: lo, max: hi, mean: sum / (w || 1) }; };
    history = [{ t: 0, ...stat() }];
    frames = [{ t: 0, T: T.slice() }];
    const every = Math.max(1, Math.round(steps / 20));
    for (let st = 1; st <= steps; st++) {
      for (let n = 0; n < nn; n++) b[n] = rhs[n] + cdt[n] * T[n];
      cg(b, cdt, false);
      history.push({ t: st * dt, ...stat() });
      if (st % every === 0 || st === steps) frames.push({ t: st * dt, T: T.slice() });
      onProgress(0.1 + (0.85 * st) / steps, `Time step ${st} of ${steps}`);
    }
  } else cg(rhs, null, true);
  // heat leaving through fixed-temperature faces = reaction of the conduction equations there
  const KT = new Float64Array(nn);
  mul(T, KT);
  let reaction = 0;
  for (let n = 0; n < nn; n++) if (!free[n]) reaction += KT[n] - rhs[n];
  let tMin = Infinity, tMax = -Infinity;
  for (let n = 0; n < nn; n++) { tMin = Math.min(tMin, T[n]); tMax = Math.max(tMax, T[n]); }
  // sample at the display mesh
  const display = opts.normals ? refineMesh(positions, opts.normals, index, faceGroups, h) : null;
  const pts = display ? display.positions : positions, nv = pts.length / 3;
  const sampleAt = (TT) => {
    const out = new Float32Array(nv);
    for (let v = 0; v < nv; v++) {
      const fx = (pts[v * 3] - O[0]) / h, fy = (pts[v * 3 + 1] - O[1]) / h, fz = (pts[v * 3 + 2] - O[2]) / h;
      const i0 = Math.floor(fx), j0 = Math.floor(fy), k0 = Math.floor(fz);
      let ws = 0, sm = 0;
      for (const [a, b, c] of corner) {
        const i = i0 + a, j = j0 + b, k = k0 + c;
        if (i < 0 || j < 0 || k < 0 || i >= NX || j >= NY || k >= NZ) continue;
        const id = nodeId[gnode(i, j, k)];
        if (id < 0) continue;
        const w = (a ? fx - i0 : 1 - (fx - i0)) * (b ? fy - j0 : 1 - (fy - j0)) * (c ? fz - k0 : 1 - (fz - k0)) + 1e-9;
        ws += w; sm += w * TT[id];
      }
      if (!ws) { const id = nearest([pts[v * 3], pts[v * 3 + 1], pts[v * 3 + 2]]); if (id >= 0) { ws = 1; sm = TT[id]; } }
      out[v] = ws ? sm / ws : tMin;
    }
    return out;
  };
  const vT = sampleAt(T);
  const vFrames = frames ? frames.map((f) => ({ t: f.t, temperature: sampleAt(f.T) })) : null;
  onProgress(1, 'Done');
  return { temperature: vT, display, tMin, tMax, power, reaction, convArea, elements: ne, h, iterations: it, converged: rel < 1e-6, residual: rel, ...(history ? { history, frames: vFrames } : {}) };
}
