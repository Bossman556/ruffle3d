// Drawing workspace: generates a 2D engineering drawing (third-angle projection) from the model.
// Views are computed by the kernel with hidden-line removal; the sheet is laid out here as SVG in mm.
import { icon } from './icons.js';
import { MATERIALS, DEFAULT_MATERIAL } from './materials.js';
import { parseSnaps, annotationsSVG, reanchor, ANNOTATION_CSS, GDT } from './annotate.js';

const SHEETS = { A4: [297, 210], A3: [420, 297], A2: [594, 420], Letter: [279.4, 215.9] };
const SCALES = [10, 5, 4, 2, 1, 1 / 2, 1 / 2.5, 1 / 4, 1 / 5, 1 / 10, 1 / 20, 1 / 50, 1 / 100];
const scaleLabel = (s) => (s >= 1 ? `${s}:1` : `1:${+(1 / s).toFixed(1)}`);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const f1 = (x) => (Math.round(x * 100) / 100).toString();

export class DrawingWorkspace {
  constructor(app) {
    this.app = app;
    this.isOpen = false;
    this.opts = { sheet: 'A3', scale: 'auto', hidden: true, iso: true, dims: true, section: 'none', sectionAt: 50, parts: true, balloons: true, holes: true };
    this.tool = 'select';
    this.dimMode = 'auto';
    this.sel = null;
    this.pending = null;
  }

  get annos() { return (this.app.doc.dwgAnno ||= []); }

  async open(onBack) {
    this.onBack = onBack;
    const app = this.app;
    const ids = app.result.bodies.map((b) => b.id).filter((id) => app.bodyMeta(id).visible !== false);
    if (!ids.length) return app.toast('There are no visible bodies to draw');
    this.ids = ids;
    this.isOpen = true;
    let el = document.getElementById('drawing');
    if (!el) { el = document.createElement('div'); el.id = 'drawing'; document.body.appendChild(el); }
    this.el = el;
    el.classList.add('open');
    el.innerHTML = '<div class="dw-loading">Generating views (hidden-line removal)…</div>';
    try {
      await this.fetch();
    } catch (e) {
      el.innerHTML = `<div class="dw-loading">Could not create drawing: ${esc(e.message)} <button class="btn" data-x>Close</button></div>`;
      el.querySelector('[data-x]').onclick = () => this.close();
      return;
    }
    this.render();
  }

  async fetch() {
    const o = this.opts;
    const section = o.section === 'none' ? null : { axis: o.section, at: o.sectionAt / 100 };
    this.data = await this.app.kernel.drawing(this.ids, ['front', 'top', 'right', 'iso'], section);
    const sv = this.data.views.find((v) => v.view === 'section');
    if (sv?.error) this.app.toast(`Section view: ${sv.error}`, 'warn');
    // snap points, lines and circles of each view, in the view's own coordinates
    this.snaps = {};
    for (const v of this.data.views) if (v.visible && v.view !== 'iso') this.snaps[v.view] = parseSnaps([...v.visible, ...(v.hidden || [])]);
    // dimensions follow the model: re-attach them to the new views
    const bboxes = Object.fromEntries(this.data.views.filter((v) => v.bbox).map((v) => [v.view, v.bbox]));
    if (reanchor(this.annos, bboxes, this.snaps)) this.app.scheduleSave();
    const lost = this.annos.filter((a) => a.lost).length;
    if (lost) this.app.toast(`${lost} dimension${lost === 1 ? '' : 's'} could not find ${lost === 1 ? 'its' : 'their'} edges after the change (shown in red). Delete and place ${lost === 1 ? 'it' : 'them'} again.`, 'warn');
  }

  close(silent = false) {
    this.isOpen = false;
    this.pending = null;
    if (this._keys) { document.removeEventListener('keydown', this._keys, true); this._keys = null; }
    this.el?.classList.remove('open');
    if (!silent) this.onBack?.();
  }

  render() {
    const o = this.opts;
    this.el.innerHTML = `
      <div class="dw-bar">
        <span class="dw-title">${icon('drawing')} ${esc(this.app.doc.name)} — Drawing</span>
        <label>Sheet <select data-o="sheet">${Object.keys(SHEETS).map((k) => `<option ${k === o.sheet ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
        <label>Scale <select data-o="scale"><option value="auto">Auto</option>${SCALES.map((s) => `<option value="${s}" ${String(s) === String(o.scale) ? 'selected' : ''}>${scaleLabel(s)}</option>`).join('')}</select></label>
        <label><input type="checkbox" data-o="hidden" ${o.hidden ? 'checked' : ''}> Hidden lines</label>
        <label><input type="checkbox" data-o="iso" ${o.iso ? 'checked' : ''}> Isometric view</label>
        <label><input type="checkbox" data-o="dims" ${o.dims ? 'checked' : ''}> Dimensions</label>
        <label>Section <select data-o="section"><option value="none" ${o.section === 'none' ? 'selected' : ''}>None</option><option value="Y" ${o.section === 'Y' ? 'selected' : ''}>A–A (front)</option><option value="X" ${o.section === 'X' ? 'selected' : ''}>B–B (side)</option></select></label>
        ${o.section !== 'none' ? `<label>at <input type="range" min="1" max="99" step="1" value="${o.sectionAt}" data-o="sectionAt" style="width:90px"> <span data-sa>${o.sectionAt}%</span></label>` : ''}
        ${this.data?.holes?.length ? `<label><input type="checkbox" data-o="holes" ${o.holes ? 'checked' : ''}> Hole table</label>` : ''}
        ${this.ids.length > 1 ? `<label><input type="checkbox" data-o="parts" ${o.parts ? 'checked' : ''}> Parts list</label><label><input type="checkbox" data-o="balloons" ${o.balloons ? 'checked' : ''}> Item balloons</label>` : ''}
        <span class="dw-tools seg">${[['select', 'pointer', 'Select'], ['dim', 'measure', 'Dimension'], ['note', 'pencil', 'Note'], ['gdt', 'hash', 'GD&T'], ['datum', 'flip', 'Datum'], ['detail', 'search', 'Detail']].map(([k, ic, l]) => `<button data-tool="${k}" class="${this.tool === k ? 'on' : ''}" data-tip="${l}">${icon(ic)}${l}</button>`).join('')}</span>
        ${this.tool === 'dim' ? `<label>Type <select data-dm>${[['auto', 'Auto'], ['h', 'Horizontal'], ['v', 'Vertical'], ['a', 'Aligned']].map(([v, l]) => `<option value="${v}" ${this.dimMode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}
        <span class="spacer"></span>
        <button class="btn" data-a="svg">${icon('export')}SVG</button>
        <button class="btn" data-a="print">${icon('file')}Print / PDF</button>
        <button class="btn primary" data-a="close">${icon('cube')}Back to model</button>
      </div>
      <div class="dw-hint">${this.hint()}</div>
      <div class="dw-canvas">${this.sheetSVG()}</div>`;
    this.bindSheet();
    this.el.querySelectorAll('[data-tool]').forEach((b) => (b.onclick = () => { this.tool = b.dataset.tool; this.pending = null; this.render(); }));
    this.el.querySelector('[data-dm]')?.addEventListener('change', (e) => { this.dimMode = e.target.value; });
    if (!this._keys) {
      this._keys = (e) => {
        if (!this.isOpen || e.target.closest?.('input, textarea, select')) return;
        if (e.key === 'Escape' && (this.pending || this.tool !== 'select')) { e.stopPropagation(); e.preventDefault(); if (this.pending) this.pending = null; else this.tool = 'select'; this.render(); }
        if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel) { e.preventDefault(); this.app.snapshot(); this.app.doc.dwgAnno = this.annos.filter((a) => a.id !== this.sel); this.sel = null; this.app.scheduleSave(); this.redraw(); }
      };
      document.addEventListener('keydown', this._keys, true);
    }
    this.el.querySelectorAll('[data-o]').forEach((inp) => (inp.onchange = async () => {
      const k = inp.dataset.o;
      o[k] = inp.type === 'checkbox' ? inp.checked : inp.type === 'range' ? +inp.value : inp.value;
      if (k === 'section' || k === 'sectionAt') {
        this.el.querySelector('.dw-canvas').style.opacity = 0.5;
        try { await this.fetch(); } catch (e) { this.app.toast(e.message, 'warn'); }
      }
      this.render();
    }));
    this.el.querySelector('[data-o=sectionAt]')?.addEventListener('input', (e) => { this.el.querySelector('[data-sa]').textContent = `${e.target.value}%`; });
    this.el.querySelector('[data-a=close]').onclick = () => this.close();
    this.el.querySelector('[data-a=svg]').onclick = () => {
      this.app.download(new Blob([this.sheetSVG(true)], { type: 'image/svg+xml' }), `${this.app.doc.name}-drawing.svg`);
    };
    this.el.querySelector('[data-a=print]').onclick = () => this.print();
  }

  // ---------------------------------------------------------------- sheet layout
  sheetSVG(standalone = false) {
    const o = this.opts;
    const [W, H] = SHEETS[o.sheet];
    const U = this.app.units, du = (x) => f1(x / U.scale);
    const views = Object.fromEntries(this.data.views.map((v) => [v.view, v]));
    const size = (v) => (v?.bbox ? [v.bbox[1][0] - v.bbox[0][0], v.bbox[1][1] - v.bbox[0][1]] : [0, 0]);
    const [fw, fh] = size(views.front), [, th] = size(views.top), [rw] = size(views.right);
    const [iw, ih] = size(views.iso);
    const sec = o.section !== 'none' && views.section?.bbox ? views.section : null;
    const [sw] = size(sec);
    const margin = 10, gap = 22, tbH = 34;
    const aw = W - 2 * margin - gap * (sec ? 3 : 2) - 10, ah = H - 2 * margin - tbH - gap * 2;
    const fit = Math.min(aw / (fw + rw + sw || 1), ah / (th + fh || 1));
    const s = o.scale === 'auto' ? SCALES.find((k) => k <= fit) || SCALES[SCALES.length - 1] : +o.scale;
    // third-angle arrangement: top above front, right view to the right of front
    const x0 = margin + gap + 6, y0 = margin + gap;
    const pos = {
      top: [x0, y0],
      front: [x0, y0 + th * s + gap],
      right: [x0 + fw * s + gap, y0 + th * s + gap],
    };
    if (sec) pos.section = [x0 + fw * s + rw * s + gap * 2, y0 + th * s + gap];
    // isometric in the top-right cell, scaled to fit the remaining space
    const isoBox = [x0 + fw * s + gap, y0, W - margin - 8 - (x0 + fw * s + gap), Math.max(th * s + gap * 0.5, 40)];
    const isoScale = Math.min(isoBox[2] / (iw || 1), isoBox[3] / (ih || 1), s);
    if (o.iso && views.iso) pos.iso = [isoBox[0] + (isoBox[2] - iw * isoScale) / 2, isoBox[1] + Math.max(0, (isoBox[3] - ih * isoScale) / 2)];

    // where each view sits on the sheet, for annotations (view coordinates ↔ sheet millimetres)
    this.layout = { W, H, views: {} };
    for (const [name, p] of Object.entries(pos)) {
      const v = views[name];
      if (!v?.bbox || name === 'iso') continue;
      const k = s, [px, py] = p;
      const [w, h] = size(v);
      this.layout.views[name] = {
        k, rect: [px, py, px + w * k, py + h * k],
        toSheet: (x, y) => [px + (x - v.bbox[0][0]) * k, py + (y - v.bbox[0][1]) * k],
        toView: (X, Y) => [(X - px) / k + v.bbox[0][0], (Y - py) / k + v.bbox[0][1]],
      };
    }
    const vw = 0.35, hw = 0.18;
    const viewSVG = (name, label, k = s) => {
      const v = views[name];
      if (!v?.bbox || !pos[name]) return '';
      const [px, py] = pos[name];
      const tx = px - v.bbox[0][0] * k, ty = py - v.bbox[0][1] * k;
      const hidden = o.hidden && name !== 'iso' ? `<g stroke="#666" stroke-width="${hw / k}" stroke-dasharray="${2.2 / k} ${1.2 / k}">${v.hidden.map((d) => `<path d="${d}"/>`).join('')}</g>` : '';
      const [w, h] = size(v);
      // cut faces of a section view, hatched at 45°
      const hatch = name === 'section' && v.loops?.length ? `<pattern id="hatch" patternUnits="userSpaceOnUse" width="${2 / k}" height="${2 / k}" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="${2 / k}" stroke="#111" stroke-width="${0.18 / k}"/></pattern>
          <path fill="url(#hatch)" fill-rule="evenodd" stroke="none" d="${v.loops.map((rings) => rings.map((r) => `M${r.map((p) => `${f1(p[0])} ${f1(p[1])}`).join('L')}Z`).join('')).join('')}"/>` : '';
      return `<g transform="translate(${tx} ${ty}) scale(${k})" fill="none" stroke-linecap="round" stroke-linejoin="round">
          ${hatch}${hidden}<g stroke="#111" stroke-width="${vw / k}">${v.visible.map((d) => `<path d="${d}"/>`).join('')}</g></g>
        <text x="${px + (w * k) / 2}" y="${py + h * k + ((name === 'front' || name === 'right') && o.dims ? 17 : 7)}" class="vlabel">${label}${name === 'iso' ? '' : ` (${scaleLabel(k)})`}</text>`;
    };

    // hole callouts: centre marks and letter tags on the top view, and a hole table
    let holeMarks = '', holeTable = '';
    const holes = o.holes && views.top?.bbox ? this.data.holes || [] : [];
    if (holes.length) {
      const desc = (h) => `Ø${du(h.d)} ${h.through ? 'THRU' : `× ${du(h.depth)} DEEP`}${h.cbore ? ` · CBORE Ø${du(h.cbore.d)} × ${du(h.cbore.depth)}` : ''}${h.csink ? ` · CSINK Ø${du(h.csink.d)} × 90°` : ''}`;
      const groups = [];
      for (const h of holes) { const k = desc(h); let g = groups.find((x) => x.k === k); if (!g) groups.push((g = { k, d: h.d, list: [] })); g.list.push(h); }
      groups.sort((a, b) => a.d - b.d);
      groups.forEach((g, i) => (g.tag = String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '')));
      const [px, py] = pos.top, v = views.top, k = s;
      const X = (x) => px + (x - v.bbox[0][0]) * k, Y = (y) => py + (y - v.bbox[0][1]) * k;
      for (const g of groups) for (const h of g.list) {
        const cx = X(h.x), cy = Y(h.y), r = ((h.cbore?.d || h.csink?.d || h.d) / 2) * k + 1.2;
        holeMarks += `<line x1="${cx - r}" y1="${cy}" x2="${cx + r}" y2="${cy}" stroke-width="0.18" stroke-dasharray="2.4 0.8 0.6 0.8"/><line x1="${cx}" y1="${cy - r}" x2="${cx}" y2="${cy + r}" stroke-width="0.18" stroke-dasharray="2.4 0.8 0.6 0.8"/>
          <circle cx="${cx + r * 0.75 + 2.2}" cy="${cy - r * 0.75 - 2.2}" r="2.1" fill="#fff" stroke-width="0.25"/><text x="${cx + r * 0.75 + 2.2}" y="${cy - r * 0.75 - 1.15}" class="holetag">${g.tag}</text>`;
      }
      const cols = [12, 70, 12], rh = 5.2, tx = margin + 4, top = H - margin - 6 - rh * (groups.length + 1);
      const rowSVG = (cells, y, head) => { let x = tx; return cells.map((c, j) => { const out = `<rect x="${x}" y="${y}" width="${cols[j]}" height="${rh}"/><text x="${x + 1.4}" y="${y + rh - 1.5}" class="${head ? 'tblabel' : 'pltext'}">${esc(c)}</text>`; x += cols[j]; return out; }).join(''); };
      holeTable = `<g fill="none" stroke="#111" stroke-width="0.3">${rowSVG(['TAG', 'HOLE', 'QTY'], top, true)}${groups.map((g, i) => rowSVG([g.tag, g.k, String(g.list.length)], top + rh * (i + 1))).join('')}</g>`;
    }

    // section line with view arrows on the parent view (A–A on the top view, B–B on the front view)
    let cutLine = '';
    if (sec) {
      const L = sec.axis === 'Y' ? 'A' : 'B';
      const parent = sec.axis === 'Y' ? views.top : views.front;
      const [ppx, ppy] = pos[sec.axis === 'Y' ? 'top' : 'front'];
      const [pw, ph] = size(parent);
      const t = sec.at;
      const arrow = (x, y, dx, dy) => `<path d="M${x} ${y} l${dx * 5} ${dy * 5}" stroke-width="0.5"/><path d="M${x + dx * 6.5} ${y + dy * 6.5} l${-dx * 2.2 + dy * 1.2} ${-dy * 2.2 - dx * 1.2} l${-dy * 2.4} ${dx * 2.4} z" fill="#111" stroke="none"/>`;
      if (sec.axis === 'Y') {
        // viewer at −Y looks towards +Y: arrows point up the top view
        const y = ppy + ph * s * (1 - t), xa = ppx - 6, xb = ppx + pw * s + 6;
        cutLine = `<line x1="${xa}" y1="${y}" x2="${xb}" y2="${y}" stroke-width="0.3" stroke-dasharray="6 1.5 1 1.5"/>${arrow(xa, y, 0, -1)}${arrow(xb, y, 0, -1)}
          <text x="${xa - 3}" y="${y - 7}" class="seclabel">${L}</text><text x="${xb + 3}" y="${y - 7}" class="seclabel">${L}</text>`;
      } else {
        // viewer at +X looks towards −X: arrows point left on the front view
        const x = ppx + pw * s * t, ya = ppy - 6, yb = ppy + ph * s + 6;
        cutLine = `<line x1="${x}" y1="${ya}" x2="${x}" y2="${yb}" stroke-width="0.3" stroke-dasharray="6 1.5 1 1.5"/>${arrow(x, ya, -1, 0)}${arrow(x, yb, -1, 0)}
          <text x="${x - 9}" y="${ya - 1}" class="seclabel">${L}</text><text x="${x - 9}" y="${yb + 5}" class="seclabel">${L}</text>`;
      }
    }

    // overall dimensions
    let dims = '';
    if (o.dims && views.front?.bbox) {
      const [fx, fy] = pos.front;
      const dimLine = (x1, y1, x2, y2, text, vertical) => {
        const a = 1.6;
        const arrow = (x, y, dx, dy) => `<path d="M${x} ${y} L${x - dx * a * 1.8 + dy * a * 0.6} ${y - dy * a * 1.8 - dx * a * 0.6} L${x - dx * a * 1.8 - dy * a * 0.6} ${y - dy * a * 1.8 + dx * a * 0.6} Z" fill="#111" stroke="none"/>`;
        const len = Math.hypot(x2 - x1, y2 - y1), dx = (x2 - x1) / len, dy = (y2 - y1) / len;
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>${arrow(x2, y2, dx, dy)}${arrow(x1, y1, -dx, -dy)}
          <text x="${vertical ? mx - 2 : mx}" y="${vertical ? my : my - 1.6}" class="dimtext" ${vertical ? `transform="rotate(-90 ${mx - 2} ${my})"` : ''}>${text}</text>`;
      };
      const ext = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke-width="0.18"/>`;
      const fW = fw * s, fH = fh * s;
      const yb = fy + fH + 8;
      dims += ext(fx, fy + fH + 1.5, fx, yb + 2) + ext(fx + fW, fy + fH + 1.5, fx + fW, yb + 2) + dimLine(fx, yb, fx + fW, yb, du(fw), false);
      const xl = fx - 8;
      dims += ext(fx - 1.5, fy, xl - 2, fy) + ext(fx - 1.5, fy + fH, xl - 2, fy + fH) + dimLine(xl, fy + fH, xl, fy, du(fh), true);
      if (views.right?.bbox) {
        const [rx, ry] = pos.right;
        const rW = rw * s, yr = ry + fH + 8;
        dims += ext(rx, ry + fH + 1.5, rx, yr + 2) + ext(rx + rW, ry + fH + 1.5, rx + rW, yr + 2) + dimLine(rx, yr, rx + rW, yr, du(rw), false);
      }
    }

    // title block
    const app = this.app;
    const meta = this.ids.length === 1 ? app.bodyMeta(this.ids[0]) : null;
    const mat = meta ? MATERIALS[meta.material] || MATERIALS[DEFAULT_MATERIAL] : null;
    const mass = this.data.props && mat ? `${f1((this.data.props.volume / 1000) * mat.density)} g` : '—';
    const bx = W - margin - 180, by = H - margin - tbH;
    const cell = (x, y, w, h, label, value, big) => `<rect x="${x}" y="${y}" width="${w}" height="${h}"/><text x="${x + 1.5}" y="${y + 3.2}" class="tblabel">${label}</text><text x="${x + 1.5}" y="${y + h - 2.2}" class="${big ? 'tbbig' : 'tbval'}">${esc(value)}</text>`;
    const today = new Date().toISOString().slice(0, 10);
    const title = `<g class="tb" fill="none" stroke="#111" stroke-width="0.35">
      ${cell(bx, by, 110, 17, 'TITLE', app.doc.name, true)}
      ${cell(bx + 110, by, 70, 17, 'MATERIAL', mat ? mat.name : this.ids.length > 1 ? `${this.ids.length} bodies` : '—')}
      ${cell(bx, by + 17, 36, 17, 'SCALE', scaleLabel(s))}
      ${cell(bx + 36, by + 17, 26, 17, 'SHEET', o.sheet)}
      ${cell(bx + 62, by + 17, 30, 17, 'UNITS', U.label)}
      ${cell(bx + 92, by + 17, 34, 17, 'MASS', mass)}
      ${cell(bx + 126, by + 17, 54, 17, 'DATE', today)}
      ${thirdAngleSymbol(bx - 22, by + 9)}
    </g>`;
    // parts list above the title block for multi-body drawings
    // identical components are one item with a quantity (the same grouping as the bill of materials)
    const items = [];
    for (const id of this.ids) {
      const info = app.partInfo(id), it = items.find((x) => x.key === info.key);
      if (it) it.ids.push(id); else items.push({ ...info, ids: [id] });
    }
    let parts = '', balloons = '';
    if (o.parts && this.ids.length > 1) {
      const rows = items.slice(0, 14).map((it, i) => {
        const m = app.bodyMeta(it.ids[0]), mt = MATERIALS[m.material] || MATERIALS[DEFAULT_MATERIAL];
        const vol = this.data.parts?.find((p) => p.id === it.ids[0])?.volume || 0;
        return [String(i + 1), it.name, mt.name, String(it.ids.length), `${f1((vol / 1000) * mt.density)} g`];
      });
      const cols = [10, 62, 60, 14, 34], rh = 5.2, top = by - 4 - rh * (rows.length + 1);
      const rowSVG = (cells, y, head) => {
        let x = bx;
        return cells.map((c, j) => { const out = `<rect x="${x}" y="${y}" width="${cols[j]}" height="${rh}"/><text x="${x + 1.4}" y="${y + rh - 1.5}" class="${head ? 'tblabel' : 'pltext'}">${esc(String(c).slice(0, j === 1 || j === 2 ? 30 : 12))}</text>`; x += cols[j]; return out; }).join('');
      };
      parts = `<g fill="none" stroke="#111" stroke-width="0.3">${rowSVG(['ITEM', 'PART', 'MATERIAL', 'QTY', 'MASS'], top, true)}${rows.map((r, i) => rowSVG(r, top + rh * (i + 1))).join('')}</g>`;
    }
    // item balloons on the front view: a row above the view (dimensions sit below and to the left), with a
    // leader to a dot on each part
    const fv = views.front, FV = this.layout.views.front;
    if (o.parts && o.balloons && this.ids.length > 1 && fv?.proj && FV) {
      const P = fv.proj, at = (q) => FV.toSheet(q[0] * P.x[0] + q[1] * P.x[1] + q[2] * P.x[2] + P.ox, -(q[0] * P.up[0] + q[1] * P.up[1] + q[2] * P.up[2]) + P.oy);
      const [rx0, ry0, rx1] = FV.rect, R = 3.4, rowY = ry0 - 8;
      const list = items.slice(0, 14).map((it, i) => ({ n: i + 1, part: this.data.parts?.find((p) => p.id === it.ids[0]) })).filter((x) => x.part?.center).map((x) => ({ ...x, A: at(x.part.center) }));
      // parts centred on each other would share a leader: move the dot across the part to where it is clear
      const used = [];
      for (const it of list) {
        const bb = it.part.bbox, xs = bb ? [0, 1].flatMap((i) => [0, 1].flatMap((j) => [0, 1].map((k) => at([bb[i][0], bb[j][1], bb[k][2]])[0]))) : [it.A[0]];
        const lo = Math.min(...xs), hi = Math.max(...xs), clear = (x) => Math.min(Infinity, ...used.map((u) => Math.abs(u - x)));
        if (clear(it.A[0]) < 2 * R + 2) {
          const cands = [0.5, 0.35, 0.65, 0.2, 0.8].map((t) => lo + (hi - lo) * t);
          it.A = [cands.reduce((b, c) => (clear(c) > clear(b) + 1e-6 ? c : b)), it.A[1]];
        }
        used.push(it.A[0]);
      }
      list.sort((u, v) => u.A[0] - v.A[0]);
      // spread along the row so balloons never overlap, staying within the view's width where possible
      let x = -Infinity;
      for (const it of list) { it.bx = Math.max(it.A[0], x + 2 * R + 2); x = it.bx; }
      const over = x - Math.max(rx1, list[0]?.A[0] || rx1);
      if (over > 0) for (const it of list) it.bx -= Math.min(over, Math.max(0, list[0].bx - rx0 + 2 * R));
      for (const it of list) {
        const B = [it.bx, rowY], d = Math.hypot(B[0] - it.A[0], B[1] - it.A[1]) || 1, E = [B[0] - ((B[0] - it.A[0]) / d) * R, B[1] - ((B[1] - it.A[1]) / d) * R];
        balloons += `<circle cx="${f1(it.A[0])}" cy="${f1(it.A[1])}" r="0.6" fill="#111"/><path d="M${f1(it.A[0])} ${f1(it.A[1])}L${f1(E[0])} ${f1(E[1])}"/><circle cx="${f1(B[0])}" cy="${f1(B[1])}" r="${R}" fill="#fff"/><text x="${f1(B[0])}" y="${f1(B[1] + 1.25)}" class="balloon">${it.n}</text>`;
      }
      balloons = `<g stroke="#111" stroke-width="0.25" fill="none">${balloons}</g>`;
    }

    const body = `
      <rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>
      <rect x="${margin}" y="${margin}" width="${W - 2 * margin}" height="${H - 2 * margin}" fill="none" stroke="#111" stroke-width="0.5"/>
      ${viewSVG('top', 'TOP')}${viewSVG('front', 'FRONT')}${viewSVG('right', 'RIGHT')}${o.iso ? viewSVG('iso', 'ISOMETRIC', isoScale) : ''}
      ${sec ? viewSVG('section', `SECTION ${sec.axis === 'Y' ? 'A–A' : 'B–B'}`) : ''}
      <g stroke="#111" fill="none">${cutLine}</g>
      <g stroke="#111" fill="none">${holeMarks}</g>${holeTable}
      <g stroke="#111" stroke-width="0.25" fill="none">${dims}</g>
      ${parts}${balloons}${title}
      <g class="anno">${annotationsSVG(this.annos, { views: this.layout.views, du, detail: (it) => this.detailSVG(it) }, standalone ? null : this.sel)}</g>
      ${standalone ? '' : '<g id="an-preview" pointer-events="none"></g>'}
      <text x="${margin + 2}" y="${H - margin - 2}" class="tblabel">Generated by Ruffle3D · third-angle projection · dimensions in ${U.label}</text>`;
    const style = `<style>
      .balloon{font:600 3.6px 'Segoe UI',Arial,sans-serif;fill:#111;stroke:none;text-anchor:middle}
      .vlabel{font:600 3.2px 'Segoe UI',Arial,sans-serif;fill:#333;text-anchor:middle;letter-spacing:.3px}
      .dimtext{font:3.2px 'Segoe UI',Arial,sans-serif;fill:#111;stroke:none;text-anchor:middle}
      .tblabel{font:2.2px 'Segoe UI',Arial,sans-serif;fill:#555;stroke:none}
      .tbval{font:3.6px 'Segoe UI',Arial,sans-serif;fill:#111;stroke:none}
      .tbbig{font:600 5px 'Segoe UI',Arial,sans-serif;fill:#111;stroke:none}
      .pltext{font:2.8px 'Segoe UI',Arial,sans-serif;fill:#111;stroke:none}
      .holetag{font:700 2.6px 'Segoe UI',Arial,sans-serif;fill:#111;stroke:none;text-anchor:middle}
      .seclabel{font:700 5px 'Segoe UI',Arial,sans-serif;fill:#111;stroke:none;text-anchor:middle}
      ${ANNOTATION_CSS}
      .snapmark{fill:none;stroke:#2f6bff;stroke-width:.35}
    </style>`;
    const attrs = standalone ? `width="${W}mm" height="${H}mm"` : 'class="dw-sheet"';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" ${attrs}>${style}${body}</svg>`;
  }

  // ---------------------------------------------------------------- annotation tools
  hint() {
    const p = this.pending;
    return {
      select: 'Click a dimension or note to select it, drag to move it, double-click to edit, Delete to remove.',
      dim: !p ? 'Click a point, a circle or an edge line. Two points give a length, a circle its diameter (an arc its radius), two lines an angle.' : p.stage === 'place' ? 'Click to place the dimension.' : p.kind === 'line' ? 'Click the second line for an angle.' : 'Click the second point.',
      note: !p ? 'Click where the leader arrow should point (or where the note goes).' : 'Click where the text goes (click the same spot again for a note without a leader).',
      gdt: !p ? 'Click the feature the frame refers to.' : 'Click where the feature control frame goes.',
      datum: !p ? 'Click the surface edge for the datum triangle.' : 'Click where the datum letter goes.',
      detail: !p ? 'Click the centre of the area to enlarge, in any view except the isometric.' : p.stage === 'place' ? 'Click where the enlarged detail view goes. Double-click it later to change its scale.' : 'Click to set the size of the circle.',
    }[this.tool];
  }

  redraw() {
    const c = this.el.querySelector('.dw-canvas');
    if (!c) return this.render();
    c.innerHTML = this.sheetSVG();
    this.el.querySelector('.dw-hint').textContent = this.hint();
    this.bindSheet();
  }

  bindSheet() {
    const svg = this.el.querySelector('svg.dw-sheet');
    if (!svg) return;
    svg.classList.toggle('placing', this.tool !== 'select');
    const toSheet = (e) => { const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY; const q = pt.matrixTransform(svg.getScreenCTM().inverse()); return [q.x, q.y]; };
    const preview = svg.querySelector('#an-preview');
    let drag = null;
    svg.onpointerdown = (e) => {
      if (this.tool !== 'select') return;
      const g = e.target.closest('[data-an]');
      this.sel = g ? g.dataset.an : null;
      if (g) {
        const it = this.annos.find((a) => a.id === this.sel);
        drag = { it, start: toSheet(e), at0: it.at.slice(), moved: false };
        svg.setPointerCapture(e.pointerId);
      }
      this.redraw();
    };
    svg.onpointermove = (e) => {
      const P = toSheet(e);
      if (drag) {
        const d = [P[0] - drag.start[0], P[1] - drag.start[1]];
        if (!drag.moved && Math.hypot(...d) < 0.6) return;
        if (!drag.moved) { this.app.snapshot(); drag.moved = true; }
        const V = drag.it.view && this.layout.views[drag.it.view];
        drag.it.at = V ? [drag.at0[0] + d[0] / V.k, drag.at0[1] + d[1] / V.k] : [drag.at0[0] + d[0], drag.at0[1] + d[1]];
        const grp = svg.querySelector('g.anno');
        if (grp) grp.innerHTML = annotationsSVG(this.annos, { views: this.layout.views, du: (x) => this.du(x), detail: (it) => this.detailSVG(it) }, this.sel);
        return;
      }
      if (this.tool === 'select' || !preview) return;
      preview.innerHTML = this.previewSVG(P);
    };
    svg.onpointerup = () => { if (drag?.moved) this.app.scheduleSave(); drag = null; };
    svg.onclick = (e) => { if (this.tool !== 'select') this.placeClick(toSheet(e)); };
    svg.ondblclick = (e) => { const g = e.target.closest('[data-an]'); if (g && this.tool === 'select') this.editAnno(g.dataset.an); };
  }

  du(x) { return (Math.round((x / this.app.units.scale) * 100) / 100).toString(); }

  viewAt(P, pad = 4) {
    for (const [name, V] of Object.entries(this.layout.views)) {
      const [x0, y0, x1, y1] = V.rect;
      if (P[0] >= x0 - pad && P[0] <= x1 + pad && P[1] >= y0 - pad && P[1] <= y1 + pad) return name;
    }
    return null;
  }

  // Detail view: the parent view's lines inside a circle, enlarged and placed elsewhere on the sheet,
  // plus the labelled circle on the parent view. it = { t: 'detail', src, c (view), r (view), scale, at (sheet), label }
  detailSVG(it) {
    const V = this.layout.views[it.src], v = this.data.views.find((x) => x.view === it.src);
    if (!V || !v) return '';
    const kD = V.k * it.scale, C = V.toSheet(it.c[0], it.c[1]), rS = it.r * V.k, rD = it.r * kD, id = `dclip-${it.id}`;
    const tl = [C[0] + rS * 0.72 + 1, C[1] - rS * 0.72 - 1];
    const lines = (list) => list.map((d) => `<path d="${d}"/>`).join('');
    return `<circle cx="${C[0]}" cy="${C[1]}" r="${rS}" class="an-thin" fill="none" stroke-dasharray="3 1 0.6 1"/>
      <text x="${tl[0]}" y="${tl[1]}" class="an-text" style="font-weight:600">${esc(it.label)}</text>
      <defs><clipPath id="${id}" clipPathUnits="userSpaceOnUse"><circle cx="${it.c[0]}" cy="${it.c[1]}" r="${it.r}"/></clipPath></defs>
      <circle cx="${it.at[0]}" cy="${it.at[1]}" r="${rD}" fill="#fff" stroke="none"/>
      <g transform="translate(${it.at[0]} ${it.at[1]}) scale(${kD}) translate(${-it.c[0]} ${-it.c[1]})" fill="none" stroke-linecap="round" stroke-linejoin="round" clip-path="url(#${id})">
        ${this.opts.hidden ? `<g stroke="#666" stroke-width="${0.18 / kD}" stroke-dasharray="${2.2 / kD} ${1.2 / kD}">${lines(v.hidden || [])}</g>` : ''}
        <g stroke="#111" stroke-width="${0.35 / kD}">${lines(v.visible || [])}</g>
      </g>
      <circle cx="${it.at[0]}" cy="${it.at[1]}" r="${rD}" class="an-line" fill="none"/>
      <text x="${it.at[0]}" y="${it.at[1] + rD + 6}" class="vlabel">DETAIL ${esc(it.label)} (${scaleLabel(+kD.toPrecision(3))})</text>`;
  }

  // nearest snap point (view coordinates) within 2.5 mm on the sheet
  snapAt(P, viewName) {
    const V = this.layout.views[viewName], S = this.snaps[viewName];
    if (!V || !S) return null;
    let best = null, bd = 2.5;
    for (const q of S.pts) { const s = V.toSheet(q[0], q[1]); const d = Math.hypot(s[0] - P[0], s[1] - P[1]); if (d < bd) { bd = d; best = q; } }
    return best;
  }
  circleAt(P, viewName) {
    const V = this.layout.views[viewName], S = this.snaps[viewName];
    if (!V || !S) return null;
    const q = V.toView(P[0], P[1]);
    let best = null, bd = 1.5;
    for (const c of S.circles) { const d = Math.abs(Math.hypot(q[0] - c.c[0], q[1] - c.c[1]) - c.r) * V.k; if (d < bd) { bd = d; best = c; } }
    return best;
  }
  lineAt(P, viewName) {
    const V = this.layout.views[viewName], S = this.snaps[viewName];
    if (!V || !S) return null;
    let best = null, bd = 1.5;
    for (const [a, b] of S.lines) {
      const A = V.toSheet(a[0], a[1]), B = V.toSheet(b[0], b[1]);
      const dx = B[0] - A[0], dy = B[1] - A[1], l2 = dx * dx + dy * dy;
      if (l2 < 1e-9) continue;
      const t = Math.max(0, Math.min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / l2));
      const d = Math.hypot(A[0] + t * dx - P[0], A[1] + t * dy - P[1]);
      if (d < bd) { bd = d; best = [a, b]; }
    }
    return best;
  }

  // the dimension that the pending clicks plus a placement point P (sheet) describe
  pendingItem(P) {
    const p = this.pending;
    if (!p) return null;
    const V = p.view && this.layout.views[p.view];
    if (this.tool === 'dim' && p.stage === 'place' && V) {
      const at = V.toView(P[0], P[1]);
      if (p.kind === 'circle') return { id: '_p', t: p.circle.full ? 'dia' : 'rad', view: p.view, c: p.circle.c, r: p.circle.r, at };
      if (p.kind === 'angle') return { id: '_p', t: 'ang', view: p.view, o: p.o, a: p.a, b: p.b, at };
      let dir = this.dimMode;
      if (dir === 'auto') {
        // like most CAD: place above or below for a horizontal dimension, left or right for a vertical one
        const A = V.toSheet(...p.a), B = V.toSheet(...p.b);
        const inX = P[0] > Math.min(A[0], B[0]) && P[0] < Math.max(A[0], B[0]), inY = P[1] > Math.min(A[1], B[1]) && P[1] < Math.max(A[1], B[1]);
        dir = inX && !inY ? 'h' : inY && !inX ? 'v' : Math.abs(B[0] - A[0]) >= Math.abs(B[1] - A[1]) ? 'h' : 'v';
        if (Math.abs(B[0] - A[0]) > 0.5 && Math.abs(B[1] - A[1]) > 0.5 && inX && inY) dir = 'a';
      }
      return { id: '_p', t: 'lin', view: p.view, a: p.a, b: p.b, at, dir };
    }
    return null;
  }

  previewSVG(P) {
    const L = { views: this.layout.views, du: (x) => this.du(x), detail: (it) => this.detailSVG(it) };
    let out = '';
    if (this.tool === 'detail') {
      const p = this.pending, V = p && this.layout.views[p.view];
      if (p && V && p.stage !== 'place') { const C = V.toSheet(...p.c); out += `<circle cx="${C[0]}" cy="${C[1]}" r="${Math.hypot(P[0] - C[0], P[1] - C[1])}" class="snapmark" fill="none"/>`; }
      if (p?.stage === 'place') out += this.detailSVG({ id: '_p', t: 'detail', src: p.view, c: p.c, r: p.r, scale: p.scale, at: P, label: p.label });
      return out;
    }
    if (this.tool === 'dim') {
      const vn = this.pending?.view || this.viewAt(P);
      const s = vn && this.snapAt(P, vn);
      if (s && this.pending?.stage !== 'place') { const S = this.layout.views[vn].toSheet(...s); out += `<circle cx="${S[0]}" cy="${S[1]}" r="1.2" class="snapmark"/>`; }
      else if (vn && !this.pending) {
        const c = this.circleAt(P, vn);
        if (c) { const V = this.layout.views[vn], S = V.toSheet(...c.c); out += `<circle cx="${S[0]}" cy="${S[1]}" r="${c.r * V.k}" class="snapmark"/>`; }
      }
      const it = this.pendingItem(P);
      if (it) out += annotationsSVG([it], L, '_p');
    } else if (this.pending) out += `<line x1="${this.pending.tip[0]}" y1="${this.pending.tip[1]}" x2="${P[0]}" y2="${P[1]}" class="an-line" stroke="#2f6bff"/>`;
    return out;
  }

  placeClick(P) {
    const app = this.app, p = this.pending;
    const add = (it) => { app.snapshot(); if (it.view) it.vb = this.data.views.find((v) => v.view === it.view)?.bbox; this.annos.push({ id: `an${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, ...it }); this.sel = this.annos[this.annos.length - 1].id; app.scheduleSave(); };
    if (this.tool === 'detail') {
      if (p?.stage === 'place') { add({ t: 'detail', src: p.view, c: p.c, r: p.r, scale: p.scale, at: P, label: p.label }); this.pending = null; this.tool = 'select'; return this.render(); }
      const vn = p?.view || this.viewAt(P);
      if (!vn) return app.toast('Click inside a view (not the isometric view)', 'warn');
      const V = this.layout.views[vn], q = V.toView(P[0], P[1]);
      if (!p) { this.pending = { view: vn, c: q, stage: 'size' }; return this.redraw(); }
      const r = Math.max(Math.hypot(q[0] - p.c[0], q[1] - p.c[1]), 1 / V.k);
      // enlarge so the detail circle is about 60 mm across on the sheet, at a standard multiple
      const want = 30 / (r * V.k);
      const scale = [1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 15, 20].reduce((b, m) => (Math.abs(Math.log(m / want)) < Math.abs(Math.log(b / want)) ? m : b), 2);
      const used = new Set(this.annos.filter((a) => a.t === 'detail').map((a) => a.label));
      const label = 'CDEFGHJKLMNPQRSTUVWXYZ'.split('').find((ch) => !used.has(ch)) || 'Z';
      this.pending = { ...p, r, scale, label, stage: 'place' };
      return this.redraw();
    }
    if (this.tool === 'dim') {
      if (p?.stage === 'place') { const it = this.pendingItem(P); delete it.id; add(it); this.pending = null; return this.redraw(); }
      const vn = p?.view || this.viewAt(P);
      if (!vn) return app.toast('Click inside a view (not the isometric view)', 'warn');
      const s = this.snapAt(P, vn);
      if (!p) {
        if (s) this.pending = { view: vn, kind: 'points', a: s };
        else { const c = this.circleAt(P, vn); const ln = !c && this.lineAt(P, vn); if (c) this.pending = { view: vn, kind: 'circle', circle: c, stage: 'place' }; else if (ln) this.pending = { view: vn, kind: 'line', l1: ln }; else return; }
      } else if (p.kind === 'points') {
        if (!s) return;
        if (Math.hypot(s[0] - p.a[0], s[1] - p.a[1]) < 1e-6) return;
        this.pending = { ...p, b: s, stage: 'place' };
      } else if (p.kind === 'line') {
        const l2 = this.lineAt(P, vn);
        if (!l2) return;
        const [a1, b1] = p.l1, [a2, b2] = l2;
        const d1 = [b1[0] - a1[0], b1[1] - a1[1]], d2 = [b2[0] - a2[0], b2[1] - a2[1]], den = d1[0] * d2[1] - d1[1] * d2[0];
        if (Math.abs(den) < 1e-9) return app.toast('Those lines are parallel; pick two lines that meet at an angle', 'warn');
        const t = ((a2[0] - a1[0]) * d2[1] - (a2[1] - a1[1]) * d2[0]) / den, o = [a1[0] + d1[0] * t, a1[1] + d1[1] * t];
        const far = (a, b) => (Math.hypot(a[0] - o[0], a[1] - o[1]) > Math.hypot(b[0] - o[0], b[1] - o[1]) ? a : b);
        this.pending = { view: vn, kind: 'angle', o, a: far(a1, b1), b: far(a2, b2), stage: 'place' };
      }
      return this.redraw();
    }
    // note, GD&T and datum: first click = leader tip, second = position
    if (!p?.tip) { this.pending = { tip: P }; return this.redraw(); }
    const leader = Math.hypot(P[0] - p.tip[0], P[1] - p.tip[1]) > 2 ? p.tip : null;
    this.pending = null;
    if (this.tool === 'note') {
      this.textDialog('Note', '', (text) => { if (text) add({ t: 'note', at: P, leader, text }); this.redraw(); }, true);
    } else if (this.tool === 'gdt') {
      this.gdtDialog({ sym: 'flatness', tol: '0.05', datums: '' }, (v) => { add({ t: 'gdt', at: P, leader, ...v }); this.redraw(); });
    } else if (this.tool === 'datum') {
      const used = this.annos.filter((a) => a.t === 'datum').map((a) => a.text);
      const next = 'ABCDEFGHJKLMNPRSTUVWXYZ'.split('').find((c) => !used.includes(c)) || 'A';
      this.textDialog('Datum letter', next, (text) => { if (text) add({ t: 'datum', at: P, leader: leader || [P[0], P[1] + 8], text: text.toUpperCase().slice(0, 2) }); this.redraw(); });
    }
    this.redraw();
  }

  textDialog(title, value, cb, multiline = false) {
    const m = this.app.modal(title, multiline ? `<textarea class="input" rows="4" style="width:100%;font:inherit;padding:8px">${esc(value)}</textarea>` : `<input class="input" value="${esc(value)}" style="height:36px;width:100%">`, { ic: 'pencil', onOk: (el) => cb(el.querySelector('input, textarea').value.trim()) });
    setTimeout(() => m.querySelector('input, textarea')?.focus(), 30);
  }

  gdtDialog(v, cb) {
    const m = this.app.modal('Feature control frame', `
      <div class="field"><label>Characteristic</label><select class="input" data-s>${GDT.map(([k, sym, name]) => `<option value="${k}" ${v.sym === k ? 'selected' : ''}>${sym}  ${name}</option>`).join('')}</select></div>
      <div class="field"><label>Tolerance</label><input class="input" data-t value="${esc(v.tol)}" placeholder="0.05 or Ø0.1 Ⓜ"></div>
      <div class="field"><label>Datums</label><input class="input" data-d value="${esc(v.datums)}" placeholder="A B C"></div>`, { ic: 'hash', onOk: (el) => cb({ sym: el.querySelector('[data-s]').value, tol: el.querySelector('[data-t]').value.trim(), datums: el.querySelector('[data-d]').value.trim() }) });
    void m;
  }

  editAnno(id) {
    const it = this.annos.find((a) => a.id === id);
    if (!it) return;
    const done = () => { this.app.scheduleSave(); this.redraw(); };
    if (it.t === 'note') return this.textDialog('Note', it.text, (t) => { if (t) { this.app.snapshot(); it.text = t; } done(); }, true);
    if (it.t === 'datum') return this.textDialog('Datum letter', it.text, (t) => { if (t) { this.app.snapshot(); it.text = t.toUpperCase().slice(0, 2); } done(); });
    if (it.t === 'gdt') return this.gdtDialog(it, (v) => { this.app.snapshot(); Object.assign(it, v); done(); });
    if (it.t === 'detail') {
      const base = this.layout.views[it.src]?.k || 1;
      const opts = [1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 15, 20].map((m) => `<option value="${m}" ${m === it.scale ? 'selected' : ''}>${m} × the view (${scaleLabel(+(base * m).toPrecision(3))})</option>`).join('');
      return this.app.modal('Detail view', `
        <div class="field"><label>Letter</label><input class="input" data-l value="${esc(it.label)}" maxlength="2"></div>
        <div class="field"><label>Enlargement</label><select class="input" data-s>${opts}</select></div>
        <div class="field"><label>Circle radius</label><div class="num"><input class="input" data-r type="number" step="0.5" min="0.5" value="${+it.r.toFixed(2)}"><span class="unit">mm</span></div></div>`,
        { ic: 'search', onOk: (el) => { this.app.snapshot(); it.label = (el.querySelector('[data-l]').value.trim() || it.label).toUpperCase().slice(0, 2); it.scale = +el.querySelector('[data-s]').value; it.r = Math.max(0.5, +el.querySelector('[data-r]').value || it.r); done(); } });
    }
    // dimensions: override text and tolerance
    this.app.modal('Dimension', `
      <div class="field"><label>Text</label><input class="input" data-x value="${esc(it.text || '')}" placeholder="Measured value"></div>
      <div class="field"><label>Tolerance</label><input class="input" data-t value="${esc(it.tol || '')}" placeholder="±0.1 or +0.05/-0"></div>
      <div class="help">Leave the text empty to show the measured value. Common: ±0.1 general, +0.02/-0 for a press fit, H7 or g6 for fits.</div>`,
      { ic: 'measure', onOk: (el) => { this.app.snapshot(); it.text = el.querySelector('[data-x]').value.trim(); it.tol = el.querySelector('[data-t]').value.trim().replace(/^\+-/, '±'); done(); } });
  }

  print() {
    const [W, H] = SHEETS[this.opts.sheet];
    const w = window.open('', '_blank');
    if (!w) return this.app.toast('Allow pop-ups to print the drawing');
    w.document.write(`<!doctype html><html><head><title>${esc(this.app.doc.name)} drawing</title>
      <style>@page{size:${W}mm ${H}mm;margin:0}html,body{margin:0}svg{width:${W}mm;height:${H}mm;display:block}</style></head>
      <body>${this.sheetSVG(true)}<script>setTimeout(()=>print(),300)<\/script></body></html>`);
    w.document.close();
  }
}

function thirdAngleSymbol(x, y) {
  // truncated cone symbol for third-angle projection
  return `<g stroke-width="0.3">
    <circle cx="${x + 15}" cy="${y}" r="4"/><circle cx="${x + 15}" cy="${y}" r="2"/>
    <path d="M${x} ${y - 4} L${x + 8} ${y - 2} L${x + 8} ${y + 2} L${x} ${y + 4} Z"/>
    <line x1="${x - 2}" y1="${y}" x2="${x + 21}" y2="${y}" stroke-dasharray="1.2 0.6" stroke-width="0.15"/></g>`;
}
