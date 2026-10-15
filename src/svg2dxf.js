// Drawing sheet → DXF. The sheet is rendered as SVG in sheet millimetres; this walks a rendered copy in
// the DOM (so transforms and styles are resolved by the browser), turns paths, lines, rectangles,
// circles and text into DXF entities with y pointing up, and clips detail views to their circles.
// Layers: OUTLINE (visible lines and the frame), HIDDEN (dashed), DIM (annotations), TEXT.

const SAMPLES_PER_CURVE = 16;

// SVG path data → polylines (lists of [x, y]) in the path's own coordinates
export function pathPolylines(d) {
  const tk = d.match(/[MmLlHhVvCcSsQqAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || [];
  const out = [];
  let i = 0, cmd = '', cur = [0, 0], start = [0, 0], line = null, lastCtrl = null;
  const num = () => +tk[i++];
  const isNum = () => i < tk.length && !/^[A-Za-z]$/.test(tk[i]);
  const move = (p) => { if (line && line.length > 1) out.push(line); line = [p]; cur = p; start = p; };
  const to = (p) => { if (!line) line = [cur]; line.push(p); cur = p; };
  while (i < tk.length) {
    if (/^[A-Za-z]$/.test(tk[i])) cmd = tk[i++];
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    const pt = () => { const x = num(), y = num(); return rel ? [cur[0] + x, cur[1] + y] : [x, y]; };
    if (C === 'Z') { if (line) { to(start); out.push(line); line = null; } cur = start; lastCtrl = null; continue; }
    if (!isNum()) { i++; continue; }
    if (C === 'M') { move(pt()); cmd = rel ? 'l' : 'L'; lastCtrl = null; }
    else if (C === 'L') { to(pt()); lastCtrl = null; }
    else if (C === 'H') { const x = num(); to([rel ? cur[0] + x : x, cur[1]]); lastCtrl = null; }
    else if (C === 'V') { const y = num(); to([cur[0], rel ? cur[1] + y : y]); lastCtrl = null; }
    else if (C === 'C' || C === 'S' || C === 'Q') {
      const p0 = cur;
      let c1, c2, p;
      if (C === 'C') { c1 = pt(); c2 = pt(); p = pt(); }
      else if (C === 'S') { c1 = lastCtrl ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]] : cur; c2 = pt(); p = pt(); }
      else { const q = pt(); p = pt(); c1 = [p0[0] + (2 / 3) * (q[0] - p0[0]), p0[1] + (2 / 3) * (q[1] - p0[1])]; c2 = [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])]; }
      for (let k = 1; k <= SAMPLES_PER_CURVE; k++) {
        const t = k / SAMPLES_PER_CURVE, u = 1 - t;
        to([0, 1].map((j) => u * u * u * p0[j] + 3 * u * u * t * c1[j] + 3 * u * t * t * c2[j] + t * t * t * p[j]));
      }
      lastCtrl = c2;
    } else if (C === 'A') {
      const rx0 = Math.abs(num()), ry0 = Math.abs(num()), rot = (num() * Math.PI) / 180, large = num(), sweep = num(), p = pt();
      for (const q of arcPoints(cur, p, rx0, ry0, rot, !!large, !!sweep)) to(q);
      lastCtrl = null;
    } else i++;
  }
  if (line && line.length > 1) out.push(line);
  return out;
}

// points along an SVG elliptical arc (endpoint parameterisation, as in the SVG spec, appendix F.6)
function arcPoints(p1, p2, rx, ry, phi, large, sweep) {
  if (!rx || !ry) return [p2];
  const cs = Math.cos(phi), sn = Math.sin(phi);
  const dx = (p1[0] - p2[0]) / 2, dy = (p1[1] - p2[1]) / 2;
  const x1 = cs * dx + sn * dy, y1 = -sn * dx + cs * dy;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1, den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cx1 = (co * rx * y1) / ry, cy1 = (-co * ry * x1) / rx;
  const cx = cs * cx1 - sn * cy1 + (p1[0] + p2[0]) / 2, cy = sn * cx1 + cs * cy1 + (p1[1] + p2[1]) / 2;
  const ang = (ux, uy, vx, vy) => { const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy); return a; };
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(4, Math.ceil(Math.abs(dt) / (Math.PI / 24)));
  const out = [];
  for (let k = 1; k <= n; k++) {
    const t = t1 + (dt * k) / n, x = rx * Math.cos(t), y = ry * Math.sin(t);
    out.push([cs * x - sn * y + cx, sn * x + cs * y + cy]);
  }
  out[out.length - 1] = p2;
  return out;
}

// keep the parts of a polyline inside a circle (for detail views)
function clipToCircle(poly, c, r) {
  const inside = (p) => Math.hypot(p[0] - c[0], p[1] - c[1]) <= r + 1e-9;
  const pieces = [];
  let cur = null;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1], b = poly[i], dx = b[0] - a[0], dy = b[1] - a[1];
    const fx = a[0] - c[0], fy = a[1] - c[1], A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), Cc = fx * fx + fy * fy - r * r;
    let t0 = 0, t1 = 1;
    if (A < 1e-18) continue;
    const disc = B * B - 4 * A * Cc;
    if (disc <= 0) { if (Cc > 0) { if (cur) { pieces.push(cur); cur = null; } continue; } }
    else { const s = Math.sqrt(disc); t0 = Math.max(0, (-B - s) / (2 * A)); t1 = Math.min(1, (-B + s) / (2 * A)); }
    if (t0 >= t1) { if (cur) { pieces.push(cur); cur = null; } continue; }
    const P0 = [a[0] + dx * t0, a[1] + dy * t0], P1 = [a[0] + dx * t1, a[1] + dy * t1];
    if (!cur || t0 > 1e-9) { if (cur) pieces.push(cur); cur = [P0]; }
    cur.push(P1);
    if (t1 < 1 - 1e-9) { pieces.push(cur); cur = null; }
  }
  if (cur && cur.length > 1) pieces.push(cur);
  return pieces.filter((q) => q.length > 1 && !q.every((p) => !inside(p)));
}

/** DXF entities for a rendered SVG sheet (root: the <svg> element in the DOM; H: sheet height in mm). */
export function svgToDXFEntities(root, H) {
  const ents = [];
  const rootInv = root.getCTM().inverse();
  const M = (el) => rootInv.multiply(el.getCTM()); // element user space → sheet mm (y down)
  const P = (m, x, y) => [m.a * x + m.c * y + m.e, H - (m.b * x + m.d * y + m.f)];
  const clipOf = (el) => {
    for (let e = el; e && e !== root; e = e.parentElement) {
      const ref = e.getAttribute?.('clip-path');
      if (!ref) continue;
      const circ = root.querySelector(`${ref.match(/#([^)"']+)/)?.[0]} circle`);
      if (!circ) return null;
      const m = M(e), c = P(m, +circ.getAttribute('cx'), +circ.getAttribute('cy'));
      return { c, r: +circ.getAttribute('r') * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) };
    }
    return null;
  };
  // model geometry (including the enlarged lines of detail views, which sit among the annotations) is
  // OUTLINE or HIDDEN by its dashes; everything else among the annotations is DIM
  const layerOf = (el, cs) => {
    const dashed = cs.strokeDasharray && cs.strokeDasharray !== 'none';
    if (el.closest('.anno') && !el.closest('[clip-path]')) return 'DIM';
    return dashed ? 'HIDDEN' : 'OUTLINE';
  };
  const stroked = (cs) => cs.stroke && cs.stroke !== 'none' && cs.display !== 'none'; // (the off-screen copy itself is hidden, so visibility can't be used)
  const addPoly = (pts, layer, clip, closed = false) => {
    const pieces = clip ? clipToCircle(pts, clip.c, clip.r) : [pts];
    for (const q of pieces) {
      if (q.length === 2) ents.push({ t: 'LINE', a: q[0], b: q[1], layer });
      else if (q.length > 2) ents.push({ t: 'POLY', pts: q, layer, closed: closed && !clip });
    }
  };
  for (const el of root.querySelectorAll('path, line, rect, circle, polyline, polygon, text')) {
    if (el.closest('defs, clipPath, pattern, #an-preview')) continue;
    const cs = getComputedStyle(el), m = M(el), clip = clipOf(el);
    if (cs.display === 'none') continue;
    const tag = el.tagName.toLowerCase();
    if (tag === 'text') {
      const parts = el.querySelectorAll('tspan').length ? [...el.querySelectorAll('tspan')] : [el];
      for (const t of parts) {
        const text = t.textContent.trim();
        if (!text) continue;
        let pos;
        try { const q = t.getStartPositionOfChar(0); pos = [q.x, q.y]; } catch { pos = [+el.getAttribute('x') || 0, +el.getAttribute('y') || 0]; }
        const anchor = getComputedStyle(t).textAnchor || cs.textAnchor, size = parseFloat(getComputedStyle(t).fontSize) || 3;
        const sc = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)), rot = (-Math.atan2(m.b, m.a) * 180) / Math.PI;
        let xy = P(m, pos[0], pos[1]);
        if (anchor === 'middle' || anchor === 'end') {
          // getStartPositionOfChar gives the left end; DXF centres or right-aligns from the alignment point
          let w = 0;
          try { w = t.getComputedTextLength(); } catch { /* keep 0 */ }
          xy = P(m, pos[0] + (anchor === 'middle' ? w / 2 : w), pos[1]);
        }
        ents.push({ t: 'TEXT', p: xy, h: size * sc * 0.72, text, rot, align: anchor === 'middle' ? 1 : anchor === 'end' ? 2 : 0, layer: 'TEXT' });
      }
      continue;
    }
    if (!stroked(cs)) continue; // white fills behind detail views and the paper itself
    const layer = layerOf(el, cs);
    if (tag === 'path') for (const q of pathPolylines(el.getAttribute('d') || '')) addPoly(q.map((p) => P(m, p[0], p[1])), layer, clip);
    else if (tag === 'line') addPoly([P(m, +el.getAttribute('x1'), +el.getAttribute('y1')), P(m, +el.getAttribute('x2'), +el.getAttribute('y2'))], layer, clip);
    else if (tag === 'rect') {
      const x = +el.getAttribute('x') || 0, y = +el.getAttribute('y') || 0, w = +el.getAttribute('width'), h = +el.getAttribute('height');
      addPoly([[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]].map((p) => P(m, p[0], p[1])), layer, clip, true);
    } else if (tag === 'circle') {
      const c = P(m, +el.getAttribute('cx'), +el.getAttribute('cy')), r = +el.getAttribute('r') * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
      if (r > 1e-6) ents.push({ t: 'CIRCLE', c, r, layer });
    } else {
      const pts = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
      const q = [];
      for (let k = 0; k + 1 < pts.length; k += 2) q.push(P(m, pts[k], pts[k + 1]));
      if (tag === 'polygon' && q.length) q.push(q[0]);
      addPoly(q, layer, clip, tag === 'polygon');
    }
  }
  return ents;
}
