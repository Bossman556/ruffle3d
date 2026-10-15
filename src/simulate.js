// Simulate workspace: studies on one solid body.
//   static   – linear static stress (von Mises, displacement, safety factor)
//   modal    – natural frequencies and mode shapes
//   topology – generative design: minimum-compliance topology optimisation
// The study setup is saved in doc.sim; results live in memory only.
import { icon } from './icons.js';
import { MATERIALS, DEFAULT_MATERIAL, MECHANICAL } from './materials.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (x, d = 2) => (Number.isFinite(x) ? (+x.toFixed(d)).toLocaleString(undefined, { maximumFractionDigits: d }) : '–');
const sig = (x) => (!Number.isFinite(x) ? '–' : x === 0 ? '0' : Math.abs(x) >= 100 ? fmt(x, 0) : Math.abs(x) >= 1 ? fmt(x, 2) : x.toPrecision(3));
const hz = (f) => (f >= 1000 ? `${fmt(f / 1000, 2)} kHz` : `${fmt(f, f >= 100 ? 0 : 1)} Hz`);

export const MESH_SIZES = { coarse: { label: 'Coarse', elements: 6000 }, medium: { label: 'Medium', elements: 20000 }, fine: { label: 'Fine', elements: 55000 } };
const STUDIES = {
  static: { label: 'Static stress', short: 'Static', sub: 'Small deflection, elastic or with yielding', icon: 'simulate' },
  modal: { label: 'Natural frequencies', short: 'Modal', sub: 'Vibration modes with the supports held', icon: 'simmodal' },
  buckling: { label: 'Buckling', short: 'Buckling', sub: 'The load at which the part buckles', icon: 'simmodal' },
  topology: { label: 'Generative design', short: 'Generative', sub: 'Remove material that carries no load', icon: 'simgen' },
  thermal: { label: 'Thermal', short: 'Thermal', sub: 'Steady-state or transient temperatures', icon: 'simthermal' },
};
const THERMAL_LOADS = ['temp', 'heat', 'conv'];
const LOAD_NAMES = { force: 'Force', pressure: 'Pressure', bearing: 'Bearing load', gravity: 'Gravity', temp: 'Temperature', heat: 'Heat', conv: 'Convection' };
const DIRS = [['normal', 'Normal to face (pushing in)'], ['-Z', '−Z'], ['+Z', '+Z'], ['-X', '−X'], ['+X', '+X'], ['-Y', '−Y'], ['+Y', '+Y']];
const DIRV = { '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1] };
let seq = 0;

// Binary STL of an indexed triangle mesh.
function stlBinary(positions, index, name = 'Ruffle3D') {
  const nt = index.length / 3, buf = new ArrayBuffer(84 + nt * 50), dv = new DataView(buf);
  const head = `${name} generative design`.slice(0, 79);
  for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i));
  dv.setUint32(80, nt, true);
  let o = 84;
  for (let t = 0; t < nt; t++) {
    const [a, b, c] = [index[t * 3], index[t * 3 + 1], index[t * 3 + 2]].map((i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], l = Math.hypot(...n) || 1;
    for (const x of [...n.map((q) => q / l), ...a, ...b, ...c]) { dv.setFloat32(o, x, true); o += 4; }
    dv.setUint16(o, 0, true); o += 2;
  }
  return new Uint8Array(buf);
}

export class Simulation {
  constructor(app) {
    this.app = app;
    this.pick = null; // 'fixed' | load id | null
    this.results = {};
    this.show = 'stress';
    this.deform = 'auto';
    this.mode = 0;
    this.animating = false;
    this.running = null;
  }

  get study() {
    const d = this.app.doc;
    d.sim ||= { body: null, mesh: 'medium', fixed: [], loads: [] };
    d.sim.type ||= 'static';
    d.sim.modes ||= 4;
    d.sim.volume ||= 35;
    d.sim.genMesh ||= 'coarse';
    d.sim.modalMesh ||= 'coarse';
    return d.sim;
  }
  get type() { return this.study.type; }
  // loads that belong to the current study (mechanical or thermal)
  loadsFor(t = this.type) { return this.study.loads.filter((l) => (t === 'thermal' ? THERMAL_LOADS.includes(l.type) : !THERMAL_LOADS.includes(l.type))); }
  get result() { return this.results[this.type] || null; }
  set result(v) { this.results[this.type] = v; }
  clear() { this.results = {}; this.stopAnim(); }

  solidBodies() { return this.app.result.bodies.filter((b) => !b.surface); }

  // specific heat capacity, J/(kg·K), for transient thermal studies (typical room-temperature values)
  static CP = { aluminum: 900, steel: 490, stainless: 500, castiron: 460, brass: 380, bronze: 380, copper: 385, titanium: 520, gold: 129, abs: 1400, pla: 1800, petg: 1200, pc: 1200, acrylic: 1470, nylon: 1700, pom: 1460, ptfe: 1000, rubber: 2000, silicone: 1300, tpu: 1800, oak: 2000, walnut: 1700, glass: 840, ceramic: 850, concrete: 880, carbon: 1000 };
  material(bodyId) {
    const key = this.app.bodyMeta(bodyId).material || DEFAULT_MATERIAL;
    const m = MATERIALS[key] || MATERIALS[DEFAULT_MATERIAL];
    return { key, name: m.name, density: m.density, cp: Simulation.CP[key] ?? 900, ...(MECHANICAL[key] || MECHANICAL[DEFAULT_MATERIAL]) };
  }

  // ---------- entering and leaving ----------
  enter() {
    const st = this.study;
    if (!st.body || !this.solidBodies().some((b) => b.id === st.body)) st.body = this.solidBodies()[0]?.id || null;
    this.display();
  }
  leave() { this.stopAnim(); this.setPick(null); this.app.vp.setField(null); this.app.vp.setGenerative(null); }

  setType(t) {
    if (t === this.type) return;
    this.stopAnim();
    this.study.type = t;
    this.app.scheduleSave();
    this.display();
    this.app.renderToolbar();
    this.app.renderRight();
  }

  stale() {
    const r = this.result;
    if (!r) return false;
    const b = this.app.result.bodies.find((x) => x.id === r.bodyId);
    return !b || b.uid !== r.uid;
  }

  // ---------- toolbar ----------
  toolbar(tb) {
    const st = this.study, r = this.result, t = this.type;
    const b = (k, ic, label, tip, on = false, dis = false) => `<button class="tbtn ${on ? 'on' : ''}" data-sim="${k}" ${dis ? 'disabled' : ''} data-tip="${esc(label)}" data-desc="${esc(tip)}">${icon(ic)}<span>${label}</span></button>`;
    const results = t === 'static'
      ? `${b('stress', 'simstress', 'Stress', 'Von Mises stress', r && this.show === 'stress', !r)}${b('disp', 'simdisp', 'Displacement', 'How far each point moves', r && this.show === 'disp', !r)}${b('safety', 'simsafety', 'Safety', 'Factor of safety against the material strength', r && this.show === 'safety', !r)}${r?.plastic ? b('plastic', 'simstress', 'Plastic', 'Permanent (plastic) strain where the material yielded', this.show === 'plastic') : ''}${b('report', 'fileText', 'Report', 'Download an HTML report of this study', false, !r)}`
      : t === 'thermal'
        ? `${b('report', 'fileText', 'Report', 'Download an HTML report of this study', false, !r)}`
        : t === 'modal' || t === 'buckling'
        ? `${b('animate', 'play', this.animating ? 'Stop' : 'Animate', 'Animate the selected mode shape', this.animating, !r)}${t === 'modal' ? b('report', 'fileText', 'Report', 'Download an HTML report of this study', false, !r) : ''}`
        : `${b('addgen', 'plus', 'Add to model', 'Add the optimised shape to the model as a mesh body', false, !r)}${b('stl', 'download', 'STL', 'Download the optimised shape as STL', false, !r)}`;
    tb.innerHTML = `
      <div class="tgroup" style="--icon-accent:#8a9bb0"><span class="gname">Study</span>${Object.entries(STUDIES).map(([k, s]) => b(`type:${k}`, s.icon, s.short, s.label, t === k)).join('')}</div>
      ${t === 'thermal' ? `<div class="tgroup" style="--icon-accent:#f0525b"><span class="gname">Thermal loads</span>${b('temp', 'simtemp', 'Temperature', 'Hold the faces you pick at a fixed temperature')}${b('heat', 'simheat', 'Heat', 'Heat power in watts entering through the faces you pick')}${b('conv', 'simconv', 'Convection', 'Faces cooled (or heated) by the surrounding air or fluid')}</div>`
        : `<div class="tgroup" style="--icon-accent:#4f8cff"><span class="gname">Supports</span>${b('fixed', 'simfixed', 'Fixed', 'Click faces that are held in place', this.pick === 'fixed')}</div>
      <div class="tgroup" style="--icon-accent:#f5a524"><span class="gname">Loads</span>${b('force', 'simforce', 'Force', 'A force in newtons spread over the faces you pick', false, t === 'modal')}${b('pressure', 'simpressure', 'Pressure', 'A pressure in MPa acting on the faces you pick', false, t === 'modal')}${b('bearing', 'simforce', 'Bearing', 'A pin or shaft pushing on the round face of a hole: the force is spread over the side it presses on', false, t === 'modal')}${b('gravity', 'simdisp', 'Gravity', 'The part’s own weight (or a multiple of it, e.g. 3 g), along a direction', false, t === 'modal')}</div>`}
      <div class="tgroup" style="--icon-accent:#3ecf8e"><span class="gname">Solve</span>${b('solve', 'solve', this.running ? 'Solving…' : t === 'topology' ? 'Generate' : 'Solve', 'Mesh the body and solve the study', false, !!this.running || !st.body)}</div>
      <div class="tgroup" style="--icon-accent:#e46ee8"><span class="gname">Results</span>${results}</div>`;
    tb.onclick = (e) => {
      const k = e.target.closest('[data-sim]')?.dataset.sim;
      if (!k) return;
      if (k.startsWith('type:')) this.setType(k.slice(5));
      else if (k === 'fixed') this.setPick(this.pick === 'fixed' ? null : 'fixed');
      else if (k === 'force' || k === 'pressure' || k === 'bearing' || k === 'gravity' || THERMAL_LOADS.includes(k)) this.addLoad(k);
      else if (k === 'solve') this.solve();
      else if (k === 'report') this.report();
      else if (k === 'animate') this.animating ? this.stopAnim() : this.startAnim();
      else if (k === 'addgen') this.addGenerative();
      else if (k === 'stl') this.downloadSTL();
      else { this.show = k; this.display(); this.app.renderToolbar(); this.app.renderRight(); }
    };
  }

  addLoad(type) {
    const id = `L${Date.now().toString(36)}${seq++}`;
    this.app.snapshot();
    const defaults = { force: 100, pressure: 1, bearing: 500, gravity: 1, temp: 20, heat: 5, conv: 10 };
    this.study.loads.push({ id, type, value: defaults[type] ?? 1, dir: type === 'force' || type === 'bearing' || type === 'gravity' ? '-Z' : 'normal', ambient: 20, faces: [] });
    this.app.scheduleSave();
    // gravity acts on the whole body, so there are no faces to pick
    if (type === 'gravity') { this.app.renderRight(); this.app.renderToolbar(); } else this.setPick(id);
  }

  setPick(target) {
    this.pick = target;
    const app = this.app;
    if (target) {
      const what = target === 'fixed' ? 'fixed faces' : `faces for ${this.loadLabel(this.study.loads.find((l) => l.id === target))}`;
      app.banner(`Click ${what} · click a selected face again to remove it`, () => this.setPick(null));
    } else app.banner(null);
    // faces are picked on the plain model; results come back when picking ends
    if (target) { this.stopAnim(); app.vp.setField(null); app.vp.setGenerative(null); } else this.display();
    app.updateHighlights();
    app.renderToolbar();
    app.renderRight();
  }

  loadLabel(l) { return l ? `${LOAD_NAMES[l.type] || 'Load'} ${this.loadsFor().filter((x) => x.type === l.type).indexOf(l) + 1}` : 'load'; }

  click(hit) {
    if (!this.pick) {
      if (hit?.bodyId && this.solidBodies().some((b) => b.id === hit.bodyId) && hit.bodyId !== this.study.body) { this.study.body = hit.bodyId; this.clear(); this.display(); this.app.renderRight(); this.app.scheduleSave(); }
      return;
    }
    if (!hit || hit.kind !== 'face') return;
    const st = this.study;
    if (!st.body) st.body = hit.bodyId;
    if (hit.bodyId !== st.body) {
      if (st.fixed.length || st.loads.some((l) => l.faces.length)) return this.app.toast('A study runs on one body. Clear its faces, or pick faces on the same body.', 'warn');
      st.body = hit.bodyId;
    }
    const list = this.pick === 'fixed' ? st.fixed : st.loads.find((l) => l.id === this.pick)?.faces;
    if (!list) return;
    const i = list.findIndex((pk) => this.app.locateFace(pk)?.faceIndex === hit.faceIndex && pk.body === hit.bodyId);
    if (i >= 0) list.splice(i, 1); else list.push({ body: hit.bodyId, p: hit.point, n: hit.normal, ...this.app.pickRef(hit, hit.point) });
    this.app.scheduleSave();
    this.app.updateHighlights();
    this.app.renderRight();
  }

  highlights(sel) {
    const st = this.study;
    const list = this.pick === 'fixed' ? st.fixed : this.pick ? st.loads.find((l) => l.id === this.pick)?.faces || [] : [];
    for (const pk of list) { const h = this.app.locateFace(pk); if (h) sel.push(h); }
  }

  // ---------- solve ----------
  async solve() {
    const app = this.app, st = this.study, type = this.type;
    if (this.running) return;
    const body = st.body && app.vp.bodies.get(st.body);
    if (!body) return app.toast('Pick a solid body to analyse', 'warn');
    if (type === 'thermal') {
      if (!this.loadsFor().some((l) => l.faces.length && (l.type === 'temp' || l.type === 'conv'))) return app.toast('Add a fixed temperature or a convection face', 'warn');
    } else {
      if (!st.fixed.length) return app.toast('Add at least one fixed face', 'warn');
      if (type !== 'modal' && !this.loadsFor().some((l) => (l.faces.length || l.type === 'gravity') && l.value)) return app.toast('Add a force or pressure on at least one face', 'warn');
    }
    this.setPick(null);
    this.stopAnim();
    app.vp.setField(null); // pick on the undeformed mesh
    app.vp.setGenerative(null);
    const faceIx = (picks) => [...new Set(picks.map((pk) => app.locateFace(pk)?.faceIndex).filter((i) => i != null && i >= 0))];
    const fixed = faceIx(st.fixed);
    const loads = type === 'modal' ? [] : this.loadsFor().filter((l) => (l.faces.length || l.type === 'gravity') && (l.value || l.type === 'temp')).map((l) => ({ faces: faceIx(l.faces), type: l.type, value: +l.value, ambient: +(l.ambient ?? 20), dir: l.type === 'force' || l.type === 'bearing' || l.type === 'gravity' ? (l.dir === 'normal' ? 'normal' : DIRV[l.dir] || [0, 0, -1]) : 'normal' }));
    if (type !== 'thermal' && !fixed.length) return app.toast('The fixed faces no longer exist on this body. Select them again.', 'warn');
    if (type !== 'modal' && !loads.some((l) => l.faces.length || l.type === 'gravity')) return app.toast('The loaded faces no longer exist on this body. Select them again.', 'warn');
    const geo = body.data.geo.geo;
    const mat = this.material(st.body);
    const uid = app.result.bodies.find((b) => b.id === st.body)?.uid;
    const meshKey = type === 'topology' ? st.genMesh : type === 'modal' || type === 'buckling' ? st.modalMesh : st.mesh;
    const msg = {
      study: type,
      positions: geo.attributes.position.array.slice(), normals: geo.attributes.normal.array.slice(), index: geo.index.array.slice(), faceGroups: geo.userData.faceGroups,
      E: mat.E, nu: mat.nu, density: mat.density, k: mat.k, elements: MESH_SIZES[meshKey]?.elements || 20000, fixed, loads,
      plastic: type === 'static' && !!st.plastic && !mat.brittle, yield: mat.yield, hardening: 0.01,
      modes: type === 'buckling' ? 3 : st.modes, volume: st.volume / 100, iterations: 40, cp: mat.cp,
      ...(type === 'thermal' && st.transient ? { transient: { duration: +st.duration || 60, steps: +st.steps || 40, initial: +(st.initial ?? 20) } } : {}),
    };
    this.worker?.terminate();
    this.worker = new Worker(new URL('./fea.worker.js', import.meta.url), { type: 'module' });
    this.running = { p: 0, text: 'Meshing', t0: performance.now(), type };
    app.renderToolbar(); app.renderRight();
    const result = await new Promise((resolve) => {
      this.worker.onmessage = ({ data }) => {
        if (data.type === 'progress') {
          this.running.p = data.p; this.running.text = data.text;
          const bar = $('#sim-progress');
          if (bar) { bar.querySelector('i').style.width = `${Math.round(data.p * 100)}%`; bar.querySelector('span').textContent = data.text; }
        } else if (data.type === 'done') resolve(data.result);
        else { app.toast(data.error, 'warn'); resolve(null); }
      };
      this.worker.onerror = (e) => { app.toast(`Solver failed: ${e.message || 'unknown error'}`, 'warn'); resolve(null); };
      this.cancelSolve = () => resolve(null);
      this.worker.postMessage(msg, [msg.positions.buffer, msg.normals.buffer, msg.index.buffer]);
    });
    const secs = (performance.now() - this.running.t0) / 1000;
    this.running = null;
    this.worker?.terminate(); this.worker = null;
    if (result) {
      this.results[type] = { ...result, type, bodyId: st.body, uid, material: mat, seconds: secs, mesh: meshKey, loads: st.loads.map((l) => ({ ...l, faces: l.faces.length })), fixedFaces: st.fixed.length };
      if (type === 'static') {
        this.show = 'stress';
        if (!result.converged) app.toast('The solver did not fully converge; treat the results as approximate', 'warn');
        else app.toast(`Solved in ${fmt(secs, 1)} s`, 'ok');
      } else if (type === 'buckling') {
        this.mode = 0;
        app.toast(`Buckles at ${fmt(result.modes[0].factor, 2)} × the applied loads (${fmt(secs, 1)} s)`, result.modes[0].factor < 2 ? 'warn' : 'ok');
      } else if (type === 'modal') {
        this.mode = 0;
        app.toast(`Found ${result.modes.length} modes in ${fmt(secs, 1)} s · first mode ${hz(result.modes[0].frequency)}`, 'ok');
      } else if (type === 'thermal') {
        this.frame = result.frames ? result.frames.length - 1 : 0;
        app.toast(`Solved in ${fmt(secs, 1)} s · ${fmt(result.tMin, 1)} to ${fmt(result.tMax, 1)} °C`, 'ok');
      } else app.toast(`Generated in ${fmt(secs, 1)} s · ${fmt(result.volumeFraction * 100, 0)}% of the material kept`, 'ok');
    }
    if (app.ws === 'simulate') { this.display(); if ((type === 'modal' || type === 'buckling') && result) this.startAnim(); app.renderToolbar(); app.renderRight(); }
  }

  cancel() { this.worker?.terminate(); this.worker = null; this.cancelSolve?.(); }

  // ---------- results display ----------
  field() {
    const r = this.result;
    if (!r) return null;
    if (r.type === 'thermal' && r.frames) {
      // transient: one colour scale over the whole run, showing the selected moment
      const f = r.frames[Math.min(this.frame ?? r.frames.length - 1, r.frames.length - 1)];
      const lo = Math.min(...r.history.map((h) => h.min)), hi = Math.max(...r.history.map((h) => h.max));
      return { values: f.temperature, min: lo, max: hi > lo ? hi : lo + 1, invert: false, disp: null };
    }
    if (r.type === 'thermal') return { values: r.temperature, min: r.tMin, max: r.tMax > r.tMin ? r.tMax : r.tMin + 1, invert: false, disp: null };
    if (r.type === 'modal' || r.type === 'buckling') {
      const m = r.modes[this.mode] || r.modes[0], n = m.shape.length / 3, v = new Float32Array(n);
      for (let i = 0; i < n; i++) v[i] = Math.hypot(m.shape[i * 3], m.shape[i * 3 + 1], m.shape[i * 3 + 2]);
      return { values: v, min: 0, max: 1, invert: false, disp: m.shape };
    }
    const n = r.vonMises.length;
    if (this.show === 'disp') {
      const v = new Float32Array(n);
      for (let i = 0; i < n; i++) v[i] = Math.hypot(r.displacement[i * 3], r.displacement[i * 3 + 1], r.displacement[i * 3 + 2]);
      return { values: v, min: 0, max: r.maxDisplacement || 1, invert: false };
    }
    if (this.show === 'plastic' && r.plasticStrain) return { values: r.plasticStrain, min: 0, max: Math.max(r.maxPlasticStrain, 1e-6), invert: false };
    if (this.show === 'safety') {
      const v = new Float32Array(n);
      for (let i = 0; i < n; i++) v[i] = Math.min(10, r.material.yield / Math.max(r.vonMises[i], 1e-9));
      return { values: v, min: 1, max: 4, invert: true };
    }
    return { values: r.vonMises, min: 0, max: r.maxAwayFromSupports || r.maxVonMises || 1, invert: false };
  }

  diag() {
    const b = this.app.vp.bodies.get(this.result?.bodyId);
    const bb = b?.data.geo.geo.boundingBox;
    return bb ? bb.min.distanceTo(bb.max) : 100;
  }

  deformScale() {
    const r = this.result;
    if (!r) return 0;
    if (r.type === 'modal' || r.type === 'buckling') return 0.08 * this.diag(); // mode shapes are normalised to 1
    if (r.type === 'thermal') return 0;
    if (this.deform === 'off' || !(r.maxDisplacement > 0)) return 0;
    if (this.deform === 'true') return 1;
    return (0.06 * this.diag()) / r.maxDisplacement;
  }

  display() {
    const app = this.app, r = this.result;
    if (app.ws !== 'simulate' || !r || this.stale()) { app.vp.setField(null); app.vp.setGenerative(null); return; }
    if (r.type === 'topology') {
      app.vp.setField(null);
      app.vp.setGenerative({ bodyId: r.bodyId, positions: r.surface.positions, index: r.surface.index });
      return;
    }
    app.vp.setGenerative(null);
    const f = this.field();
    app.vp.setField({ bodyId: r.bodyId, ...f, mesh: r.display, disp: r.type === 'thermal' ? null : f.disp || r.displacement, scale: this.deformScale() });
  }

  startAnim() {
    const r = this.result;
    if (!r || (r.type !== 'modal' && r.type !== 'buckling') || this.stale()) return;
    this.animating = true;
    const amp = this.deformScale(), t0 = performance.now();
    const step = () => {
      if (!this.animating) return;
      this.app.vp.setFieldScale(amp * Math.sin(((performance.now() - t0) / 1000) * Math.PI * 1.4));
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
    this.app.renderToolbar();
  }
  stopAnim() {
    if (!this.animating) return;
    this.animating = false;
    cancelAnimationFrame(this._raf);
    if (this.result?.type === 'modal' || this.result?.type === 'buckling') this.app.vp.setFieldScale(this.deformScale());
    this.app.renderToolbar();
  }

  // ---------- generative design output ----------
  addGenerative() {
    const app = this.app, r = this.results.topology;
    if (!r) return;
    const bytes = stlBinary(r.surface.positions, r.surface.index, app.doc.name);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const src = app.bodyMeta(r.bodyId);
    app.addFeature('import', { format: 'stl', data: btoa(bin), file: 'Generative design.stl' });
    const f = app.doc.features[app.doc.marker - 1];
    f.name = 'Generative design';
    const meta = app.bodyMeta(f.id);
    meta.name = `${src.name} (generative)`;
    meta.material = src.material;
    app.renderLeft?.();
    app.toast(`Added “${meta.name}” to the model as a mesh body. Hide the original to see it on its own.`, 'ok');
  }

  downloadSTL() {
    const r = this.results.topology;
    if (!r) return;
    this.app.download(new Blob([stlBinary(r.surface.positions, r.surface.index, this.app.doc.name)], { type: 'model/stl' }), `${this.app.doc.name} generative.stl`);
  }

  // ---------- panel ----------
  panel(el) {
    const app = this.app, st = this.study, r = this.result, t = this.type;
    const bodies = this.solidBodies();
    if (!bodies.some((b) => b.id === st.body)) st.body = bodies[0]?.id || null;
    const mat = st.body ? this.material(st.body) : null;
    const pickBtn = (target, n) => `<button class="btn sm ${this.pick === target ? 'primary' : ''}" data-pick="${target}">${icon('pointer')}${this.pick === target ? 'Done' : n ? `${n} face${n === 1 ? '' : 's'}` : 'Select faces'}</button>`;
    const S = STUDIES[t];
    const meshKey = t === 'topology' ? 'genMesh' : t === 'modal' || t === 'buckling' ? 'modalMesh' : 'mesh';
    const legend = () => {
      if (!r || t !== 'static') return '';
      const f = this.field();
      const unit = this.show === 'disp' ? app.units.label : this.show === 'safety' ? '' : 'MPa';
      const conv = (v) => (this.show === 'disp' ? v / app.units.scale : v);
      const labels = this.show === 'safety' ? ['≤ 1', '2.5', '≥ 4'] : [0, f.max / 2, f.max].map((v) => `${sig(conv(v))} ${unit}`);
      return `<div class="sim-bar ${this.show === 'safety' ? 'inv' : ''}"></div><div class="curv-labels">${labels.map((l) => `<span>${l}</span>`).join('')}</div>`;
    };
    const stale = r && this.stale() ? `<div class="sim-stale">${icon('warn')}The model has changed since this study ran. Run it again to update the results.</div>` : '';
    let results = '';
    if (r && t === 'static') {
      const minSF = r.material.yield / Math.max(r.maxAwayFromSupports, 1e-9);
      results = `<div class="insp-sec"><h4>Results</h4>${stale}
          <div class="seg full" data-show>${[['stress', 'Stress'], ['disp', 'Displacement'], ['safety', 'Safety']].map(([k, tt]) => `<button data-v="${k}" class="${this.show === k ? 'on' : ''}">${tt}</button>`).join('')}</div>
          <div style="margin-top:12px">${legend()}</div>
          <div class="field" style="margin-top:12px"><label>Deformed shape</label><div class="seg full" data-deform>${[['off', 'Off'], ['true', 'True scale'], ['auto', 'Exaggerated']].map(([k, tt]) => `<button data-v="${k}" class="${this.deform === k ? 'on' : ''}">${tt}</button>`).join('')}</div></div>
          <dl class="kv" style="margin-top:12px">
            <dt>Peak von Mises stress</dt><dd>${sig(r.maxAwayFromSupports)} MPa</dd>
            <dt>At the supports</dt><dd>${sig(r.maxVonMises)} MPa</dd>
            <dt>Max displacement</dt><dd>${sig(r.maxDisplacement / app.units.scale)} ${app.units.label}</dd>
            <dt>Min safety factor</dt><dd class="${minSF < 1 ? 'bad' : minSF < 2 ? 'warn' : 'ok'}">${fmt(minSF, 2)}</dd>
            ${r.plastic ? `<dt>Yielded material</dt><dd class="${r.plasticFraction ? 'warn' : 'ok'}">${fmt(r.plasticFraction * 100, 1)}%</dd><dt>Max plastic strain</dt><dd>${fmt(r.maxPlasticStrain * 100, 3)}%</dd><dt>Elastic-only deflection</dt><dd>${sig(r.linearDisplacement / app.units.scale)} ${app.units.label}</dd>` : ''}
            <dt>Elements</dt><dd>${fmt(r.elements, 0)} · ${sig(r.h)} mm</dd>
            <dt>Solve</dt><dd>${r.iterations} iterations · ${fmt(r.seconds, 1)} s</dd>
          </dl>
          <div class="help">${minSF < 1 ? `The stress exceeds the ${r.material.brittle ? 'strength' : 'yield strength'} of ${esc(r.material.name)}: the part is likely to ${r.material.brittle ? 'crack' : 'bend permanently'}.` : minSF < 2 ? 'The safety factor is below 2. Consider more material where the stress is highest.' : 'The part stays well below the material strength under these loads.'}
          ${r.plastic ? (r.nearCollapse ? '<b>The part is at or past its collapse load: it keeps bending under these loads.</b> ' : r.plasticFraction ? 'Some material yields; the stresses shown are capped by yielding, and the part bends permanently where plastic strain shows. ' : 'Nothing yields under these loads. ') : ''}Results are ${r.plastic ? 'elastic–plastic (bilinear material, monotonic loading)' : 'linear-elastic'} estimates on a voxel mesh. Peaks at sharp inside corners and at the edges of fixed faces are usually higher than in reality.</div></div>`;
    } else if (r && t === 'buckling') {
      const F = Math.hypot(...(r.appliedForce || [0, 0, 0])), f1 = r.modes[0].factor;
      results = `<div class="insp-sec"><h4>Buckling modes</h4>${stale}
          <div class="mode-list">${r.modes.map((m, i) => `<button class="mode-row ${i === this.mode ? 'on' : ''}" data-mode="${i}"><b>Mode ${i + 1}</b><span>${fmt(m.factor, 2)} ×</span><small>${F ? `${sig(m.factor * F)} N` : ''}</small></button>`).join('')}</div>
          <button class="btn sm" data-anim style="width:100%;margin-top:10px">${icon(this.animating ? 'pause' : 'play')}${this.animating ? 'Stop animation' : 'Animate buckled shape'}</button>
          <dl class="kv" style="margin-top:12px"><dt>Buckling safety factor</dt><dd class="${f1 < 1 ? 'bad' : f1 < 3 ? 'warn' : 'ok'}">${fmt(f1, 2)}</dd>${F ? `<dt>Critical load</dt><dd>${sig(f1 * F)} N</dd>` : ''}<dt>Elements</dt><dd>${fmt(r.elements, 0)} · ${sig(r.h)} mm</dd><dt>Solve</dt><dd>${r.iterations} iterations · ${fmt(r.seconds, 1)} s</dd></dl>
          <div class="help">${f1 < 1 ? 'The part buckles before it reaches the loads you applied.' : `The part buckles at ${fmt(f1, 2)} × the loads you applied.`} This is linear (eigenvalue) buckling: real parts with imperfections usually buckle somewhat earlier, so keep a margin of 3 or more. Shapes show how the part buckles, not how far.</div></div>`;
    } else if (r && t === 'modal') {
      results = `<div class="insp-sec"><h4>Modes</h4>${stale}
          <div class="mode-list">${r.modes.map((m, i) => {
            const ax = ['X', 'Y', 'Z'][m.participation.indexOf(Math.max(...m.participation))];
            const part = Math.max(...m.participation);
            return `<button class="mode-row ${i === this.mode ? 'on' : ''}" data-mode="${i}"><b>Mode ${i + 1}</b><span>${hz(m.frequency)}</span><small>${part > 0.02 ? `${fmt(part * 100, 0)}% mass in ${ax}` : 'local / torsion'}</small></button>`;
          }).join('')}</div>
          <button class="btn sm" data-anim style="width:100%;margin-top:10px">${icon(this.animating ? 'pause' : 'play')}${this.animating ? 'Stop animation' : 'Animate mode shape'}</button>
          <dl class="kv" style="margin-top:12px"><dt>Mass</dt><dd>${sig(r.mass * 1000)} g</dd><dt>Elements</dt><dd>${fmt(r.elements, 0)} · ${sig(r.h)} mm</dd><dt>Solve</dt><dd>${r.iterations} iterations · ${fmt(r.seconds, 1)} s</dd></dl>
          <div class="help">Colours show how far each point moves in the selected mode (shapes are scaled to fit, so only their pattern matters). Keep the lowest frequency well away from the frequencies the part sees in use, such as a motor's speed, to avoid resonance.</div></div>`;
    } else if (r && t === 'thermal') {
      results = `<div class="insp-sec"><h4>Results</h4>${stale}
          <div class="sim-bar"></div><div class="curv-labels"><span>${fmt(r.tMin, 1)} °C</span><span>${fmt((r.tMin + r.tMax) / 2, 1)} °C</span><span>${fmt(r.tMax, 1)} °C</span></div>
          <dl class="kv" style="margin-top:12px">
            <dt>Highest temperature</dt><dd>${fmt(r.tMax, 1)} °C</dd><dt>Lowest temperature</dt><dd>${fmt(r.tMin, 1)} °C</dd>
            ${r.power ? `<dt>Heat input</dt><dd>${sig(r.power)} W</dd>` : ''}
            ${Math.abs(r.reaction) > 1e-9 ? `<dt>Through fixed temperatures</dt><dd>${sig(-r.reaction)} W out</dd>` : ''}
            <dt>Elements</dt><dd>${fmt(r.elements, 0)} · ${sig(r.h)} mm</dd><dt>Solve</dt><dd>${r.iterations} iterations · ${fmt(r.seconds, 1)} s</dd>
          </dl>
          ${r.frames ? (() => { const f = r.frames[Math.min(this.frame ?? 0, r.frames.length - 1)], H = r.history, W = 240, Hh = 70, lo = Math.min(...H.map((h) => h.min)), hi = Math.max(...H.map((h) => h.max)) || lo + 1, tEnd = H.at(-1).t || 1;
            const line = (k) => H.map((h, i) => `${i ? 'L' : 'M'}${((h.t / tEnd) * W).toFixed(1)} ${(Hh - ((h[k] - lo) / (hi - lo || 1)) * Hh).toFixed(1)}`).join('');
            return `<div class="field" style="margin-top:12px"><label>Time<span class="val">${fmt(f.t, 1)} s</span></label><input type="range" min="0" max="${r.frames.length - 1}" step="1" value="${Math.min(this.frame ?? 0, r.frames.length - 1)}" data-frame></div>
            <svg viewBox="0 0 ${W} ${Hh}" style="width:100%;height:auto;background:var(--bg3);border-radius:6px" aria-label="Temperature over time"><path d="${line('max')}" fill="none" stroke="#f0525b" stroke-width="1.5"/><path d="${line('mean')}" fill="none" stroke="#f5a524" stroke-width="1.5"/><path d="${line('min')}" fill="none" stroke="#4f8cff" stroke-width="1.5"/></svg>
            <div class="help">Highest (red), average (amber) and lowest (blue) temperature from 0 to ${fmt(tEnd, 0)} s, for ${esc(r.material.name)} with a specific heat of ${fmt(r.material.cp, 0)} J/kg·K. Radiation is not included.</div>`; })()
            : `<div class="help">Steady state: the temperatures the part settles at after running for a long time. Conductivity of ${esc(r.material.name)}: ${fmt(r.material.k, 2)} W/m·K. Radiation is not included.</div>`}</div>`;
    } else if (r && t === 'topology') {
      results = `<div class="insp-sec"><h4>Result</h4>${stale}
          <dl class="kv"><dt>Material kept</dt><dd>${fmt(r.volumeFraction * 100, 0)}%</dd><dt>Weight saved</dt><dd>${fmt((1 - r.volumeFraction) * 100, 0)}%</dd><dt>Stiffness kept</dt><dd>${fmt(Math.min(1, r.stiffnessRatio) * 100, 0)}% of the full part</dd><dt>Stiffness per gram</dt><dd>${fmt(Math.min(1, r.stiffnessRatio) / r.volumeFraction, 2)} × the full part</dd><dt>Iterations</dt><dd>${r.iterations} · ${fmt(r.seconds, 1)} s</dd></dl>
          <div class="bom-actions" style="margin-top:10px"><button class="btn sm" data-stl>${icon('download')}STL</button><button class="btn sm primary" data-add>${icon('plus')}Add to model</button></div>
          <div class="help">The optimised shape shows where material carries the load. Use it as a guide: model a clean, manufacturable version over it, or 3D print the mesh directly. Faces with supports and loads always keep their material.</div></div>`;
    }
    el.innerHTML = `<div class="panel-head">${icon(S.icon)}<h3>${S.label}<small>${S.sub}</small></h3></div>
      <div class="panel-body"><div class="insp">
        <div class="insp-sec"><div class="seg full" data-type>${Object.entries(STUDIES).map(([k, s]) => `<button data-v="${k}" class="${t === k ? 'on' : ''}">${s.short}</button>`).join('')}</div></div>
        <div class="insp-sec"><h4>Body</h4>
          ${bodies.length ? `<select class="input" data-body>${bodies.map((b) => `<option value="${b.id}" ${b.id === st.body ? 'selected' : ''}>${esc(app.bodyMeta(b.id).name)}</option>`).join('')}</select>` : '<div class="empty">There are no solid bodies to analyse.</div>'}
          ${mat ? `<dl class="kv" style="margin-top:10px"><dt>Material</dt><dd>${esc(mat.name)}</dd>${t === 'thermal' ? `<dt>Thermal conductivity</dt><dd>${fmt(mat.k, 2)} W/m·K</dd>` : `<dt>Young's modulus</dt><dd>${fmt(mat.E / 1000, 1)} GPa</dd>`}${t === 'thermal' ? '' : t === 'modal' ? `<dt>Density</dt><dd>${fmt(mat.density, 2)} g/cm³</dd>` : `<dt>Poisson's ratio</dt><dd>${fmt(mat.nu, 2)}</dd><dt>${mat.brittle ? 'Strength' : 'Yield strength'}</dt><dd>${fmt(mat.yield, 0)} MPa</dd>`}</dl>
          <div class="help">Change the material with Modify ▸ Physical Material in the Design workspace.</div>` : ''}</div>
        ${t === 'thermal' ? '' : `<div class="insp-sec"><h4>Supports</h4>
          <div class="sim-item"><span class="sim-dot fixed"></span><span>Fixed support</span><span class="spacer"></span>${pickBtn('fixed', st.fixed.length)}${st.fixed.length ? `<button class="iconbtn" data-clrfix data-tip="Clear">${icon('close')}</button>` : ''}</div></div>`}
        ${t !== 'modal' ? `<div class="insp-sec"><h4>${t === 'thermal' ? 'Thermal loads' : 'Loads'}</h4>
          ${this.loadsFor().length ? this.loadsFor().map((l) => `<div class="sim-load" data-load="${l.id}">
            <div class="sim-item"><span class="sim-dot ${l.type}"></span><b>${this.loadLabel(l)}</b><span class="spacer"></span>${l.type === 'gravity' ? '<small class="muted">whole body</small>' : pickBtn(l.id, l.faces.length)}<button class="iconbtn" data-del="${l.id}" data-tip="Delete load">${icon('trash')}</button></div>
            <div class="sim-row"><div class="field stack"><label>${{ force: 'Force (N)', pressure: 'Pressure (MPa)', bearing: 'Total force (N)', gravity: 'Acceleration (g)', temp: 'Temperature (°C)', heat: 'Power (W)', conv: 'h (W/m²·K)' }[l.type]}</label><input class="input" type="number" step="any" value="${l.value}" data-val></div>
            ${l.type === 'conv' ? `<div class="field stack"><label>Ambient (°C)</label><input class="input" type="number" step="any" value="${l.ambient ?? 20}" data-amb></div>` : ''}
            ${l.type === 'force' || l.type === 'bearing' || l.type === 'gravity' ? `<div class="field stack"><label>Direction</label><select class="input" data-dir>${DIRS.filter(([v]) => l.type === 'force' || v !== 'normal').map(([v, tt]) => `<option value="${v}" ${l.dir === v ? 'selected' : ''}>${tt}</option>`).join('')}</select></div>` : ''}</div>
            ${l.type === 'bearing' ? '<div class="help">Pick the round face of a hole. The direction is the way the pin pushes on the part.</div>' : l.type === 'gravity' ? '<div class="help">1 = the part’s own weight from its material density. Use 3 or more for shock and transport loads.</div>' : ''}</div>`).join('') : `<div class="empty">${t === 'thermal' ? 'Add a Temperature, Heat or Convection load from the toolbar. Typical h: still air 5–10, a fan 25–100, water 500+ W/m²·K.' : 'Add a Force or Pressure from the toolbar.'}</div>`}</div>` : ''}
        ${t === 'modal' ? `<div class="insp-sec"><h4>Modes</h4><div class="field"><label>Number of modes</label><div class="seg" data-modes>${[2, 4, 6].map((n) => `<button data-v="${n}" class="${st.modes === n ? 'on' : ''}">${n}</button>`).join('')}</div></div></div>` : ''}
        ${t === 'topology' ? `<div class="insp-sec"><h4>Target</h4><div class="field"><label>Keep material<span class="val" data-vv>${st.volume}%</span></label><input type="range" min="10" max="80" step="5" value="${st.volume}" data-vol></div>
          <div class="help">The optimiser keeps this share of the body's volume and places it where it makes the part stiffest under the loads.</div></div>` : ''}
        ${t === 'static' ? `<div class="insp-sec"><h4>Material model</h4><div class="field check"><label>Material yielding (plasticity)</label><label class="switch"><input type="checkbox" data-plast ${st.plastic ? 'checked' : ''}><span></span></label></div><div class="help">${st.plastic ? 'Stress above the yield strength is capped (elastic–plastic with slight hardening), so you can see how far past yield a part can go and where it bends permanently.' : 'Off: linear elastic. Turn on to model yielding of metals and plastics above their yield strength.'}</div></div>` : ''}
        ${t === 'thermal' ? `<div class="insp-sec"><h4>Time</h4>
          <div class="field check"><label>Transient (heating up or cooling down)</label><label class="switch"><input type="checkbox" data-tr ${st.transient ? 'checked' : ''}><span></span></label></div>
          ${st.transient ? `<div class="field"><label>Starting temperature</label><div class="num"><input type="number" step="1" data-trn="initial" value="${st.initial ?? 20}"><span class="unit">°C</span></div></div>
          <div class="field"><label>Duration</label><div class="num"><input type="number" step="10" min="1" data-trn="duration" value="${st.duration ?? 60}"><span class="unit">s</span></div></div>
          <div class="field"><label>Time steps</label><div class="num"><input type="number" step="10" min="1" max="400" data-trn="steps" value="${st.steps ?? 40}"><span class="unit"></span></div></div>` : '<div class="help">Off: the temperatures the part settles at. On: how they change over time from a starting temperature.</div>'}</div>` : ''}
        <div class="insp-sec"><h4>Mesh</h4>
          <div class="seg full" data-mesh>${Object.entries(MESH_SIZES).map(([k, m]) => `<button data-v="${k}" class="${st[meshKey] === k ? 'on' : ''}">${m.label}</button>`).join('')}</div>
          <div class="help">About ${fmt(MESH_SIZES[st[meshKey]]?.elements || 20000, 0)} cubic elements. ${t === 'static' || t === 'thermal' ? 'Finer meshes are more accurate near small features but take longer.' : t === 'modal' ? 'Each mode needs several solves, so Coarse is a good start.' : 'Each step is a full solve; Coarse takes about a minute.'}</div>
          ${this.running ? `<div class="sim-progress" id="sim-progress"><i style="width:${Math.round(this.running.p * 100)}%"></i><span>${esc(this.running.text)}</span></div><button class="btn sm" data-cancel style="width:100%;margin-top:8px">Cancel</button>`
            : `<button class="btn primary" data-solve style="width:100%;margin-top:10px" ${st.body ? '' : 'disabled'}>${icon('solve')}${t === 'topology' ? 'Generate' : 'Solve'}</button>`}</div>
        ${results}
      </div></div>`;
    el.querySelectorAll('[data-type] button').forEach((b) => (b.onclick = () => this.setType(b.dataset.v)));
    el.querySelector('[data-body]')?.addEventListener('change', (e) => { st.body = e.target.value; st.fixed = []; st.loads.forEach((l) => (l.faces = [])); this.clear(); this.display(); app.scheduleSave(); app.renderRight(); app.updateHighlights(); });
    el.querySelectorAll('[data-pick]').forEach((b) => (b.onclick = () => this.setPick(this.pick === b.dataset.pick ? null : b.dataset.pick)));
    el.querySelector('[data-clrfix]')?.addEventListener('click', () => { st.fixed = []; app.scheduleSave(); app.updateHighlights(); app.renderRight(); });
    el.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => { st.loads = st.loads.filter((l) => l.id !== b.dataset.del); if (this.pick === b.dataset.del) this.setPick(null); app.scheduleSave(); app.renderRight(); }));
    el.querySelectorAll('[data-load]').forEach((row) => {
      const l = st.loads.find((x) => x.id === row.dataset.load);
      row.querySelector('[data-val]').onchange = (e) => { l.value = +e.target.value || 0; app.scheduleSave(); };
      row.querySelector('[data-dir]')?.addEventListener('change', (e) => { l.dir = e.target.value; app.scheduleSave(); });
      row.querySelector('[data-amb]')?.addEventListener('change', (e) => { l.ambient = +e.target.value || 0; app.scheduleSave(); });
    });
    el.querySelectorAll('[data-mesh] button').forEach((b) => (b.onclick = () => { st[meshKey] = b.dataset.v; app.scheduleSave(); app.renderRight(); }));
    el.querySelectorAll('[data-modes] button').forEach((b) => (b.onclick = () => { st.modes = +b.dataset.v; app.scheduleSave(); app.renderRight(); }));
    el.querySelector('[data-plast]')?.addEventListener('change', (e) => { st.plastic = e.target.checked; app.scheduleSave(); app.renderRight(); });
    el.querySelector('[data-tr]')?.addEventListener('change', (e) => { st.transient = e.target.checked; app.scheduleSave(); app.renderRight(); });
    el.querySelectorAll('[data-trn]').forEach((inp) => inp.addEventListener('change', () => { st[inp.dataset.trn] = +inp.value; app.scheduleSave(); }));
    el.querySelector('[data-frame]')?.addEventListener('input', (e) => { this.frame = +e.target.value; this.display(); const f = this.result?.frames?.[this.frame]; const lab = e.target.closest('.field')?.querySelector('.val'); if (f && lab) lab.textContent = `${fmt(f.t, 1)} s`; });
    el.querySelector('[data-vol]')?.addEventListener('input', (e) => { st.volume = +e.target.value; el.querySelector('[data-vv]').textContent = `${st.volume}%`; app.scheduleSave(); });
    el.querySelector('[data-solve]')?.addEventListener('click', () => this.solve());
    el.querySelector('[data-cancel]')?.addEventListener('click', () => this.cancel());
    el.querySelectorAll('[data-show] button').forEach((b) => (b.onclick = () => { this.show = b.dataset.v; this.display(); app.renderToolbar(); app.renderRight(); }));
    el.querySelectorAll('[data-deform] button').forEach((b) => (b.onclick = () => { this.deform = b.dataset.v; this.display(); app.renderRight(); }));
    el.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => { const on = this.animating; this.stopAnim(); this.mode = +b.dataset.mode; this.display(); if (on) this.startAnim(); app.renderRight(); }));
    el.querySelector('[data-anim]')?.addEventListener('click', () => { this.animating ? this.stopAnim() : this.startAnim(); app.renderRight(); });
    el.querySelector('[data-add]')?.addEventListener('click', () => this.addGenerative());
    el.querySelector('[data-stl]')?.addEventListener('click', () => this.downloadSTL());
  }

  // ---------- report ----------
  report() {
    const app = this.app, r = this.result;
    if (!r) return;
    let shot = '';
    try { shot = app.vp.renderer.domElement.toDataURL('image/png'); } catch { /* no image */ }
    const row = (k, v) => `<tr><th>${k}</th><td>${v}</td></tr>`;
    const title = r.type === 'modal' ? 'Natural frequency report' : r.type === 'thermal' ? 'Thermal report' : 'Static stress report';
    let body;
    if (r.type === 'thermal') {
      body = `<h2>Summary</h2><table>${row('Highest temperature', `${fmt(r.tMax, 2)} °C`)}${row('Lowest temperature', `${fmt(r.tMin, 2)} °C`)}${row('Heat input', `${sig(r.power)} W`)}${row('Heat out through fixed temperatures', `${sig(-r.reaction)} W`)}</table>
<h2>Material</h2><table>${row('Material', esc(r.material.name))}${row('Thermal conductivity', `${fmt(r.material.k, 2)} W/m·K`)}</table>
<h2>Thermal loads</h2><table>${r.loads.filter((l) => l.faces && THERMAL_LOADS.includes(l.type)).map((l) => row(`${LOAD_NAMES[l.type]}`, l.type === 'temp' ? `${sig(l.value)} °C on ${l.faces} face(s)` : l.type === 'heat' ? `${sig(l.value)} W into ${l.faces} face(s)` : `h = ${sig(l.value)} W/m²·K to ${sig(l.ambient ?? 20)} °C on ${l.faces} face(s)`)).join('')}</table>
<h2>Mesh and solver</h2><table>${row('Elements', `${fmt(r.elements, 0)} hexahedra, ${sig(r.h)} mm`)}${row('Solver', `Conjugate gradients, ${r.iterations} iterations, ${fmt(r.seconds, 1)} s`)}</table>
<h2>Assumptions</h2><p class="note">Steady-state conduction with constant conductivity; convection as a fixed film coefficient; no radiation or contact resistance.</p>`;
    } else if (r.type === 'modal') {
      body = `<h2>Natural frequencies</h2><table><tr><th>Mode</th><td><b>Frequency</b></td><td><b>Mass participation X / Y / Z</b></td></tr>${r.modes.map((m, i) => `<tr><th>Mode ${i + 1}</th><td>${hz(m.frequency)}</td><td>${m.participation.map((p) => `${fmt(p * 100, 1)}%`).join(' / ')}</td></tr>`).join('')}</table>
<h2>Material</h2><table>${row('Material', esc(r.material.name))}${row("Young's modulus", `${fmt(r.material.E / 1000, 1)} GPa`)}${row('Density', `${fmt(r.material.density, 2)} g/cm³`)}${row('Mass', `${sig(r.mass * 1000)} g`)}</table>
<h2>Supports and mesh</h2><table>${row('Fixed supports', `${r.fixedFaces} face${r.fixedFaces === 1 ? '' : 's'}`)}${row('Elements', `${fmt(r.elements, 0)} hexahedra, ${sig(r.h)} mm`)}${row('Solver', `Subspace iteration with lumped masses, ${r.iterations} iterations, ${fmt(r.seconds, 1)} s`)}</table>
<h2>Assumptions</h2><p class="note">Linear elastic, isotropic material with lumped mass, no damping, fixed supports fully rigid. Use the frequencies to keep the part away from resonance with the vibrations it sees in use.</p>`;
    } else {
      const minSF = r.material.yield / Math.max(r.maxAwayFromSupports, 1e-9);
      body = `<h2>Summary</h2><table>${row('Peak von Mises stress (away from supports)', `${sig(r.maxAwayFromSupports)} MPa`)}${row('Von Mises stress at the supports', `${sig(r.maxVonMises)} MPa`)}${row('Maximum displacement', `${sig(r.maxDisplacement)} mm`)}${row('Minimum safety factor', fmt(minSF, 2))}</table>
<h2>Material</h2><table>${row('Material', esc(r.material.name))}${row("Young's modulus", `${fmt(r.material.E / 1000, 1)} GPa`)}${row("Poisson's ratio", fmt(r.material.nu, 2))}${row(r.material.brittle ? 'Strength' : 'Yield strength', `${fmt(r.material.yield, 0)} MPa`)}</table>
<h2>Boundary conditions</h2><table>${row('Fixed supports', `${r.fixedFaces} face${r.fixedFaces === 1 ? '' : 's'}`)}${r.loads.filter((l) => l.faces || l.type === 'gravity').map((l, i) => row(`${LOAD_NAMES[l.type] || 'Load'} ${i + 1}`, l.type === 'gravity' ? `${sig(l.value)} g along ${l.dir} (self-weight)` : l.type === 'bearing' ? `${sig(l.value)} N along ${l.dir}, as a bearing load on ${l.faces} face${l.faces === 1 ? '' : 's'}` : l.type === 'force' ? `${sig(l.value)} N, ${l.dir === 'normal' ? 'normal to the faces' : `along ${l.dir}`}, on ${l.faces} face${l.faces === 1 ? '' : 's'}` : `${sig(l.value)} MPa on ${l.faces} face${l.faces === 1 ? '' : 's'}`)).join('')}${row('Total applied force', `${r.appliedForce.map((v) => sig(v)).join(', ')} N (X, Y, Z)`)}</table>
<h2>Mesh and solver</h2><table>${row('Elements', `${fmt(r.elements, 0)} hexahedra, ${sig(r.h)} mm`)}${row('Nodes', fmt(r.nodes, 0))}${row('Solver', `Multigrid-preconditioned conjugate gradients, ${r.iterations} iterations, ${r.converged ? 'converged' : 'not fully converged'}`)}${row('Solve time', `${fmt(r.seconds, 1)} s`)}</table>
<h2>Assumptions</h2><p class="note">Linear elastic, isotropic material; small deflections; static loads. The body is meshed into equal cubic elements with incompatible bending modes. Stresses at sharp inside corners and at the edges of fixed faces are singular in theory and depend on mesh size. Use these results to compare designs and find weak spots, and confirm critical parts by testing.</p>`;
    }
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(app.doc.name)} – ${title.toLowerCase()}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;color:#16181b;max-width:860px;margin:32px auto;padding:0 16px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}p.m{color:#5b6470;margin:0}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #e3e6ea;font-weight:400}th{color:#5b6470;width:42%}img{width:100%;border:1px solid #e3e6ea;border-radius:8px;margin-top:12px}.note{background:#f4f6f8;border-radius:8px;padding:12px 14px;color:#3d4550;font-size:13px}</style></head><body>
<h1>${title}</h1><p class="m">${esc(app.doc.name)} · ${esc(app.bodyMeta(r.bodyId).name)} · ${new Date().toLocaleString()}</p>
${shot ? `<img src="${shot}" alt="Result plot">` : ''}
${body}
<p class="m" style="margin-top:24px">Generated by Ruffle3D</p></body></html>`;
    app.download(new Blob([html], { type: 'text/html' }), `${app.doc.name} ${r.type === 'modal' ? 'frequency' : r.type === 'thermal' ? 'thermal' : 'stress'} report.html`);
  }
}
