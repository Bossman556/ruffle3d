// Sketch mode: parametric 2D sketching with a geometric constraint solver.
import * as THREE from 'three';
import { toWorld } from './geom2d.js';
import { COLORS } from './viewport.js';
import { evaluate, evaluateLen } from './expr.js';
import { icon } from './icons.js';
import {
  uid, emptySketch, migrateSketch, pointPos, getCurve, curveGeom, sketchGeom, sampleGeom,
  distToGeom, closestOnGeom, intersect, normAng, VIRTUAL_LINES, curvePointIds, ellipseLocal, ellipsePoint,
} from './sketch/model.js';
import { solveSketch } from './sketch/solver.js';
import { splineSamples, fitPointLengths, splineCrossings, trimSplinePieces, splineSide, offsetSplinePoints } from './sketch/splineops.js';
import { computeRegions } from './sketch/regions.js';

const TAU = Math.PI * 2;
const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add2 = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul2 = (a, k) => [a[0] * k, a[1] * k];
const unit2 = (a) => { const l = Math.hypot(a[0], a[1]) || 1; return [a[0] / l, a[1] / l]; };
const fmt = (x) => (Math.round(x * 1000) / 1000).toString();

const CREATE_TOOLS = [
  ['line', 'Line', 'line', 'L'], ['rect', 'Rectangle', 'rect', 'R'], ['crect', 'Center Rect', 'crect', ''],
  ['circle', 'Circle', 'circle', 'C'], ['circle3', '3-Point Circle', 'circle3', ''], ['arc3', '3-Point Arc', 'arc', 'A'], ['arcc', 'Center Arc', 'arcc', ''], ['ellipse', 'Ellipse', 'ellipse', 'E'],
  ['polygon', 'Polygon', 'polygon', 'P'], ['slot', 'Slot', 'slot', ''], ['spline', 'Spline', 'spline', ''], ['point', 'Point', 'point', ''],
];
const MODIFY_TOOLS = [
  ['dim', 'Dimension', 'dim', 'D'], ['fillet', 'Fillet', 'sfillet', 'F'], ['trim', 'Trim', 'trim', 'T'], ['offset', 'Offset', 'offset', 'O'],
  ['mirror', 'Mirror', 'mirror', ''], ['lpattern', 'Linear Pattern', 'rpattern', ''], ['cpattern', 'Circular Pattern', 'cpattern', ''], ['project', 'Project', 'project', ''],
];
// constraint tools: [type, label, glyph, needs]
const CONSTRAINTS = [
  ['coincident', 'Coincident', '⦿'], ['horizontal', 'Horizontal', 'H'], ['vertical', 'Vertical', 'V'], ['parallel', 'Parallel', '∥'],
  ['perpendicular', 'Perpendicular', '⊥'], ['tangent', 'Tangent', 'T'], ['equal', 'Equal', '='], ['midpoint', 'Midpoint', 'M'],
  ['concentric', 'Concentric', '◎'], ['collinear', 'Collinear', '⋯'], ['symmetric', 'Symmetric', '⋈'], ['fix', 'Fix / Unfix', '🔒'],
];
const GLYPH = Object.fromEntries(CONSTRAINTS.map(([t, , g]) => [t, g]));
GLYPH.pointOnCurve = '⦾';

// Dimension inputs while drawing
const DIMS = {
  line: [['L', 'Length'], ['A', 'Angle']], rect: [['W', 'Width'], ['H', 'Height']], crect: [['W', 'Width'], ['H', 'Height']],
  circle: [['D', 'Diameter']], polygon: [['R', 'Radius'], ['N', 'Sides']], slot: [['L', 'Length'], ['W', 'Width']],
  fillet: [['R', 'Radius']], offset: [['D', 'Distance']], arcc: [['R', 'Radius']], ellipse: [['A', 'Major axis'], ['B', 'Minor axis']],
  lpattern: [['N', 'Count'], ['D', 'Spacing'], ['A', 'Angle']], cpattern: [['N', 'Count'], ['T', 'Total angle']],
};
const PATTERN_TOOLS = new Set(['lpattern', 'cpattern']);
// the minor radius that puts point p on an ellipse with centre c and major axis end a
function ellipseMinorThrough(c, a, p) {
  const rx = d2(c, a) || 1e-9, [x, y] = ellipseLocal({ c, rot: Math.atan2(a[1] - c[1], a[0] - c[0]) }, p);
  const k = 1 - (x / rx) ** 2;
  return Math.max(1e-3, k > 0.01 ? Math.abs(y) / Math.sqrt(k) : Math.abs(y));
}

export class Sketcher {
  constructor(vp, ui) {
    this.vp = vp;
    this.ui = ui; // { palette, hud, vars, toast, pickEdge }
    this.active = false;
    this.labelRoot = document.createElement('div');
    this.labelRoot.className = 'sk-labels';
    vp.el.appendChild(this.labelRoot);
    vp.on('render', () => this.active && this._placeLabels());
  }

  // ======================================================================== lifecycle
  begin({ plane, data, name, onFinish, onCancel }) {
    this.active = true;
    this.plane = plane;
    this.name = name;
    const sk = migrateSketch(structuredClone(data || emptySketch()));
    this.sk = { points: sk.points || [], curves: sk.curves || [], constraints: sk.constraints || [], dims: sk.dims || [] };
    this.onFinish = onFinish;
    this.onCancel = onCancel;
    this.tool = this.sk.curves.length ? 'select' : 'line';
    this.chain = null; // in-progress drawing state
    this.picks = [];
    this.sel = new Set();
    this.hover = null;
    this.construction = false;
    this.showConstraints = true;
    this.undoStack = [];
    this.redoStack = [];
    this.polySides = 6;
    this.filletR = 2;
    this.offsetD = 2;
    const x = new THREE.Vector3(...plane.xDir), n = new THREE.Vector3(...plane.normal);
    this.basis = { x, y: new THREE.Vector3().crossVectors(n, x), n, o: new THREE.Vector3(...plane.origin) };
    this.vp.grid.visible = false;
    this._buildStatic();
    this.solve();
    this._renderUI();
    this.vp.setView(plane.normal);
  }

  end(commit) {
    if (!this.active) return;
    this.active = false;
    this.vp.sketchLayer.clear();
    this.vp.grid.visible = true;
    this.labelRoot.innerHTML = '';
    this._hideHud();
    this.ui.onExit?.();
    this.vp.requestRender();
    commit ? this.onFinish?.(this._clean(this.sk)) : this.onCancel?.();
  }

  _clean(sk) {
    // persist dims without their evaluated values (the app re-evaluates them with parameters)
    return { points: sk.points, curves: sk.curves, constraints: sk.constraints, dims: sk.dims.map(({ value, ...d }) => d) };
  }

  // ======================================================================== solving
  _withValues(sk) {
    const vars = this.ui.vars();
    const sc = this.ui.units?.().scale || 1;
    return { ...sk, dims: sk.dims.map((d) => { let value; try { value = d.type === 'angle' ? evaluate(d.expr, vars) : evaluateLen(d.expr, vars, sc); } catch { value = NaN; } return { ...d, value }; }) };
  }

  solve(drag = null, analyze = true) {
    const r = solveSketch(this._withValues(this.sk), { drag });
    this.sk = { ...this.sk, points: r.sketch.points, curves: r.sketch.curves };
    this.failed = new Set(r.failed);
    if (analyze) this.status = r.analyze();
    this.geomVersion = (this.geomVersion || 0) + 1;
    this.redraw();
    return r;
  }

  snapshot() {
    this.undoStack.push(JSON.stringify(this.sk));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }
  undo() {
    if (this.chain) { this.chain = null; this.redraw(); return; }
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(JSON.stringify(this.sk));
    this.sk = JSON.parse(s);
    this.sel.clear();
    this.solve();
    this._renderUI();
  }
  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(JSON.stringify(this.sk));
    this.sk = JSON.parse(s);
    this.solve();
    this._renderUI();
  }

  // Applies a modification; if it makes the sketch unsolvable it is reverted.
  commitChange(fn, { label = 'change', strict = false } = {}) {
    const before = JSON.stringify(this.sk);
    this.snapshot();
    fn(this.sk);
    this._prune();
    const r = this.solve();
    if (strict && !r.ok) {
      this.sk = JSON.parse(before);
      this.undoStack.pop();
      this.solve();
      this.ui.toast(`Can't add ${label}: it conflicts with existing constraints or dimensions`);
      return false;
    }
    this._renderUI();
    return true;
  }

  _prune() {
    const sk = this.sk;
    const pts = new Set(sk.points.map((p) => p.id));
    const exists = (id) => pts.has(id) || id === 'O' || id === 'OX' || id === 'OY';
    sk.curves = sk.curves.filter((c) => curvePointIds(c).every(exists));
    const curves = new Set([...sk.curves.map((c) => c.id), 'AX', 'AY']);
    const refOk = (k) => ['a', 'b', 'p'].every((f) => !k[f] || exists(k[f])) && ['line', 'curve', 'l1', 'l2', 'c1', 'c2'].every((f) => !k[f] || curves.has(k[f]));
    sk.constraints = sk.constraints.filter(refOk);
    sk.dims = sk.dims.filter(refOk);
    // drop points no longer used by anything (unless they are standalone sketch points)
    const used = new Set();
    for (const c of sk.curves) for (const f of ['a', 'b', 'c']) if (c[f]) used.add(c[f]);
    for (const c of sk.curves) if (c.pts) c.pts.forEach((id) => used.add(id));
    for (const k of [...sk.constraints, ...sk.dims]) for (const f of ['a', 'b', 'p']) if (k[f]) used.add(k[f]);
    sk.points = sk.points.filter((p) => used.has(p.id) || p.standalone);
  }

  // ======================================================================== geometry helpers
  toLocal(v) { const d = v.clone().sub(this.basis.o); return [d.dot(this.basis.x), d.dot(this.basis.y)]; }
  w(p, lift = 0.01) { return new THREE.Vector3(...toWorld(this.plane, p, lift)); }
  px() { return this.vp.worldPerPixel(this.basis.o); }
  P(id) { return pointPos(this.sk, id); }
  geomOf(id) { const c = getCurve(this.sk, id); return c ? (c.virtual ? { id, type: 'line', a: this.P(c.a), b: this.P(c.b), virtual: true } : curveGeom(this.sk, c)) : null; }

  _rayLocal(ev) {
    const ray = this.vp._setRay(ev);
    const pl = new THREE.Plane().setFromNormalAndCoplanarPoint(this.basis.n, this.basis.o);
    const hit = ray.intersectPlane(pl, new THREE.Vector3());
    return hit ? this.toLocal(hit) : null;
  }

  _gridStep() {
    const raw = this.px() * 12;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 5, 10]) if (pow * m >= raw) return pow * m;
    return pow * 10;
  }

  // Hit test: points first, then curves, then the sketch axes.
  hitTest(p, { points = true, curves = true, axes = true } = {}) {
    const tolP = this.px() * 8, tolC = this.px() * 6;
    if (points) {
      let best = null;
      const cand = [{ id: 'O', x: 0, y: 0 }, ...this.sk.points];
      for (const q of cand) { const d = d2([q.x, q.y], p); if (d < tolP && (!best || d < best.d)) best = { d, id: q.id }; }
      if (best) return { kind: 'point', id: best.id };
    }
    if (curves) {
      let best = null;
      for (const c of this.sk.curves) {
        const g = curveGeom(this.sk, c);
        if (!g) continue;
        const d = distToGeom(p, g);
        if (d < tolC && (!best || d < best.d)) best = { d, id: c.id };
      }
      if (best) return { kind: 'curve', id: best.id };
    }
    if (axes) {
      if (Math.abs(p[1]) < tolC) return { kind: 'curve', id: 'AX' };
      if (Math.abs(p[0]) < tolC) return { kind: 'curve', id: 'AY' };
    }
    return null;
  }

  // Snap the cursor for drawing tools. Returns { p, point?, curve?, mid?, hv? }.
  snap(p, from = null) {
    const h = this.hitTest(p, { axes: false });
    if (h?.kind === 'point') return { p: this.P(h.id), point: h.id };
    // midpoints of lines
    const tolP = this.px() * 8;
    for (const c of this.sk.curves) {
      if (c.type !== 'line') continue;
      const a = this.P(c.a), b = this.P(c.b);
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (d2(m, p) < tolP) return { p: m, mid: c.id };
    }
    if (h?.kind === 'curve') return { p: closestOnGeom(p, this.geomOf(h.id)).p, curve: h.id };
    const step = this._gridStep();
    const q = [Math.round(p[0] / step) * step, Math.round(p[1] / step) * step];
    const tol = this.px() * 8;
    const res = { p: q };
    if (Math.abs(p[1]) < tol) { q[1] = 0; res.curve = 'AX'; }
    else if (Math.abs(p[0]) < tol) { q[0] = 0; res.curve = 'AY'; }
    if (from) {
      if (Math.abs(p[1] - from[1]) < tol) { q[1] = from[1]; res.hv = 'horizontal'; delete res.curve; }
      else if (Math.abs(p[0] - from[0]) < tol) { q[0] = from[0]; res.hv = 'vertical'; delete res.curve; }
    }
    return res;
  }

  // Creates (or reuses) a point for a snap result, adding on-curve / midpoint constraints.
  pointFor(s, sk = this.sk) {
    if (s.point) return s.point;
    const id = uid('p');
    sk.points.push({ id, x: s.p[0], y: s.p[1] });
    if (s.curve) sk.constraints.push({ id: uid('k'), type: 'pointOnCurve', p: id, curve: s.curve });
    if (s.mid) sk.constraints.push({ id: uid('k'), type: 'midpoint', p: id, line: s.mid });
    return id;
  }

  addPoint(xy, extra = {}) { const id = uid('p'); this.sk.points.push({ id, x: xy[0], y: xy[1], ...extra }); return id; }
  addCurve(c) {
    const id = uid('c');
    this.sk.curves.push({ id, ...c, ...(this.construction && !c.construction ? { construction: true } : {}) });
    return id;
  }
  addCon(type, refs) { const k = { id: uid('k'), type, ...refs }; this.sk.constraints.push(k); return k; }

  // ======================================================================== input
  onHover(ev) {
    const p = this._rayLocal(ev);
    if (!p) return;
    this.mouse = [ev.clientX, ev.clientY];
    this.cursorRaw = p;
    const drawTool = !['select', 'dim', 'trim', 'offset', 'mirror', 'project', 'fillet', 'lpattern', 'cpattern'].includes(this.tool) && !this.tool.startsWith('c:');
    if (drawTool) {
      this.cursor = this.snap(p, this._lastPoint());
      this.hover = null;
    } else {
      this.cursor = { p };
      this.hover = this.tool === 'project' ? null : this.hitTest(p, { points: this.tool !== 'trim' && this.tool !== 'offset' });
    }
    if (this.tool === 'project') {
      const e = this.ui.pickEdge(ev);
      this.projectHover = e;
    }
    this.redraw(true);
    this._updateHud();
  }

  onDown(ev) {
    if (this.tool !== 'select') return;
    const p = this._rayLocal(ev);
    if (!p) return;
    const h = this.hitTest(p, { axes: false });
    this.dragStart = h && !(h.kind === 'point' && h.id === 'O') ? { hit: h, p0: p, snap: JSON.stringify(this.sk) } : null;
  }

  onDrag(ev, dist) {
    if (!this.dragStart || dist < 4) return;
    const p = this._rayLocal(ev);
    if (!p) return;
    const { hit, p0 } = this.dragStart;
    if (!this.dragStart.started) { this.dragStart.started = true; this.undoStack.push(this.dragStart.snap); this.redoStack = []; }
    const delta = sub2(p, p0);
    const orig = JSON.parse(this.dragStart.snap);
    const origPos = (id) => { const q = orig.points.find((x) => x.id === id); return q ? [q.x, q.y] : null; };
    let drag = [];
    if (hit.kind === 'point') drag = [{ point: hit.id, target: p }];
    else {
      const c = orig.curves.find((x) => x.id === hit.id);
      if (!c) return;
      if (c.type === 'circle') {
        // dragging the rim changes the radius
        const ctr = origPos(c.c);
        const live = this.sk.curves.find((x) => x.id === c.id);
        if (live && ctr) live.r = Math.max(1e-3, d2(p, this.P(c.c)));
        drag = [];
      } else if (c.type === 'ellipse') {
        // dragging the rim changes the minor radius
        const live = this.sk.curves.find((x) => x.id === c.id);
        if (live) live.rb = ellipseMinorThrough(this.P(c.c), this.P(c.a), p);
        drag = [];
      } else {
        const ids = curvePointIds(c);
        drag = ids.map((id) => ({ point: id, target: add2(origPos(id), delta) })).filter((d) => d.target);
      }
    }
    if (this._dragRaf) return;
    this._dragRaf = requestAnimationFrame(() => { this._dragRaf = null; this.solve(drag, false); });
  }

  onUp() {
    if (this.dragStart?.started) { this.solve(); this._renderUI(); this._justDragged = true; }
    this.dragStart = null;
  }

  onClick(ev) {
    if (this._justDragged) { this._justDragged = false; return; }
    const raw = this._rayLocal(ev);
    if (!raw) return;
    const t = this.tool;
    if (t === 'select') return this._selectClick(raw, ev);
    if (t.startsWith('c:')) return this._constraintPick(raw);
    if (t === 'dim') return this._dimClick(raw);
    if (t === 'trim') return this._trim(raw);
    if (t === 'fillet') return this._filletClick(raw);
    if (t === 'offset') return this._offsetClick(raw);
    if (t === 'mirror') return this._mirrorClick(raw);
    if (PATTERN_TOOLS.has(t)) return this._patternClick(raw);
    if (t === 'project') return this._projectClick(ev);
    const s = this.snap(raw, this._lastPoint());
    this._drawClick(s);
  }

  onDblClick() {
    if ((this.tool === 'line' || this.tool === 'spline') && this.chain) this._finishChain(false);
  }

  onKey(e) {
    if (!this.active) return false;
    const k = e.key;
    const typing = e.target instanceof HTMLInputElement;
    if (k === 'Escape') {
      if (this.editingDim) { this._closeDimEditor(); return true; }
      if (this.chain || this.picks.length) { this.chain = null; this.picks = []; this._hideHud(); this.redraw(); }
      else if (this.tool !== 'select') this.setTool('select');
      else { this.sel.clear(); this._renderUI(); this.redraw(); }
      e.preventDefault();
      return true;
    }
    if (typing) {
      if (k === 'Enter') { if (!e.target.closest('.dim-editor')) this._commitTyped(); e.preventDefault(); return true; }
      if (k === 'Tab' && !e.target.closest('.dim-editor')) {
        const ins = [...this.ui.hud.querySelectorAll('input')];
        const i = ins.indexOf(e.target);
        const nxt = ins[(i + (e.shiftKey ? -1 : 1) + ins.length) % ins.length];
        nxt?.focus(); nxt?.select();
        e.preventDefault();
        return true;
      }
      return false;
    }
    if (k === 'Enter') { if (this.chain && (this.tool === 'line' || this.tool === 'spline')) this._finishChain(false); return true; }
    if ((k === 'Delete' || k === 'Backspace') && this.sel.size) { this.deleteSelected(); return true; }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.shiftKey ? this.redo() : this.undo(); e.preventDefault(); return true; }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'y') { this.redo(); e.preventDefault(); return true; }
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (/^[0-9.\-]$/.test(k) && DIMS[this.tool]) {
      const inp = this.ui.hud.querySelector('input');
      if (inp) { inp.focus(); inp.value = ''; }
      return false;
    }
    const map = { l: 'line', r: 'rect', c: 'circle', a: 'arc3', p: 'polygon', d: 'dim', t: 'trim', o: 'offset', f: 'fillet', s: 'slot', e: 'ellipse' };
    if (map[k.toLowerCase()]) { this.setTool(map[k.toLowerCase()]); return true; }
    if (k.toLowerCase() === 'x') { this.toggleConstruction(); return true; }
    return false;
  }

  setTool(t) {
    if (PATTERN_TOOLS.has(t) && ![...this.sel].some((k) => k[0] === 'c')) {
      this.ui.toast('Select the curves to pattern first (Select tool), then choose the pattern');
      t = 'select';
    }
    this.tool = t;
    this.chain = null;
    this.picks = [];
    this._hideHud();
    this._closeDimEditor();
    // constraint button with a matching pre-selection applies immediately
    if (t.startsWith('c:') && this.sel.size) {
      const refs = [...this.sel].map((s) => ({ kind: s[0] === 'p' ? 'point' : 'curve', id: s.slice(2) })).filter((r) => !['k', 'd'].includes(r.kind));
      if (this._applyConstraint(t.slice(2), refs)) { this.sel.clear(); this.tool = 'select'; }
    }
    this._renderUI();
    this.redraw();
  }

  _selectClick(p, ev) {
    const h = this.hitTest(p, { axes: false });
    if (!ev.shiftKey && !ev.ctrlKey) this.sel.clear();
    if (h && !(h.kind === 'point' && h.id === 'O')) {
      const key = `${h.kind === 'point' ? 'p' : 'c'}:${h.id}`;
      this.sel.has(key) ? this.sel.delete(key) : this.sel.add(key);
    }
    this._renderUI();
    this.redraw();
  }

  selectLabel(key, ev) {
    if (!ev?.shiftKey && !ev?.ctrlKey) this.sel.clear();
    this.sel.has(key) ? this.sel.delete(key) : this.sel.add(key);
    this._renderUI();
    this.redraw();
  }

  deleteSelected() {
    const keys = [...this.sel];
    this.commitChange((sk) => {
      for (const k of keys) {
        const [kind, id] = [k[0], k.slice(2)];
        if (kind === 'p') { sk.points = sk.points.filter((p) => p.id !== id); }
        if (kind === 'c') sk.curves = sk.curves.filter((c) => c.id !== id);
        if (kind === 'k') sk.constraints = sk.constraints.filter((c) => c.id !== id);
        if (kind === 'd') sk.dims = sk.dims.filter((c) => c.id !== id);
      }
    });
    this.sel.clear();
    this._renderUI();
  }

  toggleConstruction() {
    const curves = [...this.sel].filter((k) => k[0] === 'c').map((k) => k.slice(2));
    if (curves.length) {
      this.commitChange((sk) => { for (const c of sk.curves) if (curves.includes(c.id)) c.construction = !c.construction; });
    } else {
      this.construction = !this.construction;
      this._renderUI();
    }
  }

  _lastPoint() {
    if (!this.chain) return null;
    if (this.chain.last) return this.P(this.chain.last);
    return this.chain.pts?.length ? this.chain.pts.at(-1).p : null;
  }

  // ======================================================================== drawing tools
  _drawClick(s) {
    const t = this.tool;
    const ch = (this.chain ||= { pts: [] });
    if (t === 'point') {
      this.commitChange((sk) => {
        const id = this.pointFor(s, sk);
        const p = sk.points.find((x) => x.id === id);
        if (p) p.standalone = true;
      });
      this.chain = null;
      return;
    }
    if (t === 'line') {
      if (!ch.last) {
        this.snapshot();
        ch.start = ch.last = this.pointFor(s);
        ch.started = true;
        this.redraw();
        return;
      }
      const prev = ch.last;
      if (s.point === prev || d2(s.p, this.P(prev)) < 1e-9) return;
      const id = this.pointFor(s);
      const lid = this.addCurve({ type: 'line', a: prev, b: id });
      if (s.hv) this.addCon(s.hv, { line: lid });
      ch.last = id;
      const closed = id === ch.start;
      this.solve();
      if (closed) this._finishChain(true);
      return;
    }
    if (t === 'spline') {
      if (ch.pts.length >= 2 && s.point && s.point === ch.pts[0].point) { this._finishChain(true); return; }
      ch.pts.push(s);
      this.redraw();
      return;
    }
    ch.pts.push(s);
    const n = ch.pts.length;
    if ((['rect', 'crect', 'circle', 'polygon'].includes(t) && n === 2) || (['slot', 'arc3', 'arcc', 'ellipse', 'circle3'].includes(t) && n === 3)) {
      const pts = ch.pts;
      this.chain = null;
      this._hideHud();
      this._createShape(t, pts);
    } else this.redraw();
  }

  _finishChain(closed) {
    const ch = this.chain;
    this.chain = null;
    this._hideHud();
    if (!ch) return;
    if (this.tool === 'spline') {
      if (ch.pts.length < 2) return this.redraw();
      this.commitChange((sk) => {
        const ids = ch.pts.map((s) => this.pointFor(s, sk));
        this.addCurve({ type: 'spline', pts: ids, closed: closed && ids.length >= 3 });
      });
      return;
    }
    // lines were committed point by point; finishing just records a clean state
    this._prune();
    this.solve();
    this._renderUI();
  }

  _createShape(t, pts) {
    const [s0, s1, s2] = pts;
    this.commitChange((sk) => {
      if (t === 'rect' || t === 'crect') {
        let a = s0.p, b = s1.p;
        if (t === 'crect') a = [2 * s0.p[0] - s1.p[0], 2 * s0.p[1] - s1.p[1]];
        if (Math.abs(a[0] - b[0]) < 1e-9 || Math.abs(a[1] - b[1]) < 1e-9) return;
        const ids = [
          t === 'rect' ? this.pointFor(s0, sk) : this.addPoint(a),
          this.addPoint([b[0], a[1]]),
          this.pointFor(s1, sk),
          this.addPoint([a[0], b[1]]),
        ];
        const ls = ids.map((id, i) => this.addCurve({ type: 'line', a: id, b: ids[(i + 1) % 4] }));
        this.addCon('horizontal', { line: ls[0] }); this.addCon('horizontal', { line: ls[2] });
        this.addCon('vertical', { line: ls[1] }); this.addCon('vertical', { line: ls[3] });
        if (t === 'crect') {
          const c = this.pointFor(s0, sk);
          const diag = this.addCurve({ type: 'line', a: ids[0], b: ids[2], construction: true });
          this.addCon('midpoint', { p: c, line: diag });
        }
      } else if (t === 'circle') {
        const r = d2(s0.p, s1.p);
        if (r < 1e-9) return;
        const c = this.pointFor(s0, sk);
        const cid = this.addCurve({ type: 'circle', c, r });
        if (s1.point) this.addCon('pointOnCurve', { p: s1.point, curve: cid });
      } else if (t === 'polygon') {
        const r = d2(s0.p, s1.p);
        if (r < 1e-9) return;
        const n = Math.max(3, Math.min(64, this.polySides));
        const c = this.pointFor(s0, sk);
        const circ = this.addCurve({ type: 'circle', c, r, construction: true });
        const a0 = Math.atan2(s1.p[1] - s0.p[1], s1.p[0] - s0.p[0]);
        const ids = [];
        for (let i = 0; i < n; i++) {
          const ang = a0 + (i / n) * TAU;
          const id = i === 0 && s1.point ? s1.point : this.addPoint([s0.p[0] + r * Math.cos(ang), s0.p[1] + r * Math.sin(ang)]);
          ids.push(id);
          this.addCon('pointOnCurve', { p: id, curve: circ });
        }
        const ls = ids.map((id, i) => this.addCurve({ type: 'line', a: id, b: ids[(i + 1) % n] }));
        for (let i = 1; i < n; i++) this.addCon('equal', { c1: ls[0], c2: ls[i] });
      } else if (t === 'slot') {
        const A = s0.p, B = s1.p;
        const L = d2(A, B);
        if (L < 1e-9) return;
        const d = unit2(sub2(B, A)), nrm = [-d[1], d[0]];
        const r = Math.max(Math.abs((s2.p[0] - A[0]) * nrm[0] + (s2.p[1] - A[1]) * nrm[1]), 1e-3);
        const ca = this.pointFor(s0, sk), cb = this.pointFor(s1, sk);
        const a1 = this.addPoint(add2(A, mul2(nrm, r))), a2 = this.addPoint(sub2(A, mul2(nrm, r)));
        const b1 = this.addPoint(add2(B, mul2(nrm, r))), b2 = this.addPoint(sub2(B, mul2(nrm, r)));
        const l1 = this.addCurve({ type: 'line', a: a2, b: b2 }), l2 = this.addCurve({ type: 'line', a: b1, b: a1 });
        const arcB = this.addCurve({ type: 'arc', c: cb, a: b2, b: b1 }), arcA = this.addCurve({ type: 'arc', c: ca, a: a1, b: a2 });
        this.addCurve({ type: 'line', a: ca, b: cb, construction: true });
        for (const l of [l1, l2]) for (const arc of [arcA, arcB]) this.addCon('tangent', { c1: l, c2: arc });
        this.addCon('equal', { c1: arcA, c2: arcB });
      } else if (t === 'arc3') {
        const c = circumcenter(s0.p, s1.p, s2.p);
        if (!c) return;
        // orientation: does the through point lie on the ccw path start → end?
        const a0 = Math.atan2(s0.p[1] - c[1], s0.p[0] - c[0]);
        const sw = normAng(Math.atan2(s1.p[1] - c[1], s1.p[0] - c[0]) - a0);
        const sm = normAng(Math.atan2(s2.p[1] - c[1], s2.p[0] - c[0]) - a0);
        const pa = this.pointFor(s0, sk), pb = this.pointFor(s1, sk);
        const cid = this.addPoint(c);
        this.addCurve(sm < sw ? { type: 'arc', c: cid, a: pa, b: pb } : { type: 'arc', c: cid, a: pb, b: pa });
      } else if (t === 'circle3') {
        const c = circumcenter(s0.p, s1.p, s2.p);
        if (!c) return this.ui.toast('The three points are in a line');
        const cid = this.addCurve({ type: 'circle', c: this.addPoint(c), r: d2(c, s0.p) });
        // clicked points stay on the circle
        for (const s of [s0, s1, s2]) this.addCon('pointOnCurve', { p: this.pointFor(s, sk), curve: cid });
      } else if (t === 'ellipse') {
        if (d2(s0.p, s1.p) < 1e-9) return;
        const c = this.pointFor(s0, sk), a = this.pointFor(s1, sk);
        const eid = this.addCurve({ type: 'ellipse', c, a, rb: ellipseMinorThrough(s0.p, s1.p, s2.p) });
        // the major axis as a construction line, so it can be made horizontal, dimensioned or used to mirror
        this.addCurve({ type: 'line', a: c, b: a, construction: true });
        if (s2.point) this.addCon('pointOnCurve', { p: s2.point, curve: eid });
      } else if (t === 'arcc') {
        const r = d2(s0.p, s1.p);
        if (r < 1e-9) return;
        const c = this.pointFor(s0, sk), a = this.pointFor(s1, sk);
        const ang = Math.atan2(s2.p[1] - s0.p[1], s2.p[0] - s0.p[0]);
        const b = s2.point || this.addPoint([s0.p[0] + r * Math.cos(ang), s0.p[1] + r * Math.sin(ang)]);
        this.addCurve({ type: 'arc', c, a, b });
      }
    });
  }

  // ======================================================================== constraints
  _constraintPick(p) {
    const type = this.tool.slice(2);
    const h = this.hitTest(p);
    if (!h) return;
    if (type === 'fix') {
      if (h.kind !== 'point' || h.id === 'O') return this.ui.toast('Click a point to fix or unfix it');
      this.commitChange((sk) => { const q = sk.points.find((x) => x.id === h.id); if (q) q.fixed = !q.fixed; });
      return;
    }
    this.picks.push(h);
    if (this._applyConstraint(type, this.picks)) this.picks = [];
    else if (this.picks.length >= 3) { this.picks = []; this.ui.toast('That selection does not fit this constraint'); }
    this.redraw();
  }

  // Returns true when the picks were consumed (applied or rejected), false when more picks are needed.
  _applyConstraint(type, picks) {
    const pts = picks.filter((h) => h.kind === 'point').map((h) => h.id);
    const cs = picks.filter((h) => h.kind === 'curve').map((h) => ({ id: h.id, c: getCurve(this.sk, h.id) }));
    const lines = cs.filter((c) => c.c?.type === 'line').map((c) => c.id);
    const rounds = cs.filter((c) => c.c && (c.c.type === 'circle' || c.c.type === 'arc')).map((c) => c.id);
    const ells = cs.filter((c) => c.c?.type === 'ellipse').map((c) => c.id);
    let k = null;
    const n = picks.length;
    switch (type) {
      case 'coincident':
        if (pts.length === 2) k = { type: 'coincident', a: pts[0], b: pts[1] };
        else if (pts.length === 1 && cs.length === 1) k = { type: 'pointOnCurve', p: pts[0], curve: cs[0].id };
        break;
      case 'horizontal': case 'vertical':
        if (lines.length === 1 && n === 1) k = { type, line: lines[0] };
        else if (pts.length === 2) k = { type, a: pts[0], b: pts[1] };
        else if (n === 1 && pts.length === 1) return false;
        break;
      case 'parallel': case 'perpendicular': case 'collinear':
        if (lines.length === 2) k = { type, l1: lines[0], l2: lines[1] };
        break;
      case 'tangent':
        if (cs.length === 2 && ells.length) {
          if (ells.length === 1 && lines.length === 1) k = { type, c1: lines[0], c2: ells[0] };
          else { this.ui.toast('An ellipse can be tangent to a line'); return true; }
        } else if (cs.length === 2 && rounds.length >= 1) {
          const [a, b] = cs;
          k = { type, c1: a.id, c2: b.id };
          if (rounds.length === 2) {
            const g1 = this.geomOf(a.id), g2 = this.geomOf(b.id);
            k.inner = d2(g1.c, g2.c) < Math.max(g1.r, g2.r);
          }
        }
        break;
      case 'equal':
        if (lines.length === 2 || rounds.length === 2) k = { type, c1: cs[0].id, c2: cs[1].id };
        break;
      case 'concentric':
        if (rounds.length + ells.length === 2) k = { type, c1: [...rounds, ...ells][0], c2: [...rounds, ...ells][1] };
        break;
      case 'midpoint':
        if (pts.length === 1 && lines.length === 1) k = { type, p: pts[0], line: lines[0] };
        break;
      case 'symmetric':
        if (pts.length === 2 && lines.length === 1) k = { type, a: pts[0], b: pts[1], line: lines[0] };
        else if (n < 3) return false;
        break;
      default: break;
    }
    if (!k) return n >= 2 && !(type === 'symmetric' && n < 3) ? (this.ui.toast('That selection does not fit this constraint'), true) : false;
    this.commitChange((sk) => sk.constraints.push({ id: uid('k'), ...k }), { label: 'constraint', strict: true });
    return true;
  }

  // ======================================================================== dimensions
  _dimClick(p) {
    const h = this.hitTest(p);
    const same = (x, y) => x.kind === y.kind && x.id === y.id;
    if (this.picks.length === 1 && h && !same(h, this.picks[0])) {
      this.picks.push(h); // second entity: next click places the dimension
      this.redraw();
      return;
    }
    if (!this.picks.length) {
      if (h) { this.picks = [h]; this.redraw(); }
      return;
    }
    // place the dimension at the click position
    const dim = this._dimFromPicks(this.picks, p);
    this.picks = [];
    if (dim) this._openDimEditor(dim, true);
    else { this.ui.toast('Pick a line, circle, arc, or two entities to dimension'); this.redraw(); }
  }

  // Builds a dimension definition from picked entities and the label position.
  _dimFromPicks(picks, cursor) {
    if (!picks.length) return null;
    const kindOf = (h) => (h.kind === 'point' ? 'point' : getCurve(this.sk, h.id)?.type);
    const [A, B] = picks;
    const ka = kindOf(A), kb = B ? kindOf(B) : null;
    const dim = { id: uid('d') };
    const centerOf = (h) => getCurve(this.sk, h.id).c;
    if (!B) {
      if (ka === 'line') { const c = getCurve(this.sk, A.id); return this._pointPointDim(dim, c.a, c.b, cursor, true); }
      if (ka === 'circle') return { ...dim, type: 'diameter', curve: A.id };
      if (ka === 'arc') return { ...dim, type: 'radius', curve: A.id };
      if (ka === 'ellipse') {
        // the axis nearer the label: past the ends of the major axis gives major, otherwise minor
        const g = this.geomOf(A.id), [x, y] = ellipseLocal(g, cursor);
        return { ...dim, type: 'axis', curve: A.id, which: Math.abs(x) / g.rx > Math.abs(y) / g.ry ? 'major' : 'minor' };
      }
      return null;
    }
    const asPoint = (h, k) => (k === 'point' ? h.id : k === 'circle' || k === 'arc' || k === 'ellipse' ? centerOf(h) : null);
    if (ka === 'line' && kb === 'line') {
      const g1 = this.geomOf(A.id), g2 = this.geomOf(B.id);
      const u = unit2(sub2(g1.b, g1.a)), v = unit2(sub2(g2.b, g2.a));
      const cr = u[0] * v[1] - u[1] * v[0];
      if (Math.abs(cr) < 1e-6) return { ...dim, type: 'lineDist', l1: A.id, l2: B.id };
      return { ...dim, type: 'angle', l1: A.id, l2: B.id, sign: Math.sign(cr) || 1 };
    }
    if (ka === 'line' || kb === 'line') {
      const [L, O, ko] = ka === 'line' ? [A, B, kb] : [B, A, ka];
      const pid = asPoint(O, ko);
      if (pid) return { ...dim, type: 'pointLine', p: pid, line: L.id };
      return null;
    }
    const pa = asPoint(A, ka), pb = asPoint(B, kb);
    if (pa && pb && pa !== pb) return this._pointPointDim(dim, pa, pb, cursor, false);
    return null;
  }

  _pointPointDim(dim, a, b, cursor, isLine) {
    const A = this.P(a), B = this.P(b);
    const x0 = Math.min(A[0], B[0]), x1 = Math.max(A[0], B[0]), y0 = Math.min(A[1], B[1]), y1 = Math.max(A[1], B[1]);
    const dx = x1 - x0, dy = y1 - y0;
    const tiny = (v) => v < 1e-6;
    let type;
    if (tiny(dy) || tiny(dx)) type = isLine ? 'length' : 'distance';
    else if (cursor[0] < x0 || cursor[0] > x1) type = cursor[1] >= y0 && cursor[1] <= y1 ? 'vdist' : 'distance';
    else if (cursor[1] < y0 || cursor[1] > y1) type = 'hdist';
    else type = isLine ? 'length' : 'distance';
    if (type === 'length') return { ...dim, type, line: this.sk.curves.find((c) => c.type === 'line' && ((c.a === a && c.b === b) || (c.a === b && c.b === a)))?.id || null, a, b, ...(isLine ? {} : {}) };
    if (type === 'hdist') return { ...dim, type, a, b, sign: Math.sign(B[0] - A[0]) || 1 };
    if (type === 'vdist') return { ...dim, type, a, b, sign: Math.sign(B[1] - A[1]) || 1 };
    return { ...dim, type: 'distance', a, b };
  }

  // Current measured value of a dimension (in its own units).
  measure(d) {
    const P = (id) => this.P(id);
    const G = (id) => this.geomOf(id);
    switch (d.type) {
      case 'distance': return d2(P(d.a), P(d.b));
      case 'length': return d.line ? d2(G(d.line).a, G(d.line).b) : d2(P(d.a), P(d.b));
      case 'hdist': return (d.sign || 1) * (P(d.b)[0] - P(d.a)[0]);
      case 'vdist': return (d.sign || 1) * (P(d.b)[1] - P(d.a)[1]);
      case 'radius': return G(d.curve).r;
      case 'diameter': return 2 * G(d.curve).r;
      case 'axis': { const g = G(d.curve); return 2 * (d.which === 'minor' ? g.ry : g.rx); }
      case 'pointLine': { const g = G(d.line); return distToLineInf(P(d.p), g.a, g.b); }
      case 'lineDist': { const g1 = G(d.l1), g2 = G(d.l2); return distToLineInf(g2.a, g1.a, g1.b); }
      case 'angle': {
        const g1 = G(d.l1), g2 = G(d.l2);
        const u = sub2(g1.b, g1.a), v = sub2(g2.b, g2.a);
        let a = Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]) * (d.sign || 1);
        if (a < 0) a += TAU;
        return (a * 180) / Math.PI;
      }
    }
    return 0;
  }

  dimAnchor(d) {
    const P = (id) => this.P(id), G = (id) => this.geomOf(id);
    try {
      switch (d.type) {
        case 'distance': case 'hdist': case 'vdist': { const a = P(d.a), b = P(d.b); return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
        case 'length': { const g = d.line ? G(d.line) : { a: P(d.a), b: P(d.b) }; return [(g.a[0] + g.b[0]) / 2, (g.a[1] + g.b[1]) / 2]; }
        case 'radius': case 'diameter': case 'axis': return G(d.curve).c;
        case 'pointLine': { const g = G(d.line), q = P(d.p); const f = footInf(q, g.a, g.b); return [(q[0] + f[0]) / 2, (q[1] + f[1]) / 2]; }
        case 'lineDist': { const g1 = G(d.l1), g2 = G(d.l2); const f = footInf(g2.a, g1.a, g1.b); return [(g2.a[0] + f[0]) / 2, (g2.a[1] + f[1]) / 2]; }
        case 'angle': { const g1 = G(d.l1), g2 = G(d.l2); return lineIntersect(g1, g2) || g1.a; }
      }
    } catch { /* geometry missing */ }
    return [0, 0];
  }

  _openDimEditor(dim, isNew) {
    this._closeDimEditor();
    const value = this.measure(dim);
    if (isNew) {
      const anchor = this.dimAnchor(dim);
      const cur = this.cursorRaw || anchor;
      dim.off = sub2(cur, anchor);
      dim.expr = fmt(dim.type === 'angle' ? Math.abs(value) : Math.abs(value) / (this.ui.units?.().scale || 1));
    }
    this.editingDim = { dim, isNew };
    const ed = document.createElement('div');
    ed.className = 'dim-editor';
    ed.innerHTML = `<input value="${(dim.expr || '').replace(/"/g, '&quot;')}" spellcheck="false"><span>${dim.type === 'angle' ? '°' : this.ui.units?.().label || 'mm'}</span>`;
    this.vp.el.appendChild(ed);
    this.editorEl = ed;
    const inp = ed.querySelector('input');
    const pos = this._screenOf(add2(this.dimAnchor(dim), dim.off || [0, 0]));
    ed.style.left = `${pos[0]}px`;
    ed.style.top = `${pos[1]}px`;
    setTimeout(() => { inp.focus(); inp.select(); }, 0);
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); this._applyDim(inp.value); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this._closeDimEditor(); }
    });
    inp.addEventListener('blur', () => setTimeout(() => this.editingDim && this.editorEl === ed && this._applyDim(inp.value), 120));
    this.redraw();
  }

  _applyDim(expr) {
    const ed = this.editingDim;
    if (!ed) return;
    let v;
    try { v = ed.dim.type === 'angle' ? evaluate(expr, this.ui.vars()) : evaluateLen(expr, this.ui.vars(), this.ui.units?.().scale || 1); } catch (e) { this.ui.toast(e.message); return; }
    if (ed.dim.type !== 'angle' && v <= 0 && !['hdist', 'vdist'].includes(ed.dim.type)) { this.ui.toast('Dimension must be positive'); return; }
    this._closeDimEditor();
    if (ed.isNew) {
      this.commitChange((sk) => sk.dims.push({ ...ed.dim, expr: expr.trim() }), { label: 'dimension', strict: true });
    } else {
      this.commitChange((sk) => { const d = sk.dims.find((x) => x.id === ed.dim.id); if (d) d.expr = expr.trim(); }, { label: 'dimension', strict: true });
    }
  }

  _closeDimEditor() {
    this.editingDim = null;
    this.editorEl?.remove();
    this.editorEl = null;
  }

  editDim(id) {
    const d = this.sk.dims.find((x) => x.id === id);
    if (d) this._openDimEditor({ ...d }, false);
  }

  // ======================================================================== modify tools
  _trim(p) {
    const h = this.hitTest(p, { points: false, axes: false });
    if (!h) return;
    const c = getCurve(this.sk, h.id);
    const g = this.geomOf(h.id);
    if (c.type === 'spline') return this._trimSpline(c, g, p);
    if (c.type === 'ellipse') return this.ui.toast('Ellipses cannot be trimmed. Cut them with a profile instead');
    // intersection parameters with every other curve
    const others = this.sk.curves.filter((o) => o.id !== c.id).map((o) => ({ o, g: curveGeom(this.sk, o) })).filter((x) => x.g && x.g.type !== 'spline');
    const hits = [];
    for (const { o, g: og } of others) for (const x of intersect(g, og, 1e-9)) hits.push({ ...x, other: o.id });
    const q = closestOnGeom(p, g);
    this.commitChange((sk) => {
      const cur = sk.curves.find((x) => x.id === c.id);
      const newPt = (xy, other) => { const id = this.addPoint(xy); if (other) this.addCon('pointOnCurve', { p: id, curve: other }); return id; };
      const reuse = (xy, other) => {
        const ex = sk.points.find((pp) => d2([pp.x, pp.y], xy) < 1e-7);
        return ex ? ex.id : newPt(xy, other);
      };
      if (c.type === 'line') {
        const ts = hits.map((x) => ({ t: x.s, p: x.p, other: x.other })).filter((x) => x.t > 1e-7 && x.t < 1 - 1e-7).sort((a, b) => a.t - b.t);
        const lo = [...ts].reverse().find((x) => x.t < q.t), hi = ts.find((x) => x.t > q.t);
        if (!lo && !hi) { sk.curves = sk.curves.filter((x) => x.id !== c.id); return; }
        if (lo && hi) {
          const pl = reuse(lo.p, lo.other), ph = reuse(hi.p, hi.other);
          const second = { ...cur, id: uid('c'), a: ph, b: cur.b };
          cur.b = pl;
          sk.curves.push(second);
          for (const k of sk.constraints.filter((k) => k.line === c.id && ['horizontal', 'vertical'].includes(k.type))) sk.constraints.push({ ...k, id: uid('k'), line: second.id });
        } else if (lo) cur.b = reuse(lo.p, lo.other);
        else cur.a = reuse(hi.p, hi.other);
        sk.dims = sk.dims.filter((d) => d.line !== c.id);
      } else {
        const base = c.type === 'arc' ? g.a0 : 0;
        const total = c.type === 'arc' ? g.sweep : TAU;
        const tq = normAng(q.t - base);
        const ts = hits.map((x) => ({ t: normAng(x.s - base), p: x.p, other: x.other })).filter((x) => (c.type === 'circle' ? true : x.t > 1e-7 && x.t < total - 1e-7)).sort((a, b) => a.t - b.t);
        if (c.type === 'circle') {
          if (ts.length < 2) { sk.curves = sk.curves.filter((x) => x.id !== c.id); return; }
          let hi = ts.find((x) => x.t > tq) || ts[0];
          let lo = [...ts].reverse().find((x) => x.t < tq) || ts[ts.length - 1];
          // keep the remaining arc going ccw from hi round to lo
          const idx = sk.curves.indexOf(cur);
          sk.curves[idx] = { id: cur.id, type: 'arc', c: cur.c, a: reuse(hi.p, hi.other), b: reuse(lo.p, lo.other), ...(cur.construction ? { construction: true } : {}) };
          sk.dims = sk.dims.filter((d) => d.curve !== c.id || d.type === 'radius' || d.type === 'diameter');
        } else {
          const lo = [...ts].reverse().find((x) => x.t < tq), hi = ts.find((x) => x.t > tq);
          if (!lo && !hi) { sk.curves = sk.curves.filter((x) => x.id !== c.id); return; }
          if (lo && hi) {
            const pl = reuse(lo.p, lo.other), ph = reuse(hi.p, hi.other);
            sk.curves.push({ ...cur, id: uid('c'), a: ph, b: cur.b });
            cur.b = pl;
          } else if (lo) cur.b = reuse(lo.p, lo.other);
          else cur.a = reuse(hi.p, hi.other);
        }
      }
    });
  }

  // trim a spline: keep the pieces outside the nearest crossings, refitted through the fit points kept
  _trimSpline(c, g, p) {
    const samples = splineSamples(g);
    const others = this.sk.curves.filter((o) => o.id !== c.id).map((o) => ({ id: o.id, g: curveGeom(this.sk, o) })).filter((x) => x.g).map((x) => ({ ...x, samples: x.g.type === 'spline' ? splineSamples(x.g, 16) : null }));
    const crossings = splineCrossings(samples, others);
    let sClick = 0, bd = Infinity;
    for (const q of samples) { const d = d2(q.p, p); if (d < bd) { bd = d; sClick = q.s; } }
    const total = samples[samples.length - 1].s;
    const lengths = fitPointLengths(samples, g.bez.length);
    const pieces = trimSplinePieces(c.pts.map((id) => ({ id })), lengths, !!c.closed, crossings, sClick, total);
    this.commitChange((sk) => {
      const reuse = (xy, other) => {
        const ex = sk.points.find((pp) => d2([pp.x, pp.y], xy) < 1e-7);
        if (ex) return ex.id;
        const id = this.addPoint(xy);
        if (other) this.addCon('pointOnCurve', { p: id, curve: other });
        return id;
      };
      sk.curves = sk.curves.filter((x) => x.id !== c.id);
      sk.dims = sk.dims.filter((d) => d.curve !== c.id);
      for (const pc of pieces) {
        const ids = pc.pts.map((q) => q.id || reuse(q.xy, q.other));
        this.addCurve({ type: 'spline', pts: ids, closed: false, ...(c.construction ? { construction: true } : {}) });
      }
    });
    if (!pieces.length) this.ui.toast('The spline crossed nothing, so it was removed');
  }

  _filletClick(p) {
    const h = this.hitTest(p, { curves: false, axes: false });
    if (!h || h.kind !== 'point') return this.ui.toast('Click a corner where two lines meet');
    const lines = this.sk.curves.filter((c) => c.type === 'line' && !c.construction && (c.a === h.id || c.b === h.id));
    if (lines.length !== 2) return this.ui.toast('Fillet needs a corner shared by exactly two lines');
    const r = this.filletR;
    const P = this.P(h.id);
    const other = (l) => this.P(l.a === h.id ? l.b : l.a);
    const u1 = unit2(sub2(other(lines[0]), P)), u2 = unit2(sub2(other(lines[1]), P));
    const cosT = Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]));
    const theta = Math.acos(cosT);
    if (theta < 1e-3 || Math.PI - theta < 1e-3) return this.ui.toast('Lines are parallel');
    const t = r / Math.tan(theta / 2);
    if (t > d2(other(lines[0]), P) || t > d2(other(lines[1]), P)) return this.ui.toast('Fillet radius is too large for these lines');
    const bis = unit2(add2(u1, u2));
    const C = add2(P, mul2(bis, r / Math.sin(theta / 2)));
    const T1 = add2(P, mul2(u1, t)), T2 = add2(P, mul2(u2, t));
    this.commitChange((sk) => {
      const t1 = this.addPoint(T1), t2 = this.addPoint(T2), c = this.addPoint(C);
      const [l1, l2] = lines.map((l) => sk.curves.find((x) => x.id === l.id));
      if (l1.a === h.id) l1.a = t1; else l1.b = t1;
      if (l2.a === h.id) l2.a = t2; else l2.b = t2;
      const cr = (T1[0] - C[0]) * (T2[1] - C[1]) - (T1[1] - C[1]) * (T2[0] - C[0]);
      const arc = this.addCurve(cr > 0 ? { type: 'arc', c, a: t1, b: t2 } : { type: 'arc', c, a: t2, b: t1 });
      this.addCon('tangent', { c1: l1.id, c2: arc });
      this.addCon('tangent', { c1: l2.id, c2: arc });
      sk.dims.push({ id: uid('d'), type: 'radius', curve: arc, expr: this._ex(r), off: [r, r] });
      // constraints that pinned the old corner point move to nothing (the point is removed)
      sk.constraints = sk.constraints.filter((k) => k.a !== h.id && k.b !== h.id && k.p !== h.id);
      sk.points = sk.points.filter((q) => q.id !== h.id);
    });
  }

  _offsetClick(p) {
    const h = this.hitTest(p, { points: false, axes: false });
    if (!h) return this.ui.toast('Click a curve to offset its connected chain');
    const D = this.offsetD;
    const c0 = getCurve(this.sk, h.id);
    if (c0.type === 'circle') {
      const g = this.geomOf(c0.id);
      const inside = d2(this.cursorRaw || p, g.c) < g.r;
      const r = inside ? g.r - D : g.r + D;
      if (r <= 0) return this.ui.toast('Offset is larger than the radius');
      this.commitChange(() => this.addCurve({ type: 'circle', c: c0.c, r }));
      return;
    }
    if (c0.type === 'ellipse') {
      // the offset of an ellipse is not an ellipse: it becomes a closed spline through 48 exact offset points
      const g = this.geomOf(c0.id), [x, y] = ellipseLocal(g, this.cursorRaw || p);
      const out = Math.hypot(x / g.rx, y / g.ry) > 1 ? 1 : -1;
      if (out < 0 && D >= Math.min(g.rx, g.ry)) return this.ui.toast('Offset is larger than the minor radius');
      const pts = Array.from({ length: 48 }, (_, i) => {
        const t = (i / 48) * TAU, q = ellipsePoint(g, t);
        const cr = Math.cos(g.rot), sr = Math.sin(g.rot), nx = g.ry * Math.cos(t), ny = g.rx * Math.sin(t), L = Math.hypot(nx, ny);
        return [q[0] + (out * D * (nx * cr - ny * sr)) / L, q[1] + (out * D * (nx * sr + ny * cr)) / L];
      });
      this.commitChange(() => { const ids = pts.map((xy) => this.addPoint(xy)); this.addCurve({ type: 'spline', pts: ids, closed: true }); });
      return;
    }
    if (c0.type === 'spline') {
      const g = this.geomOf(c0.id);
      const side = splineSide(splineSamples(g, 16), this.cursorRaw || p);
      const pts = offsetSplinePoints(g, D * side);
      this.commitChange(() => { const ids = pts.map((xy) => this.addPoint(xy)); this.addCurve({ type: 'spline', pts: ids, closed: !!c0.closed }); });
      return;
    }
    const chain = this._chainFrom(c0);
    if (!chain) return this.ui.toast('Offset works on connected lines and arcs, circles and splines');
    // which side? sample: offset toward the cursor
    const g0 = this.geomOf(chain.items[0].id);
    const side = sideOf(g0, chain.items[0].fwd, this.cursorRaw || p);
    const off = D * side;
    const elems = chain.items.map(({ id, fwd }) => offsetElem(this.geomOf(id), fwd, off));
    if (elems.some((e) => !e)) return this.ui.toast('Offset would collapse an arc');
    this.commitChange((sk) => {
      const n = elems.length;
      const joints = [];
      for (let i = 0; i < n; i++) {
        const prev = chain.closed ? elems[(i - 1 + n) % n] : elems[i - 1];
        joints.push(prev ? joinPoint(prev, elems[i]) : elems[i].start);
      }
      const endPt = chain.closed ? null : elems[n - 1].end;
      const ids = joints.map((xy) => this.addPoint(xy));
      const endId = endPt ? this.addPoint(endPt) : null;
      for (let i = 0; i < n; i++) {
        const a = ids[i], b = i + 1 < n ? ids[i + 1] : chain.closed ? ids[0] : endId;
        const e = elems[i], src = getCurve(sk, chain.items[i].id);
        if (e.type === 'line') {
          const lid = this.addCurve({ type: 'line', a, b });
          sk.constraints.push({ id: uid('k'), type: 'parallel', l1: src.id, l2: lid });
        } else {
          this.addCurve(e.ccw ? { type: 'arc', c: src.c, a, b } : { type: 'arc', c: src.c, a: b, b: a });
        }
      }
    });
  }

  // Connected chain of lines/arcs through points shared by exactly two curves.
  _chainFrom(c0) {
    const usable = (c) => (c.type === 'line' || c.type === 'arc') && !c.construction;
    if (!usable(c0)) return null;
    const ends = (c) => (c.type === 'line' ? [c.a, c.b] : [c.a, c.b]);
    const touching = (pid, except) => this.sk.curves.filter((c) => usable(c) && c.id !== except && ends(c).includes(pid));
    // walk backwards to a start
    let start = c0, startFrom = ends(c0)[0];
    const seen = new Set([c0.id]);
    for (;;) {
      const t = touching(startFrom, start.id);
      if (t.length !== 1 || seen.has(t[0].id)) break;
      seen.add(t[0].id);
      const nxt = t[0];
      startFrom = ends(nxt)[0] === startFrom ? ends(nxt)[1] : ends(nxt)[0];
      start = nxt;
    }
    const items = [];
    let cur = start, from = startFrom;
    const used = new Set();
    for (;;) {
      used.add(cur.id);
      const [a, b] = ends(cur);
      const fwd = a === from;
      items.push({ id: cur.id, fwd });
      const to = fwd ? b : a;
      const t = touching(to, cur.id).filter((c) => !used.has(c.id));
      if (t.length !== 1) {
        const closed = touching(to, cur.id).some((c) => c.id === start.id) && items.length > 1;
        return { items, closed };
      }
      cur = t[0];
      from = to;
    }
  }

  // ---- sketch patterns: copies of the selected curves along a line or round a centre
  get pat() { return (this._pat ||= { n: 3, total: 360 }); }
  _patSel() { return [...this.sel].filter((k) => k[0] === 'c').map((k) => k.slice(2)).filter((id) => getCurve(this.sk, id) && !VIRTUAL_LINES[id]); }
  _patCentre() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of this._patSel()) for (const q of sampleGeom(this.geomOf(id), 16)) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); }
    return [(x0 + x1) / 2, (y0 + y1) / 2];
  }
  // step of a linear pattern: from the selection's centre to the cursor
  _patStep() {
    const c = this._patCentre(), q = this.cursorRaw || this.cursor?.p || [c[0] + 10, c[1]];
    return { d: d2(c, q), a: (Math.atan2(q[1] - c[1], q[0] - c[0]) * 180) / Math.PI };
  }
  _patXf(p) {
    if (this.tool === 'lpattern') {
      const c = this._patCentre(), dx = p[0] - c[0], dy = p[1] - c[1];
      return (q, i) => [q[0] + dx * i, q[1] + dy * i];
    }
    const full = Math.abs(this.pat.total - 360) < 1e-9, step = ((this.pat.total * Math.PI) / 180) / (full ? this.pat.n : this.pat.n - 1);
    return (q, i) => { const a = step * i, x = q[0] - p[0], y = q[1] - p[1]; return [p[0] + x * Math.cos(a) - y * Math.sin(a), p[1] + x * Math.sin(a) + y * Math.cos(a)]; };
  }
  _drawPatternPreview(g, c) {
    if (!c || !this._patSel().length) return;
    const centre = this.tool === 'cpattern' ? this.snap(c).p : c, xf = this._patXf(centre);
    for (let i = 1; i < this.pat.n; i++) for (const id of this._patSel()) g.add(this._line(sampleGeom(this.geomOf(id), 48).map((q) => xf(q, i)), COLORS.skPrev, { dashed: true }));
    if (this.tool === 'cpattern') g.add(this._pointMark(centre, COLORS.skSnap, 4, true));
  }
  _patternClick(p) {
    const s = this.snap(p);
    this._applyPattern(this._patXf(this.tool === 'cpattern' ? s.p : p));
  }
  _applyPattern(xf) {
    const ids = this._patSel();
    if (!ids.length) return this.setTool('select');
    const n = this.pat.n;
    this.commitChange((sk) => { for (let i = 1; i < n; i++) this._copyCurves(sk, ids, (q) => xf(q, i)); });
    this.ui.toast(`Made ${n - 1} cop${n === 2 ? 'y' : 'ies'} of ${ids.length} curve${ids.length === 1 ? '' : 's'}`, 'ok');
    this.sel.clear();
    this.setTool('select');
  }
  // copies curves through a rigid transform of their points (shared points stay shared)
  _copyCurves(sk, ids, xf) {
    const map = new Map();
    const mp = (id) => { if (!map.has(id)) map.set(id, this.addPoint(xf(this.P(id)))); return map.get(id); };
    for (const cid of ids) {
      const c = getCurve(sk, cid), cons = c.construction ? { construction: true } : {};
      if (c.type === 'line') this.addCurve({ type: 'line', a: mp(c.a), b: mp(c.b), ...cons });
      else if (c.type === 'circle') this.addCurve({ type: 'circle', c: mp(c.c), r: c.r, ...cons });
      else if (c.type === 'arc') this.addCurve({ type: 'arc', c: mp(c.c), a: mp(c.a), b: mp(c.b), ...cons });
      else if (c.type === 'spline') this.addCurve({ type: 'spline', pts: c.pts.map(mp), closed: c.closed, ...cons });
      else if (c.type === 'ellipse') this.addCurve({ type: 'ellipse', c: mp(c.c), a: mp(c.a), rb: c.rb, ...cons });
    }
  }

  _mirrorClick(p) {
    const sel = [...this.sel].filter((k) => k[0] === 'c').map((k) => k.slice(2));
    if (!sel.length) { this.ui.toast('Select the curves to mirror first (Select tool), then pick a mirror line'); this.setTool('select'); return; }
    const h = this.hitTest(p, { points: false });
    const ml = h && getCurve(this.sk, h.id);
    if (!ml || ml.type !== 'line' || sel.includes(h.id)) return this.ui.toast('Click a line (or sketch axis) to mirror about');
    const g = this.geomOf(h.id);
    const refl = (q) => { const f = footInf(q, g.a, g.b); return [2 * f[0] - q[0], 2 * f[1] - q[1]]; };
    this.commitChange((sk) => {
      const map = new Map();
      const mp = (id) => {
        if (map.has(id)) return map.get(id);
        const q = this.P(id);
        if (distToLineInf(q, g.a, g.b) < 1e-7) { map.set(id, id); return id; }
        const nid = this.addPoint(refl(q));
        map.set(id, nid);
        sk.constraints.push({ id: uid('k'), type: 'symmetric', a: id, b: nid, line: h.id });
        return nid;
      };
      for (const cid of sel) {
        const c = getCurve(sk, cid);
        if (c.type === 'line') this.addCurve({ type: 'line', a: mp(c.a), b: mp(c.b), construction: c.construction });
        else if (c.type === 'circle') this.addCurve({ type: 'circle', c: mp(c.c), r: c.r, construction: c.construction });
        else if (c.type === 'arc') this.addCurve({ type: 'arc', c: mp(c.c), a: mp(c.b), b: mp(c.a), construction: c.construction });
        else if (c.type === 'spline') this.addCurve({ type: 'spline', pts: c.pts.map(mp), closed: c.closed });
        else if (c.type === 'ellipse') this.addCurve({ type: 'ellipse', c: mp(c.c), a: mp(c.a), rb: c.rb, construction: c.construction });
      }
    });
    this.sel.clear();
    this.setTool('select');
  }

  _projectClick(ev) {
    const e = this.ui.pickEdge(ev);
    if (!e) return this.ui.toast('Click an edge of a body to project it into the sketch');
    const pts = e.points.map((v) => this.toLocal(new THREE.Vector3(...v)));
    const clean = [];
    for (const q of pts) if (!clean.length || d2(q, clean.at(-1)) > 1e-6) clean.push(q);
    if (clean.length < 2) return;
    // each projected curve remembers its source edge (src), and the kernel re-projects it after model changes
    const g = uid('g'), src = (k, i = 0) => (e.ref ? { src: { ...e.ref, g, k, i } } : {});
    this.commitChange(() => {
      const fixedPt = (q) => this.addPoint(q, { fixed: true });
      const first = clean[0], last = clean.at(-1);
      const closed = d2(first, last) < 1e-5;
      // straight?
      const straight = clean.every((q) => distToLineInf(q, first, last) < 1e-4) && !closed;
      if (straight) { this.addCurve({ type: 'line', a: fixedPt(first), b: fixedPt(last), projected: true, ...src('line') }); return; }
      // circular?
      const c = clean.length >= 3 ? circumcenter(clean[0], clean[Math.floor(clean.length / 3)], clean[Math.floor((2 * clean.length) / 3)]) : null;
      if (c) {
        const r = d2(c, clean[0]);
        if (clean.every((q) => Math.abs(d2(q, c) - r) < Math.max(1e-3, r * 1e-3))) {
          const cid = fixedPt(c);
          if (closed) { this.addCurve({ type: 'circle', c: cid, r, projected: true, ...src('circle') }); return; }
          const a0 = Math.atan2(first[1] - c[1], first[0] - c[0]);
          const sw = normAng(Math.atan2(last[1] - c[1], last[0] - c[0]) - a0);
          const sm = normAng(Math.atan2(clean[1][1] - c[1], clean[1][0] - c[0]) - a0);
          const pa = fixedPt(first), pb = fixedPt(last);
          this.addCurve(sm < sw ? { type: 'arc', c: cid, a: pa, b: pb, projected: true, ...src('arc') } : { type: 'arc', c: cid, a: pb, b: pa, projected: true, ...src('arc') });
          return;
        }
      }
      // generic: chain of fixed segments
      const ids = (closed ? clean.slice(0, -1) : clean).map(fixedPt);
      for (let i = 0; i < ids.length - (closed ? 0 : 1); i++) this.addCurve({ type: 'line', a: ids[i], b: ids[(i + 1) % ids.length], projected: true, ...src(closed ? 'loop' : 'chain', i) });
    });
  }

  // ======================================================================== typed values (HUD)
  _hudValues() {
    const vals = {};
    for (const inp of this.ui.hud.querySelectorAll('input')) {
      if (inp.value.trim() === '') continue;
      try { vals[inp.dataset.k] = ['A', 'N'].includes(inp.dataset.k) ? evaluate(inp.value, this.ui.vars()) : evaluateLen(inp.value, this.ui.vars(), this.ui.units?.().scale || 1); inp.classList.remove('bad'); } catch { inp.classList.add('bad'); }
    }
    return vals;
  }

  _commitTyped() {
    const v = this._hudValues();
    const t = this.tool;
    if (t === 'fillet') { if (v.R > 0) this.filletR = v.R; this._hideHud(); this._renderUI(); return; }
    if (t === 'offset') { if (v.D > 0) this.offsetD = v.D; this._hideHud(); this._renderUI(); return; }
    if (t === 'polygon' && v.N) this.polySides = Math.max(3, Math.min(64, Math.round(v.N)));
    if (PATTERN_TOOLS.has(t)) {
      if (v.N) this.pat.n = Math.max(2, Math.min(200, Math.round(v.N)));
      if (t === 'cpattern') { if (v.T) this.pat.total = Math.max(1, Math.min(360, v.T)); this._hideHud(); this.ui.toast('Now click the centre of the pattern'); return this.redraw(); }
      // a typed spacing applies straight away; otherwise the direction follows the cursor
      if (v.D !== undefined || v.A !== undefined) {
        const st = this._patStep();
        const d = v.D ?? st.d, a = ((v.A ?? st.a) * Math.PI) / 180;
        this._applyPattern((q, i) => [q[0] + Math.cos(a) * d * i, q[1] + Math.sin(a) * d * i]);
      }
      return this._blurHud();
    }
    const cur = this.cursor?.p || [0, 0];
    const ch = this.chain;
    const first = ch?.last ? this.P(ch.last) : ch?.pts?.[0]?.p;
    if (!first) {
      // nothing placed yet: place the first point at the cursor
      if (this.cursor) this._drawClick(this.cursor);
      return this._blurHud();
    }
    let target = null;
    if (t === 'line') {
      let ang = Math.atan2(cur[1] - first[1], cur[0] - first[0]);
      if (v.A !== undefined) ang = (v.A * Math.PI) / 180;
      const L = v.L ?? d2(cur, first);
      target = [first[0] + L * Math.cos(ang), first[1] + L * Math.sin(ang)];
      const s = { p: target };
      this._drawClick(s);
      // pin the typed length / angle as driving dimensions
      const lid = this.sk.curves.at(-1)?.id;
      if (lid && v.L !== undefined) this.commitChange((sk) => sk.dims.push({ id: uid('d'), type: 'length', line: lid, expr: this._ex(v.L), off: [0, this.px() * 20] }));
      return this._blurHud();
    }
    if (t === 'rect' || t === 'crect') {
      const k = t === 'crect' ? 0.5 : 1;
      const sx = cur[0] < first[0] ? -1 : 1, sy = cur[1] < first[1] ? -1 : 1;
      const W = v.W ?? Math.abs(cur[0] - first[0]) / k, H = v.H ?? Math.abs(cur[1] - first[1]) / k;
      this._drawClick({ p: [first[0] + sx * W * k, first[1] + sy * H * k] });
      const ls = this.sk.curves.filter((c) => c.type === 'line').slice(-4 - (t === 'crect' ? 1 : 0)).filter((c) => !c.construction);
      this.commitChange((sk) => {
        if (v.W !== undefined && ls[0]) sk.dims.push({ id: uid('d'), type: 'length', line: ls[0].id, expr: this._ex(v.W), off: [0, -this.px() * 24] });
        if (v.H !== undefined && ls[1]) sk.dims.push({ id: uid('d'), type: 'length', line: ls[1].id, expr: this._ex(v.H), off: [this.px() * 24, 0] });
      });
      return this._blurHud();
    }
    if (t === 'circle') {
      const D = v.D ?? 2 * d2(cur, first);
      this._drawClick({ p: [first[0] + D / 2, first[1]] });
      const cid = this.sk.curves.at(-1)?.id;
      if (v.D !== undefined && cid) this.commitChange((sk) => sk.dims.push({ id: uid('d'), type: 'diameter', curve: cid, expr: this._ex(v.D), off: [D / 2 + this.px() * 10, D / 2] }));
      return this._blurHud();
    }
    if (t === 'polygon') {
      const ang = Math.atan2(cur[1] - first[1], cur[0] - first[0]);
      const R = v.R ?? d2(cur, first);
      this._drawClick({ p: [first[0] + R * Math.cos(ang), first[1] + R * Math.sin(ang)] });
      return this._blurHud();
    }
    if (t === 'slot') {
      if (ch.pts.length === 1) {
        const ang = Math.atan2(cur[1] - first[1], cur[0] - first[0]);
        const L = v.L ?? d2(cur, first);
        this._drawClick({ p: [first[0] + L * Math.cos(ang), first[1] + L * Math.sin(ang)] });
      } else if (v.W) {
        const b = ch.pts[1].p, d = unit2(sub2(b, first));
        this._drawClick({ p: add2(first, mul2([-d[1], d[0]], v.W / 2)) });
      }
      return this._blurHud();
    }
    if (t === 'ellipse') {
      // A (full major axis) then B (full minor axis)
      const n0 = ch.pts.length;
      if (n0 === 1) {
        const ang = Math.atan2(cur[1] - first[1], cur[0] - first[0]);
        const R = v.A !== undefined ? v.A / 2 : d2(cur, first);
        ch.typedA = v.A;
        this._drawClick({ p: [first[0] + R * Math.cos(ang), first[1] + R * Math.sin(ang)] });
      }
      if (n0 === 2 || v.B !== undefined) {
        const A = ch.pts[1].p, d = unit2(sub2(A, first)), typedA = ch.typedA ?? v.A;
        const rb = v.B !== undefined ? v.B / 2 : ellipseMinorThrough(first, A, cur);
        this._drawClick({ p: add2(first, mul2([-d[1], d[0]], rb)) });
        const eid = this.sk.curves.filter((x) => x.type === 'ellipse').at(-1)?.id;
        if (eid && (typedA !== undefined || v.B !== undefined)) this.commitChange((sk) => {
          if (typedA !== undefined) sk.dims.push({ id: uid('d'), type: 'axis', curve: eid, which: 'major', expr: this._ex(typedA), off: [0, -rb - this.px() * 24] });
          if (v.B !== undefined) sk.dims.push({ id: uid('d'), type: 'axis', curve: eid, which: 'minor', expr: this._ex(v.B), off: [d2(first, A) + this.px() * 24, 0] });
        });
      }
      return this._blurHud();
    }
    if (t === 'arcc' && ch.pts.length === 1 && v.R) {
      const ang = Math.atan2(cur[1] - first[1], cur[0] - first[0]);
      this._drawClick({ p: [first[0] + v.R * Math.cos(ang), first[1] + v.R * Math.sin(ang)] });
      return this._blurHud();
    }
  }

  _blurHud() { document.activeElement?.blur?.(); this._hideHud(); }
  _hideHud() { this.ui.hud.style.display = 'none'; this.ui.hud.innerHTML = ''; this._hudKey = null; }

  _updateHud() {
    const dims = DIMS[this.tool];
    const hud = this.ui.hud;
    const always = this.tool === 'fillet' || this.tool === 'offset' || this.tool === 'polygon' || PATTERN_TOOLS.has(this.tool);
    if (!dims || !this.cursor || (!this.chain && !always)) { if (this._hudKey) this._hideHud(); return; }
    const key = `${this.tool}:${this.chain?.pts?.length || 0}:${!!this.chain?.last}`;
    if (this._hudKey !== key) {
      this._hudKey = key;
      hud.innerHTML = dims.map(([k, label]) => `<label title="${label}">${k}<input data-k="${k}" placeholder="${label}" spellcheck="false"></label>`).join('') + '<span class="hud-hint">Tab ⇥ next · Enter ↵ apply</span>';
      hud.style.display = 'flex';
    }
    const live = this._liveDims();
    for (const inp of hud.querySelectorAll('input')) if (document.activeElement !== inp && live[inp.dataset.k] !== undefined) inp.placeholder = live[inp.dataset.k];
    const r = this.vp.el.getBoundingClientRect();
    hud.style.left = `${this.mouse[0] - r.left + 18}px`;
    hud.style.top = `${this.mouse[1] - r.top + 18}px`;
  }

  _liveDims() {
    const c = this.cursor?.p, a = this._lastPoint() || this.chain?.pts?.[0]?.p;
    switch (this.tool) {
      case 'fillet': return { R: fmt(this.filletR) };
      case 'offset': return { D: fmt(this.offsetD) };
      case 'polygon': return { R: a && c ? fmt(d2(c, a)) : '', N: String(this.polySides) };
      case 'lpattern': { const st = this._patStep(); return { N: String(this.pat.n), D: fmt(st.d), A: fmt(st.a) }; }
      case 'cpattern': return { N: String(this.pat.n), T: fmt(this.pat.total) };
    }
    if (!c || !a) return {};
    switch (this.tool) {
      case 'line': return { L: fmt(d2(c, a)), A: fmt((Math.atan2(c[1] - a[1], c[0] - a[0]) * 180) / Math.PI) };
      case 'rect': return { W: fmt(Math.abs(c[0] - a[0])), H: fmt(Math.abs(c[1] - a[1])) };
      case 'crect': return { W: fmt(2 * Math.abs(c[0] - a[0])), H: fmt(2 * Math.abs(c[1] - a[1])) };
      case 'circle': return { D: fmt(2 * d2(c, a)) };
      case 'arcc': return { R: fmt(d2(c, a)) };
      case 'ellipse': {
        const C = this.chain.pts[0].p;
        return this.chain.pts.length === 1 ? { A: fmt(2 * d2(c, C)) } : { A: fmt(2 * d2(this.chain.pts[1].p, C)), B: fmt(2 * ellipseMinorThrough(C, this.chain.pts[1].p, c)) };
      }
      case 'slot': return this.chain.pts.length === 1 ? { L: fmt(d2(c, a)) } : {};
    }
    return {};
  }

  // ======================================================================== rendering
  _buildStatic() {
    const L = this.vp.sketchLayer;
    L.clear();
    const size = 400, step = 10;
    const pts = [];
    for (let i = -size / 2; i <= size / 2; i += step) pts.push(this.w([i, -size / 2], 0), this.w([i, size / 2], 0), this.w([-size / 2, i], 0), this.w([size / 2, i], 0));
    const grid = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: COLORS.grid, transparent: true, opacity: 0.28, depthWrite: false }));
    const axes = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([this.w([-size / 2, 0], 0), this.w([size / 2, 0], 0), this.w([0, -size / 2], 0), this.w([0, size / 2], 0)]), new THREE.LineDashedMaterial({ color: COLORS.gridMajor, dashSize: 3, gapSize: 2 }));
    axes.computeLineDistances();
    for (const o of [grid, axes]) o.raycast = () => {};
    this.dyn = new THREE.Group();
    this.fills = new THREE.Group();
    L.add(grid, axes, this.fills, this.dyn);
  }

  _line(pts2, color, { closed = false, dashed = false, width = 1 } = {}) {
    const v = pts2.map((p) => this.w(p));
    if (closed && v.length > 2) v.push(v[0]);
    const px = this.px();
    const mat = dashed
      ? new THREE.LineDashedMaterial({ color, dashSize: px * 6, gapSize: px * 4, depthTest: false })
      : new THREE.LineBasicMaterial({ color, depthTest: false, linewidth: width });
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(v), mat);
    if (dashed) l.computeLineDistances();
    l.renderOrder = 20;
    return l;
  }

  _thick(pts2, color) {
    // a screen-space-ish thick line made of quads, for highlighted curves
    const g = new THREE.Group();
    const r = this.px() * 1.4;
    const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, side: THREE.DoubleSide });
    for (let i = 0; i < pts2.length - 1; i++) {
      const a = pts2[i], b = pts2[i + 1], d = unit2(sub2(b, a)), n = [-d[1] * r, d[0] * r];
      const quad = [add2(a, n), add2(b, n), sub2(b, n), sub2(a, n)].map((q) => this.w(q, 0.02));
      const geo = new THREE.BufferGeometry().setFromPoints([quad[0], quad[1], quad[2], quad[0], quad[2], quad[3]]);
      const m = new THREE.Mesh(geo, mat);
      m.renderOrder = 21;
      g.add(m);
    }
    return g;
  }

  _pointMark(p, color, size = 3.5, filled = true) {
    const s = this.px() * size;
    const quad = [[p[0] - s, p[1] - s], [p[0] + s, p[1] - s], [p[0] + s, p[1] + s], [p[0] - s, p[1] + s]];
    if (!filled) return this._line(quad, color, { closed: true });
    const v = quad.map((q) => this.w(q, 0.03));
    const m = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints([v[0], v[1], v[2], v[0], v[2], v[3]]), new THREE.MeshBasicMaterial({ color, depthTest: false, side: THREE.DoubleSide }));
    m.material.toneMapped = false;
    m.renderOrder = 22;
    return m;
  }

  _curveColor(c) {
    const key = `c:${c.id}`;
    if (this.sel.has(key)) return COLORS.select;
    if (this.hover?.kind === 'curve' && this.hover.id === c.id) return COLORS.hover;
    if (this.picks.some((h) => h.kind === 'curve' && h.id === c.id)) return COLORS.select;
    if (c.projected) return COLORS.skFixed;
    if (c.construction) return COLORS.skConstr;
    const det = this.status && curvePointIds(c).every((id) => this.status.pointDetermined(id)) && ((c.type !== 'circle' && c.type !== 'ellipse') || this.status.radiusDetermined(c.id));
    return det ? COLORS.skFull : COLORS.skFree;
  }

  redraw(hoverOnly = false) {
    if (!this.active) return;
    const g = this.dyn;
    g.clear();
    // profile fills (only recomputed when geometry changed)
    if (!hoverOnly || this._fillVersion !== this.geomVersion) {
      this._fillVersion = this.geomVersion;
      this.fills.clear();
      this.regions = computeRegions(sketchGeom(this.sk));
      for (const r of this.regions) {
        const shape = new THREE.Shape(r.poly.map(([u, v]) => new THREE.Vector2(u, v)));
        for (const h of r.holes) shape.holes.push(new THREE.Path(h.poly.map(([u, v]) => new THREE.Vector2(u, v))));
        const geo = new THREE.ShapeGeometry(shape);
        geo.applyMatrix4(new THREE.Matrix4().makeBasis(this.basis.x, this.basis.y, this.basis.n).setPosition(this.basis.o));
        const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: COLORS.profile, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
        m.renderOrder = 15;
        this.fills.add(m);
      }
    }
    for (const c of this.sk.curves) {
      const geo = curveGeom(this.sk, c);
      if (!geo) continue;
      const pts = sampleGeom(geo, 96);
      const color = this.failed?.size && this._curveFailed(c) ? 0xf0525b : this._curveColor(c);
      const hl = color === COLORS.select || color === COLORS.hover;
      g.add(hl ? this._thick(pts, color) : this._line(pts, color, { dashed: c.construction }));
    }
    // points
    const usedAsEnd = new Set();
    for (const c of this.sk.curves) for (const f of ['a', 'b', 'c']) if (c[f]) usedAsEnd.add(c[f]);
    for (const c of this.sk.curves) if (c.pts) c.pts.forEach((id) => usedAsEnd.add(id));
    for (const p of this.sk.points) {
      const key = `p:${p.id}`;
      const sel = this.sel.has(key) || this.picks.some((h) => h.kind === 'point' && h.id === p.id);
      const hov = this.hover?.kind === 'point' && this.hover.id === p.id;
      const color = sel ? COLORS.select : hov ? COLORS.hover : p.fixed ? COLORS.skFixed : this.status?.pointDetermined(p.id) ? COLORS.skFull : COLORS.skFree;
      g.add(this._pointMark([p.x, p.y], color, sel || hov ? 4.5 : 3, true));
    }
    g.add(this._pointMark([0, 0], this.hover?.kind === 'point' && this.hover.id === 'O' ? COLORS.hover : COLORS.skDim, 3.5, false));
    if (this.hover?.kind === 'curve' && VIRTUAL_LINES[this.hover.id]) {
      const L = 1000;
      g.add(this._thick(this.hover.id === 'AX' ? [[-L, 0], [L, 0]] : [[0, -L], [0, L]], COLORS.hover));
    }
    this._drawDims(g);
    this._drawPreview(g);
    this._renderLabels();
    this.vp.requestRender();
  }

  _curveFailed(c) {
    return this.sk.constraints.some((k) => this.failed.has(k.id) && [k.line, k.l1, k.l2, k.c1, k.c2, k.curve].includes(c.id))
      || this.sk.dims.some((d) => this.failed.has(d.id) && [d.line, d.l1, d.l2, d.curve].includes(c.id));
  }

  _drawPreview(g) {
    const c = this.cursor?.p;
    const prev = COLORS.skPrev;
    const t = this.tool;
    if (t === 'project' && this.projectHover) {
      g.add(this._thick(this.projectHover.points.map((v) => this.toLocal(new THREE.Vector3(...v))), COLORS.skFixed));
    }
    if (!c) return;
    const ch = this.chain;
    const drawTool = !['select', 'dim', 'trim', 'offset', 'mirror', 'project', 'fillet', 'lpattern', 'cpattern'].includes(t) && !t.startsWith('c:');
    if (PATTERN_TOOLS.has(t)) this._drawPatternPreview(g, c);
    if (drawTool) {
      const s = this.cursor;
      g.add(this._pointMark(c, s.point || s.curve || s.mid ? COLORS.skSnap : prev, s.point ? 5 : 3, !!s.point));
      if (s.mid) g.add(this._line([[c[0] - this.px() * 6, c[1] - this.px() * 4], [c[0] + this.px() * 6, c[1] - this.px() * 4], [c[0], c[1] + this.px() * 6]], COLORS.skSnap, { closed: true }));
      const last = this._lastPoint();
      if (s.hv && last) g.add(this._line([last, c], COLORS.skSnap, { dashed: true }));
      if (t === 'line' && ch?.last) g.add(this._line([this.P(ch.last), c], prev));
      if (t === 'spline' && ch?.pts.length) {
        const pts = [...ch.pts.map((x) => x.p), c];
        g.add(this._line(sampleGeom({ type: 'spline', bez: catmull(pts) }), prev));
      }
      const pts = ch?.pts || [];
      if (pts.length === 1 && ['rect', 'crect'].includes(t)) {
        const a = t === 'crect' ? [2 * pts[0].p[0] - c[0], 2 * pts[0].p[1] - c[1]] : pts[0].p;
        g.add(this._line([a, [c[0], a[1]], c, [a[0], c[1]]], prev, { closed: true }));
      }
      if (pts.length === 1 && (t === 'circle' || t === 'polygon')) {
        const r = d2(pts[0].p, c);
        if (t === 'circle') g.add(this._line(sampleGeom({ type: 'circle', c: pts[0].p, r }), prev));
        else {
          const n = this.polySides, a0 = Math.atan2(c[1] - pts[0].p[1], c[0] - pts[0].p[0]);
          const ring = [];
          for (let i = 0; i < n; i++) ring.push([pts[0].p[0] + r * Math.cos(a0 + (i / n) * TAU), pts[0].p[1] + r * Math.sin(a0 + (i / n) * TAU)]);
          g.add(this._line(ring, prev, { closed: true }));
        }
        g.add(this._line([pts[0].p, c], prev, { dashed: true }));
      }
      if (t === 'slot' && pts.length) {
        const A = pts[0].p, B = pts.length > 1 ? pts[1].p : c;
        const r = pts.length > 1 ? Math.abs(((c[0] - A[0]) * -(B[1] - A[1]) + (c[1] - A[1]) * (B[0] - A[0])) / (d2(A, B) || 1)) : Math.max(d2(A, B) * 0.15, this.px() * 4);
        g.add(this._line(slotOutline(A, B, r), prev, { closed: true }));
      }
      if (t === 'arc3' && pts.length) {
        if (pts.length === 1) g.add(this._line([pts[0].p, c], prev, { dashed: true }));
        else {
          const cc = circumcenter(pts[0].p, pts[1].p, c);
          if (cc) g.add(this._line(arcThrough(cc, pts[0].p, pts[1].p, c), prev));
        }
      }
      if (t === 'circle3' && pts.length) {
        if (pts.length === 1) g.add(this._line([pts[0].p, c], prev, { dashed: true }));
        else { const cc = circumcenter(pts[0].p, pts[1].p, c); if (cc) g.add(this._line(sampleGeom({ type: 'circle', c: cc, r: d2(cc, c) }), prev)); }
      }
      if (t === 'ellipse' && pts.length) {
        const C = pts[0].p;
        if (pts.length === 1) g.add(this._line([[2 * C[0] - c[0], 2 * C[1] - c[1]], c], prev, { dashed: true }));
        else {
          const A = pts[1].p;
          const e = { c: C, rx: d2(C, A), ry: ellipseMinorThrough(C, A, c), rot: Math.atan2(A[1] - C[1], A[0] - C[0]) };
          g.add(this._line(sampleGeom({ type: 'ellipse', ...e }, 96), prev), this._line([[2 * C[0] - A[0], 2 * C[1] - A[1]], A], prev, { dashed: true }));
        }
      }
      if (t === 'arcc' && pts.length) {
        const C = pts[0].p;
        if (pts.length === 1) g.add(this._line([C, c], prev, { dashed: true }));
        else {
          const r = d2(C, pts[1].p), a0 = Math.atan2(pts[1].p[1] - C[1], pts[1].p[0] - C[0]);
          const sw = normAng(Math.atan2(c[1] - C[1], c[0] - C[0]) - a0) || TAU;
          g.add(this._line(sampleGeom({ type: 'arc', c: C, r, a0, sweep: sw }), prev));
        }
      }
    }
    if (t === 'dim' && this.picks.length) {
      const dim = this._dimFromPicks(this.picks, c);
      if (dim) {
        const anchor = this.dimAnchor(dim);
        this._drawDim(g, { ...dim, off: sub2(c, anchor) }, COLORS.skPrev);
      }
    }
  }

  _drawDims(g) {
    for (const d of this.sk.dims) {
      const sel = this.sel.has(`d:${d.id}`);
      this._drawDim(g, d, this.failed?.has(d.id) ? 0xf0525b : sel ? COLORS.select : COLORS.skDim);
    }
  }

  _drawDim(g, d, color) {
    const anchor = this.dimAnchor(d);
    const L = add2(anchor, d.off || [0, 0]);
    const P = (id) => this.P(id), G = (id) => this.geomOf(id);
    const arrow = (tip, dir) => {
      const s = this.px() * 7, n = [-dir[1], dir[0]];
      return this._line([add2(add2(tip, mul2(dir, -s)), mul2(n, s * 0.35)), tip, add2(add2(tip, mul2(dir, -s)), mul2(n, -s * 0.35))], color);
    };
    try {
      if (['distance', 'length', 'hdist', 'vdist'].includes(d.type)) {
        const gl = d.type === 'length' && d.line ? G(d.line) : { a: P(d.a), b: P(d.b) };
        const A = gl.a, B = gl.b;
        let a2, b2;
        if (d.type === 'hdist') { a2 = [A[0], L[1]]; b2 = [B[0], L[1]]; }
        else if (d.type === 'vdist') { a2 = [L[0], A[1]]; b2 = [L[0], B[1]]; }
        else {
          const dir = unit2(sub2(B, A)), n = [-dir[1], dir[0]];
          const h = (L[0] - A[0]) * n[0] + (L[1] - A[1]) * n[1];
          a2 = add2(A, mul2(n, h)); b2 = add2(B, mul2(n, h));
        }
        g.add(this._line([A, a2], color), this._line([B, b2], color), this._line([a2, b2], color));
        const dd = unit2(sub2(b2, a2));
        if (d2(a2, b2) > 1e-9) g.add(arrow(a2, mul2(dd, -1)), arrow(b2, dd));
      } else if (d.type === 'axis') {
        // an aligned dimension between the two ends of the axis
        const ge = G(d.curve), t = d.which === 'minor' ? Math.PI / 2 : 0;
        const A = ellipsePoint(ge, t), B = ellipsePoint(ge, t + Math.PI);
        const dir = unit2(sub2(B, A)), n = [-dir[1], dir[0]];
        const h = (L[0] - A[0]) * n[0] + (L[1] - A[1]) * n[1];
        const a2 = add2(A, mul2(n, h)), b2 = add2(B, mul2(n, h));
        // the dimension line runs on to the label when it sits beyond either end
        const s = (L[0] - a2[0]) * dir[0] + (L[1] - a2[1]) * dir[1], len = d2(a2, b2);
        const e0 = s < 0 ? add2(a2, mul2(dir, s)) : a2, e1 = s > len ? add2(a2, mul2(dir, s)) : b2;
        g.add(this._line([A, a2], color), this._line([B, b2], color), this._line([e0, e1], color), arrow(a2, mul2(dir, -1)), arrow(b2, dir));
      } else if (d.type === 'radius' || d.type === 'diameter') {
        const gc = G(d.curve);
        const dir = unit2(sub2(L, gc.c));
        const rim = add2(gc.c, mul2(dir, gc.r));
        g.add(this._line([d.type === 'diameter' ? sub2(gc.c, mul2(dir, gc.r)) : gc.c, L], color), arrow(rim, dir));
        if (d.type === 'diameter') g.add(arrow(sub2(gc.c, mul2(dir, gc.r)), mul2(dir, -1)));
      } else if (d.type === 'pointLine' || d.type === 'lineDist') {
        const q = d.type === 'pointLine' ? P(d.p) : G(d.l2).a;
        const gl = d.type === 'pointLine' ? G(d.line) : G(d.l1);
        const f = footInf(q, gl.a, gl.b);
        g.add(this._line([q, f], color));
        const dir = unit2(sub2(f, q));
        if (d2(q, f) > 1e-9) g.add(arrow(f, dir), arrow(q, mul2(dir, -1)));
      } else if (d.type === 'angle') {
        const X = lineIntersect(G(d.l1), G(d.l2));
        if (X) {
          const r = d2(L, X);
          const g1 = G(d.l1), g2 = G(d.l2);
          let a1 = Math.atan2(g1.b[1] - g1.a[1], g1.b[0] - g1.a[0]);
          if ((d.sign || 1) < 0) a1 = Math.atan2(g2.b[1] - g2.a[1], g2.b[0] - g2.a[0]);
          const sw = (this.measure(d) * Math.PI) / 180;
          g.add(this._line(sampleGeom({ type: 'arc', c: X, r, a0: a1, sweep: sw }), color));
        }
      }
    } catch { /* referenced geometry missing */ }
  }

  // ---------- HTML labels: dimension values and constraint glyphs ----------
  _screenOf(p) {
    const v = this.w(p).project(this.vp.camera);
    return [((v.x + 1) / 2) * this.vp.el.clientWidth, ((1 - v.y) / 2) * this.vp.el.clientHeight];
  }

  _renderLabels() {
    const root = this.labelRoot;
    const items = [];
    for (const d of this.sk.dims) {
      const v = this.measure(d);
      const num = /^-?[\d.]+$/.test(String(d.expr).trim());
      const pre = d.type === 'diameter' ? '⌀' : d.type === 'radius' ? 'R' : '';
      const unit = d.type === 'angle' ? '°' : '';
      const shown = d.type === 'angle' ? Math.abs(v) : Math.abs(v) / (this.ui.units?.().scale || 1);
      const txt = num ? `${pre}${fmt(shown)}${unit}` : `${pre}${d.expr} = ${fmt(shown)}${unit}`;
      items.push({ key: `d:${d.id}`, cls: `sk-dim ${this.sel.has(`d:${d.id}`) ? 'sel' : ''} ${this.failed?.has(d.id) ? 'bad' : ''}`, html: txt, at: add2(this.dimAnchor(d), d.off || [0, 0]), dim: d.id });
    }
    if (this.showConstraints) {
      const count = new Map();
      for (const k of this.sk.constraints) {
        const at = this._glyphAnchor(k);
        if (!at) continue;
        const n = count.get(at.key) || 0;
        count.set(at.key, n + 1);
        items.push({ key: `k:${k.id}`, cls: `sk-glyph ${this.sel.has(`k:${k.id}`) ? 'sel' : ''} ${this.failed?.has(k.id) ? 'bad' : ''}`, html: GLYPH[k.type] || '?', at: at.p, shift: n, title: k.type });
      }
    }
    this._labels = items;
    root.innerHTML = items.map((it, i) => `<div class="${it.cls}" data-i="${i}" title="${it.title || 'Double-click to edit'}">${it.html}</div>`).join('');
    root.querySelectorAll('[data-i]').forEach((el) => {
      const it = items[+el.dataset.i];
      el.onmousedown = (e) => e.stopPropagation();
      el.onclick = (e) => { e.stopPropagation(); this.selectLabel(it.key, e); };
      if (it.dim) el.ondblclick = (e) => { e.stopPropagation(); this.editDim(it.dim); };
    });
    this._placeLabels();
  }

  _glyphAnchor(k) {
    const G = (id) => (id ? this.geomOf(id) : null);
    const mid = (g) => (g.type === 'line' ? [(g.a[0] + g.b[0]) / 2, (g.a[1] + g.b[1]) / 2] : g.type === 'circle' ? [g.c[0] + g.r * 0.7, g.c[1] + g.r * 0.7] : g.type === 'arc' ? [g.c[0] + g.r * Math.cos(g.a0 + g.sweep / 2), g.c[1] + g.r * Math.sin(g.a0 + g.sweep / 2)] : g.pts?.[0]);
    try {
      if (k.line && !k.p) { const g = G(k.line); return g && !g.virtual ? { p: mid(g), key: k.line } : null; }
      if (k.l2) { const g = G(k.l2); return g && !g.virtual ? { p: mid(g), key: k.l2 } : null; }
      if (k.c2) { const g = G(k.c2); return g ? { p: mid(g), key: k.c2 } : null; }
      if (k.p) { const q = this.P(k.p); return q ? { p: q, key: k.p } : null; }
      if (k.a && k.b) { const q = this.P(k.b); return q ? { p: q, key: k.b } : null; }
    } catch { /* ignore */ }
    return null;
  }

  _placeLabels() {
    if (!this._labels) return;
    const els = this.labelRoot.children;
    this._labels.forEach((it, i) => {
      const el = els[i];
      if (!el) return;
      const [x, y] = this._screenOf(it.at);
      const dx = it.cls.startsWith('sk-glyph') ? 10 + (it.shift || 0) * 15 : 0;
      el.style.transform = `translate(${x + dx}px, ${y + (it.cls.startsWith('sk-glyph') ? -18 : 0)}px)`;
    });
  }

  // ======================================================================== toolbar + inspector
  _renderUI() {
    this._renderToolbar();
    this._renderInspector();
  }

  _renderToolbar() {
    const tb = this.ui.toolbar;
    if (!tb) return;
    const btn = ([t, label, ic, key]) => `<button class="tbtn sk ${this.tool === t ? 'on' : ''}" data-tool="${t}" data-tip="${label}" data-key="${key || ''}">${icon(ic)}<span>${label.replace('3-Point ', '3pt ').replace('Center ', 'C. ')}</span></button>`;
    tb.innerHTML = `
      <div class="tgroup"><span class="gname">Select</span><button class="tbtn sk ${this.tool === 'select' ? 'on' : ''}" data-tool="select" data-tip="Select & drag" data-key="Esc">${icon('pointer')}<span>Select</span></button></div>
      <div class="tgroup"><span class="gname">Create</span>${CREATE_TOOLS.map(btn).join('')}</div>
      <div class="tgroup"><span class="gname">Modify</span>${MODIFY_TOOLS.map(btn).join('')}</div>
      <div class="tgroup"><span class="gname">Constrain</span><div class="cgrid">${CONSTRAINTS.map(([t, label, g]) => `<button class="cbtn ${this.tool === `c:${t}` ? 'on' : ''}" data-tool="c:${t}" data-tip="${label}">${g}</button>`).join('')}</div></div>
      <div class="tb-right">
        <button class="btn ghost sm" data-act="cancel">${icon('close')} Cancel</button>
        <button class="btn sketch" data-act="finish">${icon('finish')} Finish Sketch</button>
      </div>`;
    tb.querySelectorAll('[data-tool]').forEach((b) => (b.onclick = () => this.setTool(b.dataset.tool)));
    tb.querySelector('[data-act=cancel]').onclick = () => this.end(false);
    tb.querySelector('[data-act=finish]').onclick = () => this.end(true);
  }

  _renderInspector() {
    const el = this.ui.inspector;
    if (!el) return;
    const st = this.status;
    const bad = this.failed?.size;
    const dof = st?.dof ?? 0;
    const selPts = [...this.sel].filter((k) => k[0] === 'p').map((k) => this.sk.points.find((p) => p.id === k.slice(2))).filter(Boolean);
    const selCurves = [...this.sel].filter((k) => k[0] === 'c').map((k) => this.sk.curves.find((c) => c.id === k.slice(2))).filter(Boolean);
    const u = this.ui.units?.() || { label: 'mm', scale: 1 };
    let selHtml = '';
    if (selPts.length === 1) {
      const p = selPts[0];
      selHtml = `<div class="insp-sec"><h4>Point</h4>
        <div class="field"><label>X</label><div class="num"><input class="input" data-pp="x" value="${fmt(p.x / u.scale)}"><span class="unit">${u.label}</span></div></div>
        <div class="field"><label>Y</label><div class="num"><input class="input" data-pp="y" value="${fmt(p.y / u.scale)}"><span class="unit">${u.label}</span></div></div>
        <div class="field check"><label>Fixed</label><label class="switch"><input type="checkbox" data-fix ${p.fixed ? 'checked' : ''}><span></span></label></div></div>`;
    } else if (this.sel.size) {
      selHtml = `<div class="insp-sec"><h4>Selection</h4><p class="muted">${this.sel.size} item${this.sel.size > 1 ? 's' : ''} selected${selCurves.length ? ` · ${selCurves.length} curve${selCurves.length > 1 ? 's' : ''}` : ''}. Pick a constraint in the toolbar to apply it.</p>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${selCurves.length ? `<button class="btn sm" data-act="construction">${icon('construction')} Toggle construction</button>` : ''}<button class="btn sm danger" data-act="delete">${icon('trash')} Delete</button></div></div>`;
    }
    const counts = `${this.sk.curves.filter((c) => !c.construction).length} curves · ${this.sk.constraints.length} constraints · ${this.sk.dims.length} dimensions`;
    el.innerHTML = `
      <div class="panel-head" style="--accent: var(--sketch)">${icon('sketch')}<h3>${this.name || 'Sketch'}<small>Sketch · ${counts}</small></h3></div>
      <div class="panel-body"><div class="insp">
        <div class="sk-status ${bad ? 'bad' : dof === 0 ? 'ok' : ''}">
          <div class="ring">${bad ? '!' : dof === 0 ? '✓' : dof}</div>
          <div><b>${bad ? 'Conflicting constraints' : dof === 0 ? 'Fully constrained' : `${dof} degree${dof > 1 ? 's' : ''} of freedom`}</b><small>${bad ? 'Remove the highlighted constraint or dimension' : dof === 0 ? 'Geometry is completely defined' : 'Add dimensions or constraints to define the sketch'}</small></div>
        </div>
        <div class="legend"><span><i style="background:#${COLORS.skFull.toString(16).padStart(6, '0')}"></i>Defined</span><span><i style="background:#${COLORS.skFree.toString(16).padStart(6, '0')}"></i>Free</span><span><i style="background:#${COLORS.skConstr.toString(16).padStart(6, '0')}"></i>Construction</span><span><i style="background:#${COLORS.skFixed.toString(16).padStart(6, '0')}"></i>Fixed</span></div>
        ${selHtml}
        <div class="insp-sec"><h4>Options</h4>
          <div class="field check"><label>Construction mode <kbd>X</kbd></label><label class="switch"><input type="checkbox" data-opt="construction" ${this.construction ? 'checked' : ''}><span></span></label></div>
          <div class="field check"><label>Show constraints</label><label class="switch"><input type="checkbox" data-opt="glyphs" ${this.showConstraints ? 'checked' : ''}><span></span></label></div>
          ${this.tool === 'fillet' ? `<div class="field"><label>Fillet radius</label><div class="num"><input class="input" data-tv="filletR" value="${fmt(this.filletR / u.scale)}"><span class="unit">${u.label}</span></div></div>` : ''}
          ${this.tool === 'offset' ? `<div class="field"><label>Offset distance</label><div class="num"><input class="input" data-tv="offsetD" value="${fmt(this.offsetD / u.scale)}"><span class="unit">${u.label}</span></div></div>` : ''}
          ${this.tool === 'polygon' ? `<div class="field"><label>Sides</label><input class="input" data-tv="polySides" value="${this.polySides}"></div>` : ''}
        </div>
        <div class="insp-sec"><h4>${icon('info')} ${this._toolName()}</h4><div class="help">${this._help()}</div></div>
      </div></div>
      <div class="panel-foot"><button class="btn ghost sm" data-act="undo">${icon('undo')} Undo</button><button class="btn ghost sm" data-act="redo">${icon('redo')} Redo</button><span class="spacer"></span><button class="btn sketch sm" data-act="finish">${icon('finish')} Finish</button></div>`;
    const act = (a, fn) => el.querySelectorAll(`[data-act=${a}]`).forEach((b) => (b.onclick = fn));
    act('construction', () => this.toggleConstruction());
    act('delete', () => this.deleteSelected());
    act('undo', () => this.undo());
    act('redo', () => this.redo());
    act('finish', () => this.end(true));
    el.querySelectorAll('[data-opt]').forEach((inp) => (inp.onchange = () => {
      if (inp.dataset.opt === 'construction') { this.construction = inp.checked; }
      else { this.showConstraints = inp.checked; this.redraw(); }
      this._renderUI();
    }));
    el.querySelectorAll('[data-tv]').forEach((inp) => (inp.onchange = () => {
      let v;
      try { v = evaluate(inp.value, this.ui.vars()); } catch { inp.classList.add('bad'); return; }
      const k = inp.dataset.tv;
      if (k === 'polySides') this.polySides = Math.max(3, Math.min(64, Math.round(v)));
      else if (v > 0) this[k] = v * u.scale;
      this._renderUI();
    }));
    el.querySelector('[data-fix]')?.addEventListener('change', (e) => {
      const p = selPts[0];
      this.commitChange((sk) => { const q = sk.points.find((x) => x.id === p.id); if (q) q.fixed = e.target.checked; });
    });
    el.querySelectorAll('[data-pp]').forEach((inp) => {
      inp.onchange = () => {
        let v;
        try { v = evaluate(inp.value, this.ui.vars()) * u.scale; } catch { inp.classList.add('bad'); return; }
        const p = selPts[0];
        const target = inp.dataset.pp === 'x' ? [v, p.y] : [p.x, v];
        this.snapshot();
        this.solve([{ point: p.id, target }]);
        this.solve();
        this._renderUI();
      };
    });
    this.ui.onRender?.();
  }

  // a length in mm written as an expression in document units
  _ex(mm) { return fmt(mm / (this.ui.units?.().scale || 1)); }

  _toolName() {
    const all = [...CREATE_TOOLS, ...MODIFY_TOOLS, ['select', 'Select']];
    if (this.tool.startsWith('c:')) return (CONSTRAINTS.find(([t]) => t === this.tool.slice(2)) || [])[1] + ' constraint';
    return (all.find(([t]) => t === this.tool) || [, 'Tool'])[1];
  }

  _help() {
    const t = this.tool;
    if (t.startsWith('c:')) {
      return {
        coincident: 'Pick two points, or a point and a curve.', horizontal: 'Pick a line, or two points.', vertical: 'Pick a line, or two points.',
        parallel: 'Pick two lines.', perpendicular: 'Pick two lines.', tangent: 'Pick a line and an arc/circle, or two arcs/circles.',
        equal: 'Pick two lines (equal length) or two arcs/circles (equal radius).', midpoint: 'Pick a point and a line.',
        concentric: 'Pick two arcs/circles.', collinear: 'Pick two lines.', symmetric: 'Pick two points, then the symmetry line.', fix: 'Click points to lock or unlock them.',
      }[t.slice(2)] + ' You can also select geometry first and then click the constraint.';
    }
    return {
      select: 'Click to select, drag points or curves to move them (constraints are kept). <kbd>Del</kbd> deletes, double-click a dimension to edit it. Blue = free, white/black = fully constrained.',
      line: 'Click points; click the first point to close. Snaps to points, midpoints and curves, and adds horizontal/vertical constraints automatically. Type a length for a driving dimension.',
      rect: 'Click two opposite corners. Type <kbd>W</kbd> <kbd>Tab</kbd> <kbd>H</kbd> for dimensions.',
      crect: 'Click the center, then a corner.',
      circle: 'Click the center, then a point on the circle. Type a diameter.',
      arc3: 'Click the start point, the end point, then a point the arc passes through.',
      arcc: 'Click the center, the start point, then the end point (counter-clockwise).',
      polygon: 'Click the center, then a vertex. Type the number of sides (N).',
      slot: 'Click both end centers, then set the width.',
      spline: 'Click fit points; click the first point to close, or press Enter.',
      point: 'Click to place sketch points (for holes, references, constraints).',
      dim: 'Click a line, circle or arc — or two entities (points, lines, axes) — then click to place and type a value or a parameter expression.',
      fillet: `Click a corner shared by two lines. Radius: <b>${fmt(this.filletR)}</b> (type a number to change).`,
      trim: 'Click the part of a curve to remove. It is cut back to the nearest intersections.',
      offset: `Click a curve to offset its connected chain toward the cursor. Distance: <b>${fmt(this.offsetD)}</b> (type to change).`,
      mirror: 'Select curves first, then use Mirror and click the mirror line or a sketch axis.',
      project: 'Click edges of existing bodies to project them into the sketch as fixed reference geometry.',
      circle3: 'Click three points the circle passes through.',
      ellipse: 'Click the center, the end of the long axis, then a point the ellipse passes through. Type <kbd>A</kbd> <kbd>Tab</kbd> <kbd>B</kbd> for the axis lengths.',
      lpattern: `Click where the first copy goes (the step from the selection), or type the spacing and angle. Copies: <b>${this.pat.n}</b> in total (type <kbd>N</kbd> to change).`,
      cpattern: `Click the centre of the pattern (snaps to points). <b>${this.pat.n}</b> in total over <b>${fmt(this.pat.total)}°</b> (type <kbd>N</kbd> and the total angle to change).`,
    }[t] || '';
  }
}

// ---------- 2D helpers ----------
function circumcenter(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] * a[0] + a[1] * a[1], b2 = b[0] * b[0] + b[1] * b[1], c2 = c[0] * c[0] + c[1] * c[1];
  return [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
}
function arcThrough(c, s, e, m) {
  const r = d2(c, s), a0 = Math.atan2(s[1] - c[1], s[0] - c[0]);
  const sw = normAng(Math.atan2(e[1] - c[1], e[0] - c[0]) - a0), sm = normAng(Math.atan2(m[1] - c[1], m[0] - c[0]) - a0);
  return sm < sw ? sampleGeom({ type: 'arc', c, r, a0, sweep: sw }) : sampleGeom({ type: 'arc', c, r, a0: a0 + sw, sweep: TAU - sw });
}
function slotOutline(A, B, r) {
  const ang = Math.atan2(B[1] - A[1], B[0] - A[0]);
  const out = [];
  for (let i = 0; i <= 16; i++) { const t = ang - Math.PI / 2 + (Math.PI * i) / 16; out.push([B[0] + r * Math.cos(t), B[1] + r * Math.sin(t)]); }
  for (let i = 0; i <= 16; i++) { const t = ang + Math.PI / 2 + (Math.PI * i) / 16; out.push([A[0] + r * Math.cos(t), A[1] + r * Math.sin(t)]); }
  return out;
}
function footInf(q, a, b) {
  const d = sub2(b, a), l2 = d[0] * d[0] + d[1] * d[1] || 1;
  const t = ((q[0] - a[0]) * d[0] + (q[1] - a[1]) * d[1]) / l2;
  return [a[0] + d[0] * t, a[1] + d[1] * t];
}
function distToLineInf(q, a, b) { return d2(q, footInf(q, a, b)); }
function lineIntersect(g1, g2) {
  const d1 = sub2(g1.b, g1.a), d2v = sub2(g2.b, g2.a);
  const den = d1[0] * d2v[1] - d1[1] * d2v[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((g2.a[0] - g1.a[0]) * d2v[1] - (g2.a[1] - g1.a[1]) * d2v[0]) / den;
  return [g1.a[0] + d1[0] * t, g1.a[1] + d1[1] * t];
}
function catmull(pts) {
  const n = pts.length, get = (i) => pts[Math.max(0, Math.min(n - 1, i))];
  const segs = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    segs.push([p1, [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6], p2]);
  }
  return segs;
}

// ---------- offset helpers ----------
function sideOf(g, fwd, p) {
  // +1 when p is on the left of the oriented curve
  if (g.type === 'line') {
    const [a, b] = fwd ? [g.a, g.b] : [g.b, g.a];
    return ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) >= 0 ? 1 : -1;
  }
  const inside = d2(p, g.c) < g.r;
  // ccw arc: left side is inside
  return (inside ? 1 : -1) * (fwd ? 1 : -1);
}
function offsetElem(g, fwd, off) {
  if (g.type === 'line') {
    const [a, b] = fwd ? [g.a, g.b] : [g.b, g.a];
    const d = unit2(sub2(b, a)), n = [-d[1] * off, d[0] * off];
    return { type: 'line', start: add2(a, n), end: add2(b, n), a: add2(a, n), b: add2(b, n) };
  }
  // left offset of a ccw arc shrinks it
  const ccw = fwd;
  const r = g.r + (ccw ? -off : off);
  if (r <= 1e-6) return null;
  const s0 = fwd ? g.a0 : g.a0 + g.sweep, s1 = fwd ? g.a0 + g.sweep : g.a0;
  return { type: 'arc', c: g.c, r, ccw, start: [g.c[0] + r * Math.cos(s0), g.c[1] + r * Math.sin(s0)], end: [g.c[0] + r * Math.cos(s1), g.c[1] + r * Math.sin(s1)] };
}
function joinPoint(e1, e2) {
  // intersection of the two offset elements nearest to where they nominally meet
  const guess = [(e1.end[0] + e2.start[0]) / 2, (e1.end[1] + e2.start[1]) / 2];
  const big = (e) => (e.type === 'line' ? { type: 'line', a: add2(e.a, mul2(sub2(e.a, e.b), 50)), b: add2(e.b, mul2(sub2(e.b, e.a), 50)) } : { type: 'circle', c: e.c, r: e.r });
  const hits = intersect(big(e1), big(e2), 1e-6);
  if (!hits.length) return guess;
  return hits.sort((a, b) => d2(a.p, guess) - d2(b.p, guess))[0].p;
}
