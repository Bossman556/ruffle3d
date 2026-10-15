// DXF import: reads 2D geometry from an ASCII DXF (R12 to current) and converts it into sketch data.
// Supported: LINE, CIRCLE, ARC, LWPOLYLINE and POLYLINE (with bulge arcs), SPLINE (fit or control points),
// ELLIPSE, and INSERT of blocks (position, scale, rotation; nested). Units come from $INSUNITS.

const UNIT_MM = { 0: null, 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 8: 0.0000254, 9: 0.0254, 10: 914.4 };

// group-code / value pairs
function pairs(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push([parseInt(lines[i].trim(), 10), lines[i + 1].trim()]);
  return out;
}

// splits a list of pairs into entities ({ type, codes: [[code, value]...] })
function entitiesOf(list) {
  const ents = [];
  let cur = null;
  for (const [c, v] of list) {
    if (c === 0) { cur = { type: v, codes: [] }; ents.push(cur); } else if (cur) cur.codes.push([c, v]);
  }
  return ents;
}
const num = (e, code, def = 0) => { const f = e.codes.find(([c]) => c === code); return f ? parseFloat(f[1]) : def; };
const all = (e, code) => e.codes.filter(([c]) => c === code).map(([, v]) => parseFloat(v));
const str = (e, code) => e.codes.find(([c]) => c === code)?.[1];

export function parseDXF(text) {
  const list = pairs(text);
  // sections
  const sections = {};
  for (let i = 0; i < list.length; i++) {
    if (list[i][0] === 0 && list[i][1] === 'SECTION' && list[i + 1]?.[0] === 2) {
      const name = list[i + 1][1];
      let j = i + 2;
      while (j < list.length && !(list[j][0] === 0 && list[j][1] === 'ENDSEC')) j++;
      sections[name] = list.slice(i + 2, j);
      i = j;
    }
  }
  let insunits = 0;
  const hdr = sections.HEADER || [];
  for (let i = 0; i < hdr.length; i++) if (hdr[i][0] === 9 && hdr[i][1] === '$INSUNITS') insunits = parseInt(hdr[i + 1]?.[1], 10) || 0;
  // blocks
  const blocks = {};
  const bl = entitiesOf(sections.BLOCKS || []);
  let curBlock = null;
  for (const e of bl) {
    if (e.type === 'BLOCK') { curBlock = { name: str(e, 2), base: [num(e, 10), num(e, 20)], ents: [] }; blocks[curBlock.name] = curBlock; }
    else if (e.type === 'ENDBLK') curBlock = null;
    else if (curBlock) curBlock.ents.push(e);
  }
  return { entities: entitiesOf(sections.ENTITIES || []), blocks, insunits, unitScale: UNIT_MM[insunits] ?? null };
}

// bulge arc between two points → { c, r, a0, a1 } (ccw)
function bulgeArc(p, q, b) {
  const th = 4 * Math.atan(b);
  const dx = q[0] - p[0], dy = q[1] - p[1], d = Math.hypot(dx, dy);
  const r = d / (2 * Math.sin(Math.abs(th) / 2));
  const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
  const h = Math.sqrt(Math.max(r * r - (d / 2) ** 2, 0)) * Math.sign(b) * (Math.abs(th) > Math.PI ? -1 : 1);
  const c = [mx - (dy / d) * h, my + (dx / d) * h];
  const ang = (s) => Math.atan2(s[1] - c[1], s[0] - c[0]);
  return b > 0 ? { c, r, a0: ang(p), a1: ang(q) } : { c, r, a0: ang(q), a1: ang(p) };
}

// evaluates a B-spline (control points, knots, degree) at n samples
function sampleBSpline(ctrl, knots, deg, weights, n) {
  const out = [];
  const t0 = knots[deg], t1 = knots[knots.length - deg - 1];
  for (let s = 0; s <= n; s++) {
    const t = Math.min(t0 + ((t1 - t0) * s) / n, t1 - 1e-12 * (t1 - t0));
    let k = deg;
    while (k < knots.length - deg - 2 && t >= knots[k + 1]) k++;
    const d = [];
    for (let j = 0; j <= deg; j++) { const w = weights?.[k - deg + j] ?? 1; const P = ctrl[k - deg + j]; d.push([P[0] * w, P[1] * w, w]); }
    for (let r = 1; r <= deg; r++) for (let j = deg; j >= r; j--) {
      const i = k - deg + j, den = knots[i + deg - r + 1] - knots[i], a = den > 1e-14 ? (t - knots[i]) / den : 0;
      for (let c = 0; c < 3; c++) d[j][c] = (1 - a) * d[j - 1][c] + a * d[j][c];
    }
    out.push([d[deg][0] / d[deg][2], d[deg][1] / d[deg][2]]);
  }
  return out;
}

/**
 * Flattens DXF entities into simple 2D primitives (millimetres after `scale`):
 *   { t: 'line', a, b } | { t: 'circle', c, r } | { t: 'arc', c, r, a0, a1 } | { t: 'spline', pts, closed }
 */
export function dxfPrimitives(dxf, scale = 1) {
  const prims = [], skipped = {};
  const xf = (T, p) => [T.ox + T.s * (p[0] * T.cos * T.sx - p[1] * T.sin * T.sy), T.oy + T.s * (p[0] * T.sin * T.sx + p[1] * T.cos * T.sy)];
  const walk = (ents, T, depth) => {
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      const P = (x, y) => xf(T, [x, y]);
      const uniform = Math.abs(Math.abs(T.sx) - Math.abs(T.sy)) < 1e-9;
      const R = (r) => r * T.s * Math.abs(T.sx);
      const flip = T.sx * T.sy < 0, rot = Math.atan2(T.sin, T.cos);
      switch (e.type) {
        case 'LINE': prims.push({ t: 'line', a: P(num(e, 10), num(e, 20)), b: P(num(e, 11), num(e, 21)) }); break;
        case 'CIRCLE': if (uniform) prims.push({ t: 'circle', c: P(num(e, 10), num(e, 20)), r: R(num(e, 40)) }); else skipped.CIRCLE = (skipped.CIRCLE || 0) + 1; break;
        case 'ARC': {
          let a0 = (num(e, 50) * Math.PI) / 180, a1 = (num(e, 51) * Math.PI) / 180;
          if (flip) [a0, a1] = [Math.PI - a1, Math.PI - a0];
          prims.push({ t: 'arc', c: P(num(e, 10), num(e, 20)), r: R(num(e, 40)), a0: a0 + rot, a1: a1 + rot });
          break;
        }
        case 'LWPOLYLINE': {
          const xs = all(e, 10), ys = all(e, 20);
          // bulges are attached to the vertex they follow
          const bul = []; let vi = -1;
          for (const [c, v] of e.codes) { if (c === 10) vi++; if (c === 42) bul[vi] = parseFloat(v); }
          const closed = (num(e, 70) & 1) === 1;
          const pts = xs.map((x, k) => P(x, ys[k]));
          addPoly(pts, bul.map((b) => (flip ? -b : b)), closed);
          break;
        }
        case 'POLYLINE': {
          const closed = (num(e, 70) & 1) === 1;
          const pts = [], bul = [];
          let j = i + 1;
          for (; j < ents.length && ents[j].type === 'VERTEX'; j++) { pts.push(P(num(ents[j], 10), num(ents[j], 20))); bul.push((flip ? -1 : 1) * num(ents[j], 42)); }
          if (ents[j]?.type === 'SEQEND') j++;
          i = j - 1;
          addPoly(pts, bul, closed);
          break;
        }
        case 'SPLINE': {
          const deg = num(e, 71, 3), closed = (num(e, 70) & 1) === 1;
          const fx = all(e, 11), fy = all(e, 21);
          let pts;
          if (fx.length >= 2) pts = fx.map((x, k) => P(x, fy[k]));
          else {
            const cx = all(e, 10), cy = all(e, 20), kn = all(e, 40), w = all(e, 41);
            const ctrl = cx.map((x, k) => [x, cy[k]]);
            if (ctrl.length < 2 || kn.length !== ctrl.length + deg + 1) { skipped.SPLINE = (skipped.SPLINE || 0) + 1; break; }
            pts = sampleBSpline(ctrl, kn, deg, w.length === ctrl.length ? w : null, Math.max(8, ctrl.length * 4)).map((q) => P(q[0], q[1]));
          }
          if (closed && pts.length > 2 && Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]) < 1e-9) pts.pop();
          prims.push({ t: 'spline', pts, closed });
          break;
        }
        case 'ELLIPSE': {
          const c = [num(e, 10), num(e, 20)], mj = [num(e, 11), num(e, 21)], ratio = num(e, 40, 1);
          let s0 = num(e, 41, 0), s1 = num(e, 42, 2 * Math.PI);
          if (s1 <= s0) s1 += 2 * Math.PI;
          const full = Math.abs(s1 - s0 - 2 * Math.PI) < 1e-6;
          const a = Math.hypot(mj[0], mj[1]), ang = Math.atan2(mj[1], mj[0]);
          const n = full ? 48 : Math.max(8, Math.ceil(((s1 - s0) / (2 * Math.PI)) * 48));
          const pts = [];
          for (let k = 0; k <= (full ? n - 1 : n); k++) {
            const t = s0 + ((s1 - s0) * k) / n, x = a * Math.cos(t), y = a * ratio * Math.sin(t);
            pts.push(P(c[0] + x * Math.cos(ang) - y * Math.sin(ang), c[1] + x * Math.sin(ang) + y * Math.cos(ang)));
          }
          prims.push({ t: 'spline', pts, closed: full });
          break;
        }
        case 'INSERT': {
          const b = dxf.blocks[str(e, 2)];
          if (!b || depth > 8) break;
          const sx = num(e, 41, 1), sy = num(e, 42, 1), r = (num(e, 50) * Math.PI) / 180;
          const ins = P(num(e, 10), num(e, 20));
          // child transform: translate(-base) → scale → rotate → insert point (composed with the parent)
          const cosr = Math.cos(r), sinr = Math.sin(r);
          const child = {
            ox: ins[0], oy: ins[1], s: T.s,
            sx: T.sx * sx, sy: T.sy * sy,
            cos: T.cos * cosr - T.sin * sinr, sin: T.sin * cosr + T.cos * sinr,
          };
          const based = b.ents.map((be) => ({ ...be, codes: be.codes.map(([cd, v]) => (cd === 10 || cd === 11 ? [cd, String(parseFloat(v) - b.base[0])] : cd === 20 || cd === 21 ? [cd, String(parseFloat(v) - b.base[1])] : [cd, v])) }));
          walk(based, child, depth + 1);
          break;
        }
        case 'POINT': case 'TEXT': case 'MTEXT': case 'DIMENSION': case 'HATCH': case 'VERTEX': case 'SEQEND': case 'ATTRIB': case 'ATTDEF': case 'SOLID': case 'VIEWPORT':
          if (!['VERTEX', 'SEQEND'].includes(e.type)) skipped[e.type] = (skipped[e.type] || 0) + 1;
          break;
        default: skipped[e.type] = (skipped[e.type] || 0) + 1;
      }
    }
  };
  function addPoly(pts, bul, closed) {
    const n = pts.length;
    for (let k = 0; k < (closed ? n : n - 1); k++) {
      const p = pts[k], q = pts[(k + 1) % n], b = bul[k] || 0;
      if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-12) continue;
      if (Math.abs(b) < 1e-9) prims.push({ t: 'line', a: p, b: q });
      else prims.push({ t: 'arc', ...bulgeArc(p, q, b) });
    }
  }
  walk(dxf.entities, { ox: 0, oy: 0, s: scale, sx: 1, sy: 1, cos: 1, sin: 0 }, 0);
  return { prims, skipped };
}

/** Converts primitives into sketch data (shared endpoints merged so profiles close). */
export function primitivesToSketch(prims, { center = false, tol = 1e-6 } = {}) {
  let ox = 0, oy = 0;
  if (center && prims.length) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const ext = (p, r = 0) => { x0 = Math.min(x0, p[0] - r); y0 = Math.min(y0, p[1] - r); x1 = Math.max(x1, p[0] + r); y1 = Math.max(y1, p[1] + r); };
    for (const p of prims) { if (p.t === 'line') { ext(p.a); ext(p.b); } else if (p.t === 'spline') p.pts.forEach((q) => ext(q)); else ext(p.c, p.r); }
    ox = (x0 + x1) / 2; oy = (y0 + y1) / 2;
  }
  const points = [], curves = [], index = new Map();
  let k = 0;
  const id = (pre) => `${pre}${(k++).toString(36)}`;
  const pt = (p) => {
    const x = p[0] - ox, y = p[1] - oy;
    const key = `${Math.round(x / tol)},${Math.round(y / tol)}`;
    let pid = index.get(key);
    if (!pid) { pid = id('dp'); index.set(key, pid); points.push({ id: pid, x: +x.toFixed(6), y: +y.toFixed(6) }); }
    return pid;
  };
  for (const p of prims) {
    if (p.t === 'line') { const a = pt(p.a), b = pt(p.b); if (a !== b) curves.push({ id: id('dc'), type: 'line', a, b }); }
    else if (p.t === 'circle') curves.push({ id: id('dc'), type: 'circle', c: pt(p.c), r: +p.r.toFixed(6) });
    else if (p.t === 'arc') {
      const on = (a) => [p.c[0] + p.r * Math.cos(a), p.c[1] + p.r * Math.sin(a)];
      curves.push({ id: id('dc'), type: 'arc', c: pt(p.c), a: pt(on(p.a0)), b: pt(on(p.a1)) });
    } else if (p.t === 'spline' && p.pts.length >= 2) {
      const ids = p.pts.map(pt).filter((q, i, arr) => i === 0 || q !== arr[i - 1]);
      if (ids.length >= 2) curves.push({ id: id('dc'), type: 'spline', pts: ids, closed: !!p.closed });
    }
  }
  return { points, curves, constraints: [], dims: [] };
}

/** Minimal ASCII DXF writer. ents: LINE {a,b} | CIRCLE {c,r} | ARC {c,r,a0,a1 degrees ccw} | POLY {pts, closed?}. */
export function writeDXF(ents, units = 4) {
  const f = (v) => (Math.abs(v) < 1e-12 ? 0 : +v.toFixed(6));
  const out = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '9', '$INSUNITS', '70', String(units), '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES'];
  for (const e of ents) {
    const lay = e.layer || '0';
    if (e.t === 'LINE') out.push('0', 'LINE', '8', lay, '10', f(e.a[0]), '20', f(e.a[1]), '30', '0', '11', f(e.b[0]), '21', f(e.b[1]), '31', '0');
    else if (e.t === 'CIRCLE') out.push('0', 'CIRCLE', '8', lay, '10', f(e.c[0]), '20', f(e.c[1]), '30', '0', '40', f(e.r));
    else if (e.t === 'ARC') out.push('0', 'ARC', '8', lay, '10', f(e.c[0]), '20', f(e.c[1]), '30', '0', '40', f(e.r), '50', f(e.a0), '51', f(e.a1));
    else if (e.t === 'POLY') {
      out.push('0', 'POLYLINE', '8', lay, '66', '1', '10', '0', '20', '0', '30', '0', '70', e.closed ? '1' : '0');
      for (const q of e.pts) out.push('0', 'VERTEX', '8', lay, '10', f(q[0]), '20', f(q[1]), '30', '0');
      out.push('0', 'SEQEND', '8', lay);
    } else if (e.t === 'TEXT') {
      // align 0 left, 1 centre, 2 right; centred and right text are placed by their second alignment point
      const txt = String(e.text).replace(/\s+/g, ' ');
      out.push('0', 'TEXT', '8', lay, '10', f(e.p[0]), '20', f(e.p[1]), '30', '0', '40', f(e.h || 2.5), '1', txt, '50', f(e.rot || 0));
      if (e.align) out.push('72', String(e.align), '11', f(e.p[0]), '21', f(e.p[1]), '31', '0');
    }
  }
  out.push('0', 'ENDSEC', '0', 'EOF');
  return out.join('\r\n') + '\r\n';
}
