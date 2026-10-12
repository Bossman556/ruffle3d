// Geometric constraint solver for sketches.
// Unknowns: x/y of every non-fixed point and the radius of every circle. Each constraint or driving
// dimension contributes residuals; the system is split into independent connected components and
// each one is solved with damped least squares (Levenberg–Marquardt) starting from the current
// geometry, so under-constrained sketches move as little as possible.
import { VIRTUAL_POINTS, VIRTUAL_LINES } from './model.js';

const DEG = Math.PI / 180;
const ANG_SCALE = 10; // weights angular residuals (rad) comparably to lengths (mm)

export function solveSketch(sk, { drag = null, maxIter = 60 } = {}) {
  // ---- variables ----
  const X = [];
  const isVar = [];
  const pIdx = new Map(); // point id -> [ix, iy]
  const rIdx = new Map(); // circle id -> ir
  const push = (v, variable) => { X.push(v); isVar.push(variable); return X.length - 1; };
  for (const [id, [x, y]] of Object.entries(VIRTUAL_POINTS)) pIdx.set(id, [push(x, false), push(y, false)]);
  for (const p of sk.points) pIdx.set(p.id, [push(p.x, !p.fixed), push(p.y, !p.fixed)]);
  const curves = new Map(sk.curves.map((c) => [c.id, c]));
  for (const [id, l] of Object.entries(VIRTUAL_LINES)) curves.set(id, l);
  for (const c of sk.curves) if (c.type === 'circle') rIdx.set(c.id, push(c.r, !c.projected));

  // ---- residual terms ----
  const terms = []; // { deps: [varIdx], f: (X) => number[], src }
  const P = (id) => pIdx.get(id);
  const ptDeps = (...ids) => ids.flatMap((id) => P(id) || []);
  const lineOf = (id) => { const c = curves.get(id); return c && c.type === 'line' ? c : null; };
  const center = (c) => P(c.c);
  const radiusDeps = (c) => (c.type === 'circle' ? [rIdx.get(c.id), ...ptDeps(c.c)] : ptDeps(c.c, c.a));
  const radius = (X, c) => {
    if (c.type === 'circle') return X[rIdx.get(c.id)];
    const [cx, cy] = P(c.c), [ax, ay] = P(c.a);
    return Math.hypot(X[ax] - X[cx], X[ay] - X[cy]);
  };
  const vec = (X, l) => { const [ax, ay] = P(l.a), [bx, by] = P(l.b); return [X[bx] - X[ax], X[by] - X[ay]]; };
  const pt = (X, id) => { const [i, j] = P(id); return [X[i], X[j]]; };
  const lineDeps = (l) => ptDeps(l.a, l.b);
  const add = (deps, f, src) => terms.push({ deps: [...new Set(deps.filter((d) => d !== undefined))], f, src });
  const errors = [];

  // arcs keep both end points on their circle
  for (const c of sk.curves) {
    if (c.type !== 'arc' || !P(c.c) || !P(c.a) || !P(c.b)) continue;
    add(ptDeps(c.c, c.a, c.b), (X) => {
      const C = pt(X, c.c), A = pt(X, c.a), B = pt(X, c.b);
      return [Math.hypot(B[0] - C[0], B[1] - C[1]) - Math.hypot(A[0] - C[0], A[1] - C[1])];
    }, { kind: 'arc', id: c.id });
  }

  const ptLineDist = (X, p, l, signed = false) => {
    const A = pt(X, l.a), d = vec(X, l), Q = pt(X, p);
    const len = Math.hypot(d[0], d[1]) || 1e-12;
    const cr = ((Q[0] - A[0]) * d[1] - (Q[1] - A[1]) * d[0]) / len;
    return signed ? cr : Math.abs(cr);
  };
  const angleBetween = (X, l1, l2) => {
    const d1 = vec(X, l1), d2 = vec(X, l2);
    return Math.atan2(d1[0] * d2[1] - d1[1] * d2[0], d1[0] * d2[0] + d1[1] * d2[1]);
  };
  const unitCross = (X, l1, l2) => {
    const d1 = vec(X, l1), d2 = vec(X, l2);
    const n = (Math.hypot(...d1) * Math.hypot(...d2)) || 1e-12;
    return { cross: (d1[0] * d2[1] - d1[1] * d2[0]) / n, dot: (d1[0] * d2[0] + d1[1] * d2[1]) / n };
  };

  const addRule = (k, isDim) => {
    const src = { kind: isDim ? 'dim' : 'constraint', id: k.id };
    const need = (...ok) => { if (ok.some((v) => !v)) { errors.push({ id: k.id, msg: 'references missing geometry' }); return false; } return true; };
    const val = isDim ? k.value : 0;
    if (isDim && !Number.isFinite(val)) { errors.push({ id: k.id, msg: 'invalid value' }); return; }
    switch (k.type) {
      case 'coincident':
        if (need(P(k.a), P(k.b))) add(ptDeps(k.a, k.b), (X) => { const a = pt(X, k.a), b = pt(X, k.b); return [a[0] - b[0], a[1] - b[1]]; }, src);
        break;
      case 'pointOnCurve': {
        const c = curves.get(k.curve);
        if (!need(P(k.p), c)) break;
        if (c.type === 'line') add([...ptDeps(k.p), ...lineDeps(c)], (X) => [ptLineDist(X, k.p, c, true)], src);
        else if (c.type === 'circle' || c.type === 'arc') add([...ptDeps(k.p), ...radiusDeps(c), ...ptDeps(c.c)], (X) => { const q = pt(X, k.p), C = pt(X, c.c); return [Math.hypot(q[0] - C[0], q[1] - C[1]) - radius(X, c)]; }, src);
        break;
      }
      case 'horizontal':
      case 'vertical': {
        const ax = k.type === 'horizontal' ? 1 : 0;
        const [a, b] = k.line ? [lineOf(k.line)?.a, lineOf(k.line)?.b] : [k.a, k.b];
        if (need(P(a), P(b))) add(ptDeps(a, b), (X) => [pt(X, a)[ax] - pt(X, b)[ax]], src);
        break;
      }
      case 'parallel':
      case 'perpendicular': {
        const l1 = lineOf(k.l1), l2 = lineOf(k.l2);
        if (need(l1, l2)) add([...lineDeps(l1), ...lineDeps(l2)], (X) => { const u = unitCross(X, l1, l2); return [ANG_SCALE * (k.type === 'parallel' ? u.cross : u.dot)]; }, src);
        break;
      }
      case 'collinear': {
        const l1 = lineOf(k.l1), l2 = lineOf(k.l2);
        if (need(l1, l2)) add([...lineDeps(l1), ...lineDeps(l2)], (X) => [ptLineDist(X, l2.a, l1, true), ptLineDist(X, l2.b, l1, true)], src);
        break;
      }
      case 'equal': {
        const c1 = curves.get(k.c1), c2 = curves.get(k.c2);
        if (!need(c1, c2)) break;
        const size = (X, c) => (c.type === 'line' ? Math.hypot(...vec(X, c)) : radius(X, c));
        const deps = (c) => (c.type === 'line' ? lineDeps(c) : radiusDeps(c));
        add([...deps(c1), ...deps(c2)], (X) => [size(X, c1) - size(X, c2)], src);
        break;
      }
      case 'tangent': {
        let c1 = curves.get(k.c1), c2 = curves.get(k.c2);
        if (!need(c1, c2)) break;
        if (c2.type === 'line') [c1, c2] = [c2, c1];
        if (c1.type === 'line' && c2.type !== 'line') {
          add([...lineDeps(c1), ...radiusDeps(c2), ...ptDeps(c2.c)], (X) => [ptLineDist(X, c2.c, c1) - radius(X, c2)], src);
        } else if (c1.type !== 'line' && c2.type !== 'line') {
          add([...radiusDeps(c1), ...radiusDeps(c2), ...ptDeps(c1.c, c2.c)], (X) => {
            const a = pt(X, c1.c), b = pt(X, c2.c), d = Math.hypot(a[0] - b[0], a[1] - b[1]);
            const r1 = radius(X, c1), r2 = radius(X, c2);
            return [k.inner ? d - Math.abs(r1 - r2) : d - (r1 + r2)];
          }, src);
        }
        break;
      }
      case 'concentric': {
        const c1 = curves.get(k.c1), c2 = curves.get(k.c2);
        if (need(c1, c2, c1?.c, c2?.c)) add(ptDeps(c1.c, c2.c), (X) => { const a = pt(X, c1.c), b = pt(X, c2.c); return [a[0] - b[0], a[1] - b[1]]; }, src);
        break;
      }
      case 'midpoint': {
        const l = lineOf(k.line);
        if (need(P(k.p), l)) add([...ptDeps(k.p), ...lineDeps(l)], (X) => { const q = pt(X, k.p), a = pt(X, l.a), b = pt(X, l.b); return [q[0] - (a[0] + b[0]) / 2, q[1] - (a[1] + b[1]) / 2]; }, src);
        break;
      }
      case 'symmetric': {
        const l = lineOf(k.line);
        if (need(P(k.a), P(k.b), l)) add([...ptDeps(k.a, k.b), ...lineDeps(l)], (X) => {
          const a = pt(X, k.a), b = pt(X, k.b), A = pt(X, l.a), d = vec(X, l), len = Math.hypot(d[0], d[1]) || 1e-12;
          const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          return [((m[0] - A[0]) * d[1] - (m[1] - A[1]) * d[0]) / len, ((b[0] - a[0]) * d[0] + (b[1] - a[1]) * d[1]) / len];
        }, src);
        break;
      }
      case 'fix':
        if (need(P(k.p))) add(ptDeps(k.p), (X) => { const q = pt(X, k.p); return [q[0] - k.x, q[1] - k.y]; }, src);
        break;
      // ---- driving dimensions ----
      case 'distance':
        if (need(P(k.a), P(k.b))) add(ptDeps(k.a, k.b), (X) => { const a = pt(X, k.a), b = pt(X, k.b); return [Math.hypot(a[0] - b[0], a[1] - b[1]) - val]; }, src);
        break;
      case 'hdist':
      case 'vdist': {
        const ax = k.type === 'hdist' ? 0 : 1;
        if (need(P(k.a), P(k.b))) add(ptDeps(k.a, k.b), (X) => [(k.sign || 1) * (pt(X, k.b)[ax] - pt(X, k.a)[ax]) - val], src);
        break;
      }
      case 'length': {
        const l = lineOf(k.line);
        if (need(l)) add(lineDeps(l), (X) => [Math.hypot(...vec(X, l)) - val], src);
        break;
      }
      case 'pointLine': {
        const l = lineOf(k.line);
        if (need(P(k.p), l)) add([...ptDeps(k.p), ...lineDeps(l)], (X) => [ptLineDist(X, k.p, l) - val], src);
        break;
      }
      case 'lineDist': {
        const l1 = lineOf(k.l1), l2 = lineOf(k.l2);
        if (need(l1, l2)) add([...lineDeps(l1), ...lineDeps(l2)], (X) => [ptLineDist(X, l2.a, l1) - val], src);
        break;
      }
      case 'radius':
      case 'diameter': {
        const c = curves.get(k.curve);
        if (need(c)) add(radiusDeps(c), (X) => [radius(X, c) * (k.type === 'diameter' ? 2 : 1) - val], src);
        break;
      }
      case 'angle': {
        const l1 = lineOf(k.l1), l2 = lineOf(k.l2);
        if (need(l1, l2)) add([...lineDeps(l1), ...lineDeps(l2)], (X) => {
          let a = angleBetween(X, l1, l2) * (k.sign || 1);
          if (a < -Math.PI / 2 && val * DEG > Math.PI / 2) a += 2 * Math.PI;
          return [ANG_SCALE * (a - val * DEG)];
        }, src);
        break;
      }
      default:
        errors.push({ id: k.id, msg: `unknown ${k.type}` });
    }
  };
  for (const k of sk.constraints) addRule(k, false);
  for (const d of sk.dims) addRule(d, true);
  const hardCount = terms.length;
  for (const d of drag ? [].concat(drag) : []) {
    const ids = P(d.point);
    if (ids && isVar[ids[0]]) add(ids, (X) => [0.05 * (X[ids[0]] - d.target[0]), 0.05 * (X[ids[1]] - d.target[1])], { kind: 'drag' });
  }

  // ---- connected components over variables ----
  const varList = X.map((_, i) => i).filter((i) => isVar[i]);
  const parent = new Map(varList.map((i) => [i, i]));
  const find = (i) => { while (parent.get(i) !== i) { parent.set(i, parent.get(parent.get(i))); i = parent.get(i); } return i; };
  for (const t of terms) {
    const vs = t.deps.filter((d) => isVar[d]);
    for (let i = 1; i < vs.length; i++) parent.set(find(vs[i]), find(vs[0]));
  }
  const comps = new Map();
  terms.forEach((t, ti) => {
    const v = t.deps.find((d) => isVar[d]);
    if (v === undefined) return; // fully fixed term: checked for consistency below
    const r = find(v);
    if (!comps.has(r)) comps.set(r, { terms: [], vars: new Set() });
    comps.get(r).terms.push(ti);
  });
  for (const i of varList) { const r = find(i); if (comps.has(r)) comps.get(r).vars.add(i); }

  let maxResidual = 0;
  const failed = new Set();
  for (const comp of comps.values()) {
    const vars = [...comp.vars];
    const ts = comp.terms.map((i) => terms[i]);
    lm(X, vars, ts, maxIter);
    // a drag pulls geometry towards the cursor; then project back onto the exact constraints
    const hard = ts.filter((t) => t.src.kind !== 'drag');
    if (hard.length !== ts.length) lm(X, vars, hard, maxIter);
    // report only hard residuals (not the soft drag term)
    for (const t of ts) {
      if (t.src.kind === 'drag') continue;
      const r = Math.max(...t.f(X).map(Math.abs));
      if (r > 1e-5) { failed.add(t.src.id); maxResidual = Math.max(maxResidual, r); }
    }
  }
  for (const t of terms.slice(0, hardCount)) {
    if (t.deps.some((d) => isVar[d])) continue;
    const r = Math.max(...t.f(X).map(Math.abs));
    if (r > 1e-5) { failed.add(t.src.id); maxResidual = Math.max(maxResidual, r); }
  }

  // ---- write back ----
  const points = sk.points.map((p) => { const [i, j] = pIdx.get(p.id); return { ...p, x: X[i], y: X[j] }; });
  const curvesOut = sk.curves.map((c) => (c.type === 'circle' ? { ...c, r: Math.abs(X[rIdx.get(c.id)]) } : c));

  return {
    sketch: { ...sk, points, curves: curvesOut },
    ok: failed.size === 0 && errors.length === 0,
    failed: [...failed],
    errors,
    maxResidual,
    analyze: () => analyzeDof(X, isVar, varList, terms.slice(0, hardCount), pIdx, rIdx),
  };
}

// Damped least squares on a subset of variables.
function lm(X, vars, terms, maxIter) {
  const n = vars.length;
  if (!n || !terms.length) return { iters: 0 };
  const residuals = () => { const r = []; for (const t of terms) r.push(...t.f(X)); return r; };
  const cost = (r) => r.reduce((s, v) => s + v * v, 0);
  let r = residuals();
  let f = cost(r);
  let lambda = 1e-3;
  let it = 0;
  for (; it < maxIter && f > 1e-22; it++) {
    const m = r.length;
    const J = jacobian(X, vars, residuals, r);
    // normal equations A = JᵀJ, g = Jᵀr
    const A = new Float64Array(n * n), g = new Float64Array(n);
    for (let i = 0; i < m; i++) {
      const row = J[i];
      for (let a = 0; a < n; a++) {
        const ja = row[a];
        if (!ja) continue;
        g[a] += ja * r[i];
        for (let b = a; b < n; b++) A[a * n + b] += ja * row[b];
      }
    }
    for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) A[a * n + b] = A[b * n + a];
    let improved = false;
    for (let tries = 0; tries < 10; tries++) {
      const M = A.slice();
      for (let a = 0; a < n; a++) M[a * n + a] += lambda * (A[a * n + a] + 1e-6);
      const step = solveLinear(M, Array.from(g, (v) => -v), n);
      if (!step) { lambda *= 10; continue; }
      const old = vars.map((v) => X[v]);
      vars.forEach((v, k) => (X[v] += step[k]));
      const r2 = residuals(), f2 = cost(r2);
      if (f2 < f) { r = r2; f = f2; lambda = Math.max(lambda / 3, 1e-12); improved = true; break; }
      vars.forEach((v, k) => (X[v] = old[k]));
      lambda *= 4;
    }
    if (!improved) break;
  }
  return { iters: it, cost: f };
}

function jacobian(X, vars, residuals, r0) {
  const m = r0.length, n = vars.length;
  const J = Array.from({ length: m }, () => new Float64Array(n));
  vars.forEach((v, k) => {
    const h = 1e-7 * Math.max(1, Math.abs(X[v]));
    const x0 = X[v];
    X[v] = x0 + h;
    const r1 = residuals();
    X[v] = x0;
    for (let i = 0; i < m; i++) J[i][k] = (r1[i] - r0[i]) / h;
  });
  return J;
}

function solveLinear(M, b, n) {
  // Gaussian elimination with partial pivoting (M is n×n row-major, modified in place)
  for (let c = 0; c < n; c++) {
    let piv = c, best = Math.abs(M[c * n + c]);
    for (let r = c + 1; r < n; r++) { const v = Math.abs(M[r * n + c]); if (v > best) { best = v; piv = r; } }
    if (best < 1e-18) return null;
    if (piv !== c) {
      for (let k = 0; k < n; k++) { const t = M[c * n + k]; M[c * n + k] = M[piv * n + k]; M[piv * n + k] = t; }
      const t = b[c]; b[c] = b[piv]; b[piv] = t;
    }
    for (let r = c + 1; r < n; r++) {
      const f = M[r * n + c] / M[c * n + c];
      if (!f) continue;
      for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= M[r * n + k] * x[k];
    x[r] = s / M[r * n + r];
  }
  return x;
}

// Degrees of freedom: reduce the Jacobian to row echelon form. A variable is determined when it is a
// pivot column with no coupling to any free column; free columns are the remaining DOF.
function analyzeDof(X, isVar, varList, terms, pIdx, rIdx) {
  const vars = varList;
  const n = vars.length;
  const col = new Map(vars.map((v, k) => [v, k]));
  const rows = [];
  for (const t of terms) {
    const r0 = t.f(X);
    const local = t.deps.filter((d) => isVar[d]);
    const R = r0.map(() => new Float64Array(n));
    for (const v of local) {
      const h = 1e-7 * Math.max(1, Math.abs(X[v]));
      const x0 = X[v];
      X[v] = x0 + h;
      const r1 = t.f(X);
      X[v] = x0;
      r1.forEach((val, i) => (R[i][col.get(v)] = (val - r0[i]) / h));
    }
    rows.push(...R);
  }
  // RREF
  const pivCols = [];
  let r = 0;
  for (let c = 0; c < n && r < rows.length; c++) {
    let piv = -1, best = 1e-7;
    for (let i = r; i < rows.length; i++) if (Math.abs(rows[i][c]) > best) { best = Math.abs(rows[i][c]); piv = i; }
    if (piv < 0) continue;
    [rows[r], rows[piv]] = [rows[piv], rows[r]];
    const pr = rows[r], pv = pr[c];
    for (let k = 0; k < n; k++) pr[k] /= pv;
    for (let i = 0; i < rows.length; i++) {
      if (i === r) continue;
      const f = rows[i][c];
      if (Math.abs(f) < 1e-14) continue;
      for (let k = 0; k < n; k++) rows[i][k] -= f * pr[k];
    }
    pivCols.push([c, r]);
    r++;
  }
  const pivotSet = new Set(pivCols.map(([c]) => c));
  const free = [...Array(n).keys()].filter((c) => !pivotSet.has(c));
  const determined = new Set();
  for (const [c, row] of pivCols) {
    if (free.every((f) => Math.abs(rows[row][f]) < 1e-6)) determined.add(vars[c]);
  }
  const pointDetermined = (id) => {
    const ix = pIdx.get(id);
    if (!ix) return true;
    return (!isVar[ix[0]] || determined.has(ix[0])) && (!isVar[ix[1]] || determined.has(ix[1]));
  };
  const radiusDetermined = (id) => { const i = rIdx.get(id); return i === undefined || !isVar[i] || determined.has(i); };
  return { dof: free.length, pointDetermined, radiusDetermined };
}
