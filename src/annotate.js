// Drawing annotations placed by the user: linear / aligned / diameter / radius / angle dimensions with
// tolerances, notes with leaders, GD&T feature control frames and datum flags.
// Dimensions are stored in a view's own model coordinates (mm), so they keep their values and stay
// attached to the view when the sheet or scale changes. Notes and frames live in sheet coordinates.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const f2 = (x) => (Math.round(x * 100) / 100).toString();
export const GDT = [
  ['flatness', '⏥', 'Flatness'], ['straightness', '⏤', 'Straightness'], ['circularity', '○', 'Circularity'], ['cylindricity', '⌭', 'Cylindricity'],
  ['profileLine', '⌒', 'Profile of a line'], ['profileSurface', '⌓', 'Profile of a surface'], ['perpendicularity', '⟂', 'Perpendicularity'],
  ['parallelism', '∥', 'Parallelism'], ['angularity', '∠', 'Angularity'], ['position', '⌖', 'Position'], ['concentricity', '◎', 'Concentricity'],
  ['symmetry', '⌯', 'Symmetry'], ['runout', '↗', 'Circular runout'], ['totalRunout', '⌰', 'Total runout'],
];

// ---------- snapping data from projected SVG paths (absolute M / L / A / C / Z) ----------
function arcCenter(x1, y1, rx, ry, large, sweep, x2, y2) {
  // SVG endpoint → centre parameterisation (circles: rx = ry, no rotation)
  const r = rx, dx = (x1 - x2) / 2, dy = (y1 - y2) / 2, d2 = dx * dx + dy * dy || 1e-12;
  const coef = Math.sqrt(Math.max(0, (r * r - d2) / d2)) * (large === sweep ? -1 : 1);
  void ry;
  return [(x1 + x2) / 2 + coef * dy, (y1 + y2) / 2 - coef * dx];
}
export function parseSnaps(paths) {
  const pts = [], lines = [], arcs = [], arcEnds = [];
  for (const d of paths) {
    const tk = d.match(/[MLACZHVmlaczhv]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
    let i = 0, cur = [0, 0], start = [0, 0], cmd = '';
    const num = () => +tk[i++];
    while (i < tk.length) {
      if (/[A-Za-z]/.test(tk[i])) cmd = tk[i++];
      if (cmd === 'M') { cur = [num(), num()]; start = cur; arcEnds.push(cur); cmd = 'L'; }
      else if (cmd === 'L') { const p = [num(), num()]; lines.push([cur, p]); pts.push(p, [(cur[0] + p[0]) / 2, (cur[1] + p[1]) / 2]); cur = p; }
      else if (cmd === 'A') {
        const rx = num(), ry = num(); num(); const large = num(), sweep = num(), p = [num(), num()];
        const c = arcCenter(cur[0], cur[1], rx, ry, large, sweep, p[0], p[1]);
        arcs.push({ c, r: rx, a: cur, b: p });
        arcEnds.push(cur, p);
        cur = p;
      } else if (cmd === 'C') { num(); num(); num(); num(); const p = [num(), num()]; pts.push(p); cur = p; }
      else if (cmd === 'Z' || cmd === 'z') { if (cur[0] !== start[0] || cur[1] !== start[1]) lines.push([cur, start]); cur = start; cmd = ''; }
      else i++;
    }
  }
  // arcs sharing a centre and radius form one circle (two halves) or a partial arc (a fillet)
  const circles = [];
  for (const a of arcs) {
    let c = circles.find((x) => Math.hypot(x.c[0] - a.c[0], x.c[1] - a.c[1]) < 1e-4 && Math.abs(x.r - a.r) < 1e-4);
    if (!c) circles.push((c = { c: a.c, r: a.r, n: 0 }));
    c.n++;
  }
  for (const c of circles) { c.full = c.n >= 2; pts.push(c.c); }
  // arc end points are real vertices only on partial arcs (fillets); the seams where a full circle's
  // two halves meet are not, so they are left out and a click there picks the circle instead
  const onFull = (q) => circles.some((c) => c.full && Math.abs(Math.hypot(q[0] - c.c[0], q[1] - c.c[1]) - c.r) < 1e-4);
  for (const q of arcEnds) if (!onFull(q)) pts.push(q);
  return { pts, lines, circles };
}

// ---------- rendering ----------
const arrow = (x, y, ux, uy, s = 2.6) => `<path d="M${x} ${y} L${x - ux * s + uy * s * 0.32} ${y - uy * s - ux * s * 0.32} L${x - ux * s - uy * s * 0.32} ${y - uy * s + ux * s * 0.32} Z" class="an-fill"/>`;
const label = (x, y, txt, rot = 0, cls = 'an-text') => `<text x="${x}" y="${y}" class="${cls}" ${rot ? `transform="rotate(${rot} ${x} ${y})"` : ''}>${txt}</text>`;
const tolText = (t) => (t ? `<tspan class="an-tol" dx="0.8">${esc(t)}</tspan>` : '');

/**
 * Keeps view dimensions attached to the model when it changes. Each dimension remembers the outline of
 * its view when it was placed (vb). After a rebuild, every anchor is carried into the new outline in
 * proportion, then snapped to the nearest real vertex (or circle, for diameters and radii), so a
 * dimension follows the edge it measures. The placement keeps its distance outside the outline.
 * Anchors that can't be found are flagged (lost) and drawn in red. Mutates items; returns how many moved.
 * bboxes: { view: [[x0, y0], [x1, y1]] }, snaps: { view: parseSnaps(...) }
 */
export function reanchor(items, bboxes, snaps) {
  let moved = 0;
  for (const it of items) {
    if (!it.view) continue;
    const nb = bboxes[it.view], S = snaps[it.view];
    if (!nb || !S) continue;
    const ob = it.vb;
    it.vb = nb.map((p) => p.slice());
    if (!ob || ob.every((p, i) => Math.abs(p[0] - nb[i][0]) < 1e-6 && Math.abs(p[1] - nb[i][1]) < 1e-6)) continue;
    const map = (p, outside = false) => [0, 1].map((k) => {
      const lo = ob[0][k], hi = ob[1][k], nlo = nb[0][k], nhi = nb[1][k];
      if (outside && p[k] < lo) return nlo - (lo - p[k]);
      if (outside && p[k] > hi) return nhi + (p[k] - hi);
      return hi - lo > 1e-9 ? nlo + ((p[k] - lo) / (hi - lo)) * (nhi - nlo) : p[k] + (nlo - lo);
    });
    const tol = Math.max(1, 0.08 * Math.hypot(nb[1][0] - nb[0][0], nb[1][1] - nb[0][1]));
    const nearPt = (q) => { let best = null, bd = tol; for (const c of S.pts) { const d = Math.hypot(c[0] - q[0], c[1] - q[1]); if (d < bd) { bd = d; best = c; } } return best; };
    let lost = false;
    const snapPt = (p) => { const q = map(p), c = nearPt(q); if (!c) lost = true; return c ? c.slice() : q; };
    if (it.t === 'lin') { it.a = snapPt(it.a); it.b = snapPt(it.b); }
    else if (it.t === 'ang') { it.o = map(it.o); it.a = snapPt(it.a); it.b = snapPt(it.b); }
    else if (it.t === 'dia' || it.t === 'rad') {
      const q = map(it.c);
      let best = null, bd = tol;
      for (const c of S.circles) { const d = Math.hypot(c.c[0] - q[0], c.c[1] - q[1]) + 0.25 * Math.abs(c.r - it.r); if (d < bd && !!c.full === (it.t === 'dia')) { bd = d; best = c; } }
      if (best) { it.c = best.c.slice(); it.r = best.r; } else { it.c = q; lost = true; }
    } else continue;
    it.at = map(it.at, true);
    if (lost) it.lost = true; else delete it.lost;
    moved++;
  }
  return moved;
}

/** SVG for all annotations. L: { views: { name: { toSheet(x,y) } }, du(mm) → display string } */
export function annotationsSVG(items, L, selId) {
  return items.map((it) => {
    const sel = it.id === selId ? ' an-sel' : '';
    let body = '';
    if (it.t === 'detail') body = L.detail ? L.detail(it) : '';
    else if (it.view) {
      const V = L.views[it.view];
      if (!V) return '';
      const S = (p) => V.toSheet(p[0], p[1]);
      if (it.t === 'lin') {
        const A = S(it.a), B = S(it.b), P = S(it.at);
        let a1, b1, val, rot = 0;
        if (it.dir === 'h') { a1 = [A[0], P[1]]; b1 = [B[0], P[1]]; val = Math.abs(it.b[0] - it.a[0]); }
        else if (it.dir === 'v') { a1 = [P[0], A[1]]; b1 = [P[0], B[1]]; val = Math.abs(it.b[1] - it.a[1]); rot = -90; }
        else {
          const ux = B[0] - A[0], uy = B[1] - A[1], l = Math.hypot(ux, uy) || 1, nx = -uy / l, ny = ux / l;
          const off = (P[0] - A[0]) * nx + (P[1] - A[1]) * ny;
          a1 = [A[0] + nx * off, A[1] + ny * off]; b1 = [B[0] + nx * off, B[1] + ny * off];
          val = Math.hypot(it.b[0] - it.a[0], it.b[1] - it.a[1]);
          rot = (Math.atan2(uy, ux) * 180) / Math.PI;
          if (rot > 90) rot -= 180; if (rot < -90) rot += 180;
        }
        const ext = (p, q) => { const dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy); if (l < 0.5) return ''; const ux = dx / l, uy = dy / l; return `<line x1="${p[0] + ux}" y1="${p[1] + uy}" x2="${q[0] + ux * 1.5}" y2="${q[1] + uy * 1.5}" class="an-thin"/>`; };
        const dl = Math.hypot(b1[0] - a1[0], b1[1] - a1[1]) || 1, ux = (b1[0] - a1[0]) / dl, uy = (b1[1] - a1[1]) / dl;
        const m = [(a1[0] + b1[0]) / 2, (a1[1] + b1[1]) / 2];
        const tx = rot === -90 ? [m[0] - 1.2, m[1]] : [m[0] - Math.sin((rot * Math.PI) / 180) * -1.2, m[1] - Math.cos((rot * Math.PI) / 180) * 1.2];
        body = `${ext(A, a1)}${ext(B, b1)}<line x1="${a1[0]}" y1="${a1[1]}" x2="${b1[0]}" y2="${b1[1]}" class="an-line"/>${arrow(a1[0], a1[1], -ux, -uy)}${arrow(b1[0], b1[1], ux, uy)}
          <text x="${tx[0]}" y="${tx[1]}" class="an-text" ${rot ? `transform="rotate(${rot} ${tx[0]} ${tx[1]})"` : ''}>${esc(it.text || L.du(val))}${tolText(it.tol)}</text>`;
      } else if (it.t === 'dia' || it.t === 'rad') {
        const C = S(it.c), P = S(it.at), rs = it.r * V.k;
        const dx = P[0] - C[0], dy = P[1] - C[1], l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l;
        const edge = [C[0] + ux * rs, C[1] + uy * rs];
        const start = it.t === 'dia' ? [C[0] - ux * rs, C[1] - uy * rs] : C;
        const shoulder = [P[0] + (ux >= 0 ? 4 : -4), P[1]];
        const txt = `${it.t === 'dia' ? 'Ø' : 'R'}${it.text || L.du(it.t === 'dia' ? it.r * 2 : it.r)}`;
        body = `<line x1="${start[0]}" y1="${start[1]}" x2="${P[0]}" y2="${P[1]}" class="an-line"/><line x1="${P[0]}" y1="${P[1]}" x2="${shoulder[0]}" y2="${shoulder[1]}" class="an-line"/>${arrow(edge[0], edge[1], -ux, -uy)}${it.t === 'dia' ? arrow(start[0], start[1], ux, uy) : ''}
          <text x="${shoulder[0] + (ux >= 0 ? 0.8 : -0.8)}" y="${shoulder[1] - 0.9}" class="an-text" text-anchor="${ux >= 0 ? 'start' : 'end'}">${esc(txt)}${tolText(it.tol)}</text>`;
      } else if (it.t === 'ang') {
        const O = S(it.o), A = S(it.a), B = S(it.b), P = S(it.at);
        const r = Math.hypot(P[0] - O[0], P[1] - O[1]);
        const a0 = Math.atan2(A[1] - O[1], A[0] - O[0]), a1 = Math.atan2(B[1] - O[1], B[0] - O[0]);
        let da = a1 - a0; while (da <= -Math.PI) da += 2 * Math.PI; while (da > Math.PI) da -= 2 * Math.PI;
        const p0 = [O[0] + r * Math.cos(a0), O[1] + r * Math.sin(a0)], p1 = [O[0] + r * Math.cos(a1), O[1] + r * Math.sin(a1)];
        const deg = Math.abs((da * 180) / Math.PI), am = a0 + da / 2;
        body = `<path d="M${p0[0]} ${p0[1]} A${r} ${r} 0 0 ${da > 0 ? 1 : 0} ${p1[0]} ${p1[1]}" class="an-line" fill="none"/>
          ${arrow(p0[0], p0[1], Math.sin(a0) * Math.sign(da), -Math.cos(a0) * Math.sign(da))}${arrow(p1[0], p1[1], -Math.sin(a1) * Math.sign(da), Math.cos(a1) * Math.sign(da))}
          ${label(O[0] + (r + 2.5) * Math.cos(am), O[1] + (r + 2.5) * Math.sin(am) + 1, `${esc(it.text || f2(deg))}°${it.tol ? ` ${esc(it.tol)}` : ''}`)}`;
      }
    } else if (it.t === 'note') {
      const lines = String(it.text || '').split('\n');
      const lead = it.leader ? `<line x1="${it.leader[0]}" y1="${it.leader[1]}" x2="${it.at[0]}" y2="${it.at[1] - 1}" class="an-line"/>${arrow(it.leader[0], it.leader[1], (it.leader[0] - it.at[0]) / (Math.hypot(it.leader[0] - it.at[0], it.leader[1] - it.at[1] + 1) || 1), (it.leader[1] - it.at[1] + 1) / (Math.hypot(it.leader[0] - it.at[0], it.leader[1] - it.at[1] + 1) || 1))}` : '';
      body = `${lead}<text x="${it.at[0]}" y="${it.at[1]}" class="an-note">${lines.map((l, i) => `<tspan x="${it.at[0]}" dy="${i ? 4.4 : 0}">${esc(l)}</tspan>`).join('')}</text>`;
    } else if (it.t === 'gdt') {
      const sym = (GDT.find((g) => g[0] === it.sym) || GDT[0])[1];
      const cells = [sym, it.tol || '0.1', ...String(it.datums || '').split(/[\s|,]+/).filter(Boolean)];
      const w = cells.map((c, i) => (i === 0 ? 6 : Math.max(6, c.length * 2.1 + 2.4)));
      let x = it.at[0];
      const h = 6, y = it.at[1] - h / 2;
      const boxes = cells.map((c, i) => { const s = `<rect x="${x}" y="${y}" width="${w[i]}" height="${h}" class="an-box"/><text x="${x + w[i] / 2}" y="${y + h - 1.7}" class="${i === 0 ? 'an-sym' : 'an-text'}" text-anchor="middle">${esc(c)}</text>`; x += w[i]; return s; }).join('');
      const lead = it.leader ? `<line x1="${it.leader[0]}" y1="${it.leader[1]}" x2="${it.at[0]}" y2="${it.at[1]}" class="an-line"/>${arrow(it.leader[0], it.leader[1], Math.sign(it.leader[0] - it.at[0]) || 1, 0)}` : '';
      body = `${lead}${boxes}`;
    } else if (it.t === 'datum') {
      const [x, y] = it.at, tip = it.leader || [x, y + 8];
      body = `<line x1="${tip[0]}" y1="${tip[1]}" x2="${x}" y2="${y + 3}" class="an-line"/><path d="M${tip[0] - 1.6} ${tip[1]} L${tip[0] + 1.6} ${tip[1]} L${tip[0]} ${tip[1] - 2.6} Z" class="an-fill"/>
        <rect x="${x - 3}" y="${y - 3}" width="6" height="6" class="an-box"/><text x="${x}" y="${y + 1.4}" class="an-text" text-anchor="middle">${esc(it.text || 'A')}</text>`;
    }
    return `<g class="an${sel}${it.lost ? ' an-lost' : ''}" data-an="${it.id}">${body}</g>`;
  }).join('');
}

export const ANNOTATION_CSS = `
  .an-line{stroke:#111;stroke-width:.25;fill:none}.an-thin{stroke:#111;stroke-width:.18}.an-fill{fill:#111;stroke:none}
  .an-box{fill:#fff;stroke:#111;stroke-width:.3}
  .an-text{font:3.2px 'Segoe UI',Arial,sans-serif;fill:#111;stroke:none;text-anchor:middle}
  .an-tol{font-size:2.4px}
  .an-note{font:3.2px 'Segoe UI',Arial,sans-serif;fill:#111;stroke:none}
  .an-sym{font:3.8px 'Segoe UI Symbol','Segoe UI',Arial,sans-serif;fill:#111;stroke:none}
  .an-sel .an-line,.an-sel .an-thin,.an-sel .an-box{stroke:#2f6bff}.an-sel .an-fill,.an-sel text{fill:#2f6bff}
  .an-lost .an-line,.an-lost .an-thin{stroke:#d92d20}.an-lost .an-fill,.an-lost text{fill:#d92d20}
  .an{cursor:pointer}`;
