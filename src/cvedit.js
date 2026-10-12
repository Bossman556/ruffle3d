// Free-form NURBS editing: draw 3D CV curves and drag the control vertices of CV curves and CV surfaces.
import * as THREE from 'three';
import { curvePoints, surfaceIsolines } from './nurbs.js';
import { COLORS } from './viewport.js';
import { icon } from './icons.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const r3 = (v) => Math.round(v * 1000) / 1000;
const AX = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
const CURVE_COLOR = 0xe46ee8;

export class CVEditor {
  constructor(app) {
    this.app = app;
    this.vp = app.vp;
    this.group = new THREE.Group();
    this.group.renderOrder = 20;
    this.vp.scene.add(this.group);
    this.active = false;
    this.s = null;
  }

  // ---------- lifecycle ----------
  startDraw() {
    this.s = { kind: 'draw', pts: [], degree: 3, closed: false, plane: this.s?.plane || 'auto', offset: this.s?.offset || 0, snap: this.s?.snap ?? true, sel: new Set(), cursor: null };
    this.active = true;
    this.app.banner('CV Curve — click to place control vertices · Enter to finish · Backspace removes the last', () => this.app.exitMode());
    this.render();
  }

  startEdit(fid) {
    const f = this.app.doc.features.find((x) => x.id === fid);
    if (!f) return false;
    if (f.type === 'cvcurve') {
      this.s = { kind: 'curve', fid, pts: structuredClone(f.p.cvs || []), degree: +f.p.degree || 3, closed: !!f.p.closed, sel: new Set(), axis: this.s?.axis || 'view' };
    } else if (f.type === 'cvsurface') {
      const g = (this.app.result.cvgrids || []).find((x) => x.id === fid);
      if (!g) { this.app.toast('This CV surface has not been built yet', 'warn'); return false; }
      this.s = { kind: 'surface', fid, pts: structuredClone(g.poles), nu: g.nu, nv: g.nv, du: g.du, dv: g.dv, uk: g.uk, um: g.um, vk: g.vk, vm: g.vm, w: g.w, trims: g.trims, exact: g.exact, sel: new Set(), axis: this.s?.axis || 'view' };
    } else return false;
    this.active = true;
    this.app.banner(`Editing CVs of ${esc(f.name)} — drag CVs · Shift-click to add to the selection`, () => this.app.exitMode());
    this.render();
    return true;
  }

  stop() {
    this.active = false;
    this.drag = null;
    this.group.clear();
    this.vp.requestRender();
  }

  // Re-reads CVs from the document after a rebuild (undo / redo / numeric edits).
  resync() {
    const s = this.s;
    if (!this.active || this.drag || !s || s.kind === 'draw') return;
    const f = this.feature();
    if (!f) return this.app.exitMode();
    if (s.kind === 'curve') { s.pts = structuredClone(f.p.cvs || []); s.degree = +f.p.degree || 3; s.closed = !!f.p.closed; }
    else {
      const g = (this.app.result.cvgrids || []).find((x) => x.id === s.fid);
      if (g) Object.assign(s, { pts: structuredClone(g.poles), nu: g.nu, nv: g.nv, du: g.du, dv: g.dv, uk: g.uk, um: g.um, vk: g.vk, vm: g.vm, w: g.w, trims: g.trims, exact: g.exact });
    }
    s.sel = new Set([...s.sel].filter((i) => i < s.pts.length));
    this.render();
    if (!(document.activeElement instanceof HTMLInputElement)) this.app.renderRight();
  }

  feature() { return this.app.doc.features.find((x) => x.id === this.s?.fid); }

  // ---------- geometry helpers ----------
  rect() { return this.vp.renderer.domElement.getBoundingClientRect(); }
  screenOf(p) {
    const v = new THREE.Vector3(...p).project(this.vp.camera), r = this.rect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height, v.z];
  }
  nearestCV(ev, px = 11) {
    let best = -1, bd = px;
    this.s.pts.forEach((p, i) => {
      const [x, y, z] = this.screenOf(p);
      if (z > 1) return;
      const d = Math.hypot(x - ev.clientX, y - ev.clientY);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }
  camDir() { return this.vp.camera.getWorldDirection(new THREE.Vector3()); }
  // Drawing plane for new CVs: a principal plane, the view plane (through the last CV), or a construction plane,
  // each optionally offset along its normal.
  constructionPlanes() { return (this.app.result.planes || []).map((pl) => ({ id: pl.id, name: this.app.doc.features.find((f) => f.id === pl.id)?.name || 'Plane', plane: pl.plane })); }
  drawPlane() {
    const s = this.s;
    let key = s.plane, n, o = new THREE.Vector3(), label;
    if (key === 'auto') {
      const d = this.camDir();
      const a = [Math.abs(d.x), Math.abs(d.y), Math.abs(d.z)];
      // the ground plane unless the view is close to horizontal, then the upright plane facing the camera
      key = a[2] >= 0.35 ? 'XY' : a[1] >= a[0] ? 'XZ' : 'YZ';
    }
    if (key === 'view') {
      n = this.camDir().negate();
      const last = s.pts[s.pts.length - 1];
      o = last ? new THREE.Vector3(...last) : this.vp.controls.target.clone();
      label = 'view plane';
    } else if (key.startsWith('plane:')) {
      const cp = this.constructionPlanes().find((x) => `plane:${x.id}` === key);
      if (cp) { n = new THREE.Vector3(...cp.plane.normal); o = new THREE.Vector3(...cp.plane.origin); label = cp.name; }
      else key = 'XY';
    }
    if (!n) { n = new THREE.Vector3(...{ XY: [0, 0, 1], XZ: [0, 1, 0], YZ: [1, 0, 0] }[key]); label = `${key} plane`; }
    n.normalize();
    const off = (+s.offset || 0) * this.app.units.scale;
    const origin = o.clone().addScaledVector(n, off);
    return { key, label, normal: n, origin, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(n, origin) };
  }
  pointFrom(ev) {
    const hit = this.s.onFaces !== false ? this.vp.pick(ev, new Set(['face'])) : null;
    if (hit?.point) { this.s.onFace = true; return hit.point.map(r3); }
    this.s.onFace = false;
    const ray = this.vp._setRay(ev);
    const dp = this.drawPlane();
    const q = ray.intersectPlane(dp.plane, new THREE.Vector3());
    if (!q) return null;
    if (!this.s.snap) return q.toArray().map(r3);
    // snap in the plane's own grid so off-axis planes snap correctly too
    const step = this.app.units.scale;
    const n = dp.normal, x = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const u = x.sub(n.clone().multiplyScalar(x.dot(n))).normalize(), v = n.clone().cross(u);
    const d = q.clone().sub(dp.origin);
    const a = Math.round(d.dot(u) / step) * step, b = Math.round(d.dot(v) / step) * step;
    return dp.origin.clone().addScaledVector(u, a).addScaledVector(v, b).toArray().map(r3);
  }
  // local surface normal at grid index (from neighbouring CVs)
  gridNormal(i) {
    const { nu, nv, pts } = this.s;
    const u = Math.floor(i / nv), v = i % nv;
    const P = (a, b) => new THREE.Vector3(...pts[Math.max(0, Math.min(nu - 1, a)) * nv + Math.max(0, Math.min(nv - 1, b))]);
    const du = P(u + 1, v).sub(P(u - 1, v)), dv = P(u, v + 1).sub(P(u, v - 1));
    const n = du.cross(dv);
    return n.lengthSq() > 1e-12 ? n.normalize() : new THREE.Vector3(0, 0, 1);
  }

  // ---------- display ----------
  render() {
    const g = this.group;
    g.clear();
    if (!this.active) return this.vp.requestRender();
    const s = this.s;
    const pts = s.kind === 'draw' && s.cursor ? [...s.pts, s.cursor] : s.pts;
    const hullMat = new THREE.LineBasicMaterial({ color: 0x9aa4b2, transparent: true, opacity: 0.8, depthTest: false });
    if (s.kind === 'surface') {
      const seg = [];
      for (let i = 0; i < s.nu; i++) for (let j = 0; j < s.nv; j++) {
        const p = pts[i * s.nv + j];
        if (i + 1 < s.nu) seg.push(...p, ...pts[(i + 1) * s.nv + j]);
        if (j + 1 < s.nv) seg.push(...p, ...pts[i * s.nv + j + 1]);
      }
      const hull = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(seg, 3)), hullMat);
      hull.renderOrder = 20;
      g.add(hull);
      if (this.drag) {
        const iso = surfaceIsolines({ ...s, poles: pts }, 10, 32);
        g.add(this.vp._fatLine(iso, CURVE_COLOR, 1.5));
      }
    } else if (pts.length) {
      const hp = s.closed && pts.length > 2 ? [...pts, pts[0]] : pts;
      if (hp.length > 1) {
        const hull = new THREE.Line(new THREE.BufferGeometry().setFromPoints(hp.map((p) => new THREE.Vector3(...p))), new THREE.LineDashedMaterial({ color: 0x9aa4b2, dashSize: 1.5, gapSize: 1, depthTest: false }));
        hull.computeLineDistances();
        hull.renderOrder = 20;
        g.add(hull);
      }
      if (pts.length > 1) {
        const cp = curvePoints(pts, s.degree, s.closed, 200);
        const flat = [];
        for (let i = 0; i + 1 < cp.length; i++) flat.push(...cp[i], ...cp[i + 1]);
        g.add(this.vp._fatLine(flat, CURVE_COLOR, 2.5));
      }
    }
    // drawing-plane indicator around the cursor
    if (s.kind === 'draw' && s.cursor && !s.onFace) {
      const dp = this.drawPlane(), n = dp.normal;
      const x = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      const u = x.sub(n.clone().multiplyScalar(x.dot(n))).normalize(), v = n.clone().cross(u);
      const c = new THREE.Vector3(...s.cursor), R = this.vp.worldPerPixel(c) * 60, seg = [];
      for (let k = -3; k <= 3; k++) {
        const t = (k / 3) * R;
        seg.push(...c.clone().addScaledVector(u, t).addScaledVector(v, -R).toArray(), ...c.clone().addScaledVector(u, t).addScaledVector(v, R).toArray());
        seg.push(...c.clone().addScaledVector(v, t).addScaledVector(u, -R).toArray(), ...c.clone().addScaledVector(v, t).addScaledVector(u, R).toArray());
      }
      const gl = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(seg, 3)), new THREE.LineBasicMaterial({ color: COLORS.select, transparent: true, opacity: 0.35, depthTest: false }));
      gl.renderOrder = 19;
      g.add(gl);
    }
    // CV handles
    const col = [], pos = [];
    const sel = new THREE.Color(COLORS.select), hov = new THREE.Color(0xf2994a), nor = new THREE.Color(0xf4f6f8), first = new THREE.Color(0x3ecf8e);
    pts.forEach((p, i) => {
      pos.push(...p);
      const c = s.sel.has(i) ? sel : i === s.hover ? hov : i === 0 && s.kind !== 'surface' ? first : nor;
      col.push(c.r, c.g, c.b);
    });
    if (pos.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      const outline = new THREE.Points(geo, new THREE.PointsMaterial({ size: 11, sizeAttenuation: false, color: 0x101216, depthTest: false }));
      const dots = new THREE.Points(geo, new THREE.PointsMaterial({ size: 8, sizeAttenuation: false, vertexColors: true, depthTest: false }));
      outline.renderOrder = 21; dots.renderOrder = 22;
      g.add(outline, dots);
    }
    this.vp.requestRender();
  }

  // ---------- input ----------
  onHover(ev) {
    const s = this.s;
    if (s.kind === 'draw') { s.cursor = this.pointFrom(ev); return this.render(); }
    const h = this.nearestCV(ev);
    this.vp.renderer.domElement.style.cursor = h >= 0 ? 'move' : '';
    if (h !== s.hover) { s.hover = h; this.render(); }
  }

  onDown(ev) {
    const s = this.s;
    if (s.kind === 'draw') return;
    const i = this.nearestCV(ev);
    if (i < 0) {
      if (!ev.shiftKey && s.sel.size) { s.sel.clear(); this.render(); this.app.renderRight(); }
      return;
    }
    if (ev.shiftKey) { if (s.sel.has(i)) s.sel.delete(i); else s.sel.add(i); }
    else if (!s.sel.has(i)) s.sel = new Set([i]);
    const p0 = new THREE.Vector3(...s.pts[i]);
    let axis = null;
    if (AX[s.axis]) axis = new THREE.Vector3(...AX[s.axis]);
    if (s.axis === 'normal' && s.kind === 'surface') axis = this.gridNormal(i);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.camDir().negate(), p0);
    const ray = this.vp._setRay(ev);
    const hit0 = axis ? this.axisParam(ray, p0, axis) : ray.intersectPlane(plane, new THREE.Vector3());
    this.drag = { start: s.pts.map((p) => p.slice()), plane, p0, axis, hit0, moved: false };
    this.vp.controls.enabled = false;
    this.render();
    this.app.renderRight();
  }
  // parameter along an axis line (through p0) closest to the mouse ray
  axisParam(ray, p0, axis) {
    const w0 = ray.origin.clone().sub(p0), b = ray.direction.dot(axis), d = ray.direction.dot(w0), e = axis.dot(w0);
    const den = 1 - b * b;
    return den < 1e-9 ? 0 : (e - b * d) / den;
  }
  onDrag(ev) {
    const dr = this.drag, s = this.s;
    if (!dr || dr.hit0 == null) return;
    const ray = this.vp._setRay(ev);
    let delta;
    if (dr.axis) delta = dr.axis.clone().multiplyScalar(this.axisParam(ray, dr.p0, dr.axis) - dr.hit0);
    else {
      const q = ray.intersectPlane(dr.plane, new THREE.Vector3());
      if (!q) return;
      delta = q.sub(dr.hit0);
    }
    for (const i of s.sel) s.pts[i] = dr.start[i].map((v, k) => r3(v + delta.getComponent(k)));
    dr.moved = true;
    this.render();
  }
  onUp() {
    const dr = this.drag;
    this.drag = null;
    this.vp.controls.enabled = true;
    if (dr?.moved) { this.commit(); this.app.renderRight(); }
    this.render();
  }

  onClick(ev) {
    const s = this.s;
    if (s.kind !== 'draw') return;
    const p = this.pointFrom(ev);
    if (!p) return;
    const last = s.pts[s.pts.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]) < 1e-6) return;
    s.pts.push(p);
    this.render();
    this.app.renderRight();
  }

  onKey(e) {
    const s = this.s;
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
    if (typing) return false;
    if (s.kind === 'draw') {
      if (e.key === 'Enter') { e.preventDefault(); this.finishDraw(); return true; }
      if (e.key === 'Backspace') { e.preventDefault(); s.pts.pop(); this.render(); this.app.renderRight(); return true; }
      return false;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && s.kind === 'curve') { e.preventDefault(); this.deleteSelected(); return true; }
    if (e.key === 'Enter') { e.preventDefault(); this.app.exitMode(); return true; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); s.sel = new Set(s.pts.map((_, i) => i)); this.render(); this.app.renderRight(); return true; }
    return false;
  }

  // ---------- actions ----------
  finishDraw() {
    const s = this.s;
    if (s.pts.length < 2) return this.app.toast('Place at least two control vertices', 'warn');
    const cvs = s.pts.map((p) => p.map(r3));
    this.app.exitMode();
    this.app.addFeature('cvcurve', { cvs, degree: String(s.degree), closed: s.closed });
  }

  commit() {
    const s = this.s, f = this.feature();
    if (!f) return;
    this.app.snapshot();
    if (s.kind === 'curve') {
      f.p.cvs = s.pts.map((p) => p.map(r3));
      f.p.degree = String(s.degree);
      f.p.closed = s.closed;
    } else {
      const r6 = (v) => Math.round(v * 1e6) / 1e6;
      f.p.cv = {
        nu: s.nu, nv: s.nv, du: s.du, dv: s.dv, poles: s.pts.map((p) => p.map(r6)), edited: true,
        ...(s.uk ? { uk: s.uk, um: s.um, vk: s.vk, vm: s.vm } : {}), ...(s.w ? { w: s.w } : {}), ...(s.trims ? { trims: s.trims } : {}), ...(s.exact ? { exact: true } : {}),
      };
      f.p.nu = String(s.nu); f.p.nv = String(s.nv);
    }
    this.app.changed();
  }

  deleteSelected() {
    const s = this.s;
    if (!s.sel.size) return;
    if (s.pts.length - s.sel.size < 2) return this.app.toast('A curve needs at least two CVs', 'warn');
    s.pts = s.pts.filter((_, i) => !s.sel.has(i));
    s.sel.clear();
    this.commit();
    this.render();
    this.app.renderRight();
  }

  insertCV() {
    const s = this.s;
    const i = s.sel.size ? Math.max(...s.sel) : s.pts.length - 2;
    const j = s.closed ? (i + 1) % s.pts.length : Math.min(i + 1, s.pts.length - 1);
    if (i === j) return;
    const m = s.pts[i].map((v, k) => r3((v + s.pts[j][k]) / 2));
    s.pts.splice(i + 1, 0, m);
    s.sel = new Set([i + 1]);
    this.commit();
    this.render();
    this.app.renderRight();
  }

  // ---------- panel ----------
  panel() {
    const el = document.getElementById('right'), s = this.s, app = this.app;
    const u = app.units, f = this.feature();
    const segBtns = (attr, opts, cur) => `<div class="seg full" data-${attr}>${opts.map(([v, l]) => `<button data-v="${v}" class="${String(cur) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    let body = '';
    if (s.kind === 'draw') {
      body = `<div class="insp-sec">
          <div class="field"><label>Degree</label>${segBtns('deg', [[1, '1'], [2, '2'], [3, '3'], [5, '5']], s.degree)}</div>
          <div class="field check"><label>Closed (periodic)</label><label class="switch"><input type="checkbox" data-closed ${s.closed ? 'checked' : ''}><span></span></label></div>
          <div class="field stack"><label>Draw on</label>${segBtns('plane', [['auto', 'Auto'], ['XY', 'XY'], ['XZ', 'XZ'], ['YZ', 'YZ'], ['view', 'View']], s.plane.startsWith('plane:') ? '' : s.plane)}</div>
          ${this.constructionPlanes().length ? `<div class="field"><label>Construction plane</label><select class="input" data-cplane><option value="">—</option>${this.constructionPlanes().map((cp) => `<option value="plane:${cp.id}" ${s.plane === `plane:${cp.id}` ? 'selected' : ''}>${esc(cp.name)}</option>`).join('')}</select></div>` : ''}
          <div class="field"><label>Offset</label><div class="num"><input data-offset value="${s.offset || 0}"><span class="unit">${u.label}</span></div></div>
          <div class="field check"><label>Snap onto faces</label><label class="switch"><input type="checkbox" data-onfaces ${s.onFaces !== false ? 'checked' : ''}><span></span></label></div>
          <div class="field check"><label>Snap to ${u.label} grid</label><label class="switch"><input type="checkbox" data-snap ${s.snap ? 'checked' : ''}><span></span></label></div>
        </div>
        <div class="insp-sec"><div class="stat-grid"><div class="stat"><small>Control vertices</small><b>${s.pts.length}</b></div><div class="stat"><small>Spans</small><b>${Math.max(0, s.pts.length - Math.min(s.degree, Math.max(1, s.pts.length - 1)))}</b></div></div>
          <div class="help" style="margin-top:10px">Click in the view to place CVs on the <b>${esc(this.drawPlane().label)}</b>${s.offset ? ` offset ${s.offset} ${u.label}` : ''}${s.onFaces !== false ? ' (or on a face)' : ''}. Orbit between clicks to work in 3D. CVs pull the curve like magnets; the curve passes through the first and last CV.</div></div>`;
    } else {
      const n = s.sel.size, one = n === 1 ? s.pts[[...s.sel][0]] : null;
      const axes = [['view', 'View'], ['X', 'X'], ['Y', 'Y'], ['Z', 'Z'], ...(s.kind === 'surface' ? [['normal', 'Normal']] : [])];
      body = `<div class="insp-sec">
          <div class="stat-grid"><div class="stat"><small>${s.kind === 'surface' ? 'CV grid' : 'CVs'}</small><b>${s.kind === 'surface' ? `${s.nu} × ${s.nv}` : s.pts.length}</b></div><div class="stat"><small>Degree</small><b>${s.kind === 'surface' ? `${s.du} × ${s.dv}` : s.degree}</b></div></div>
          <div class="field stack" style="margin-top:10px"><label>Move along</label>${segBtns('axis', axes, s.axis)}</div>
        </div>
        <div class="insp-sec"><h4>Selection · ${n ? `${n} CV${n === 1 ? '' : 's'}` : 'none'}</h4>
          ${one ? `<div class="cv-xyz">${['X', 'Y', 'Z'].map((a, k) => `<div class="num"><span class="lab">${a}</span><input data-xyz="${k}" value="${+(one[k] / u.scale).toFixed(3)}"><span class="unit">${u.label}</span></div>`).join('')}</div>`
            : n ? `<div class="cv-xyz">${['X', 'Y', 'Z'].map((a, k) => `<div class="num"><span class="lab">Δ${a}</span><input data-dxyz="${k}" value="0"><span class="unit">${u.label}</span></div>`).join('')}</div>`
            : '<p class="muted" style="margin:0;font-size:12px">Click a CV to select it. Drag to move; Shift-click to select several.</p>'}
          <div class="stat-grid" style="margin-top:10px">
            <button class="btn sm" data-a="all">Select all</button><button class="btn sm" data-a="none" ${n ? '' : 'disabled'}>Clear</button>
            ${s.kind === 'surface' ? `<button class="btn sm" data-a="row" ${n ? '' : 'disabled'}>Select row</button><button class="btn sm" data-a="col" ${n ? '' : 'disabled'}>Select column</button>` : ''}
          </div></div>
        ${s.kind === 'curve' ? `<div class="insp-sec"><h4>Curve</h4>
          <div class="field"><label>Degree</label>${segBtns('deg', [[1, '1'], [2, '2'], [3, '3'], [5, '5']], s.degree)}</div>
          <div class="field check"><label>Closed (periodic)</label><label class="switch"><input type="checkbox" data-closed ${s.closed ? 'checked' : ''}><span></span></label></div>
          <div class="stat-grid"><button class="btn sm" data-a="insert">${icon('plus')}Insert CV</button><button class="btn sm danger" data-a="delete" ${n ? '' : 'disabled'}>${icon('trash')}Delete CV</button></div></div>` : ''}`;
    }
    el.innerHTML = `<div class="panel-head">${icon(s.kind === 'surface' ? 'cvsurface' : 'cvcurve')}<h3>${s.kind === 'draw' ? 'CV Curve' : 'Edit CVs'}<small>${s.kind === 'draw' ? 'Free-form 3D NURBS curve' : esc(f?.name || '')}</small></h3><button class="iconbtn" data-x>${icon('close')}</button></div>
      <div class="panel-body"><div class="insp">${body}</div></div>
      <div class="panel-foot">${s.kind === 'draw'
        ? `<button class="btn ghost" data-a="undo" ${s.pts.length ? '' : 'disabled'}>${icon('undo')}Undo CV</button><span class="spacer"></span><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-a="finish" ${s.pts.length >= 2 ? '' : 'disabled'}>${icon('check')}Finish</button>`
        : `<span class="hint"><kbd>Ctrl A</kbd> all · <kbd>Del</kbd> delete</span><button class="btn primary" data-x>Done</button>`}</div>`;
    el.querySelectorAll('[data-x]').forEach((b) => (b.onclick = () => app.exitMode()));
    const rerender = () => { this.render(); app.renderRight(); };
    el.querySelectorAll('[data-deg] button').forEach((b) => (b.onclick = () => { s.degree = +b.dataset.v; if (s.kind === 'curve') this.commit(); rerender(); }));
    el.querySelector('[data-closed]')?.addEventListener('change', (e) => { s.closed = e.target.checked; if (s.kind === 'curve') this.commit(); rerender(); });
    el.querySelectorAll('[data-plane] button').forEach((b) => (b.onclick = () => { s.plane = b.dataset.v; rerender(); }));
    el.querySelector('[data-snap]')?.addEventListener('change', (e) => { s.snap = e.target.checked; });
    el.querySelector('[data-cplane]')?.addEventListener('change', (e) => { s.plane = e.target.value || 'auto'; rerender(); });
    el.querySelector('[data-offset]')?.addEventListener('change', (e) => { const v = parseFloat(e.target.value); s.offset = Number.isFinite(v) ? v : 0; rerender(); });
    el.querySelector('[data-onfaces]')?.addEventListener('change', (e) => { s.onFaces = e.target.checked; rerender(); });
    el.querySelectorAll('[data-axis] button').forEach((b) => (b.onclick = () => { s.axis = b.dataset.v; app.renderRight(); }));
    el.querySelectorAll('[data-xyz]').forEach((inp) => (inp.onchange = () => {
      const v = parseFloat(inp.value);
      if (!Number.isFinite(v)) return;
      const i = [...s.sel][0];
      s.pts[i][+inp.dataset.xyz] = r3(v * u.scale);
      this.commit(); rerender();
    }));
    el.querySelectorAll('[data-dxyz]').forEach((inp) => (inp.onchange = () => {
      const v = parseFloat(inp.value);
      if (!Number.isFinite(v) || !v) return;
      for (const i of s.sel) s.pts[i][+inp.dataset.dxyz] = r3(s.pts[i][+inp.dataset.dxyz] + v * u.scale);
      this.commit(); rerender();
    }));
    el.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => {
      const a = b.dataset.a;
      if (a === 'finish') return this.finishDraw();
      if (a === 'undo') { s.pts.pop(); return rerender(); }
      if (a === 'all') s.sel = new Set(s.pts.map((_, i) => i));
      if (a === 'none') s.sel.clear();
      if (a === 'row' || a === 'col') {
        const i0 = [...s.sel][0], ui = Math.floor(i0 / s.nv), vi = i0 % s.nv;
        s.sel = new Set(a === 'row' ? Array.from({ length: s.nv }, (_, j) => ui * s.nv + j) : Array.from({ length: s.nu }, (_, i) => i * s.nv + vi));
      }
      if (a === 'insert') return this.insertCV();
      if (a === 'delete') return this.deleteSelected();
      rerender();
    }));
  }
}
