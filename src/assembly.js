// Assemblies in the app: inserting components from other projects, mates, and the assembly panel.
// Components are timeline features that carry a snapshot of their source project (so an assembly
// still opens if the source changes or is deleted). Mates live in doc.mates and are solved by the
// kernel after every rebuild; their face references are stored in each component's own frame.
import * as THREE from 'three';
import { icon } from './icons.js';
import { store } from './store.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (x, d = 2) => (Number.isFinite(x) ? (+x.toFixed(d)).toLocaleString(undefined, { maximumFractionDigits: d }) : '–');

export const MATE_TYPES = {
  mate: { label: 'Mate', desc: 'Faces against each other', needs: 'plane', offset: true, flip: true },
  flush: { label: 'Flush', desc: 'Faces level, pointing the same way', needs: 'plane', offset: true, flip: true },
  concentric: { label: 'Concentric', desc: 'Round faces on one axis (pin in hole)', needs: 'axis' },
  distance: { label: 'Distance', desc: 'Parallel faces a set distance (or a range) apart, out from the first face', needs: 'plane', offset: true, limit: true },
  parallel: { label: 'Parallel', desc: 'Faces or axes parallel' },
  perpendicular: { label: 'Perpendicular', desc: 'Faces or axes at 90°' },
  angle: { label: 'Angle', desc: 'Faces or axes at an angle, or within a range', angle: true, limit: true },
  contact: { label: 'Contact', desc: 'A flat face rests on another and can lift off, but not sink into it', needs: 'plane', offset: true },
  gear: { label: 'Gear', desc: 'Two round faces turn together at a ratio (gears, belts)', needs: 'axis', ratio: true, flip: true, flipLabel: 'Same direction (belt)' },
  rack: { label: 'Rack and pinion', desc: 'Turning the pinion slides the rack', rackR: true, flip: true, flipLabel: 'Reverse' },
};

// rotation helpers (same conventions as the kernel: T = { r: rotation vector, t })
const rod = (r) => {
  const th = Math.hypot(r[0], r[1], r[2]);
  if (th < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const k = r.map((v) => v / th), c = Math.cos(th), s = Math.sin(th), v = 1 - c;
  return [c + k[0] * k[0] * v, k[0] * k[1] * v - k[2] * s, k[0] * k[2] * v + k[1] * s, k[1] * k[0] * v + k[2] * s, c + k[1] * k[1] * v, k[1] * k[2] * v - k[0] * s, k[2] * k[0] * v - k[1] * s, k[2] * k[1] * v + k[0] * s, c + k[2] * k[2] * v];
};
// world → component-local: Rᵀ (p − t)
const invPoint = (T, p) => { const R = rod(T.r), d = [p[0] - T.t[0], p[1] - T.t[1], p[2] - T.t[2]]; return [R[0] * d[0] + R[3] * d[1] + R[6] * d[2], R[1] * d[0] + R[4] * d[1] + R[7] * d[2], R[2] * d[0] + R[5] * d[1] + R[8] * d[2]]; };
const invDir = (T, v) => { const R = rod(T.r); return [R[0] * v[0] + R[3] * v[1] + R[6] * v[2], R[1] * v[0] + R[4] * v[1] + R[7] * v[2], R[2] * v[0] + R[5] * v[1] + R[8] * v[2]]; };

export class AssemblyTools {
  constructor(app) { this.app = app; this.mate = null; }

  get mates() { return (this.app.doc.mates ||= []); }
  components() { return this.app.doc.features.filter((f) => f.type === 'component'); }
  splitId(bodyId) { const i = bodyId.indexOf('/'); return i > 0 && this.components().some((c) => c.id === bodyId.slice(0, i)) ? { comp: bodyId.slice(0, i), body: bodyId.slice(i + 1) } : { comp: null, body: bodyId }; }

  // ---------- inserting components ----------
  async insert() {
    const app = this.app;
    const list = (await store.listProjects()).filter((p) => p.id !== app.projectId);
    if (!list.length) return app.toast('Save the parts you want to assemble as projects first; they will be listed here.', 'warn');
    const m = app.modal('Insert component', `<p class="muted" style="margin-top:0">Choose a project to place in this design. Ruffle3D keeps a copy of it, and you can update it later when the part changes.</p>
      <div class="comp-pick">${list.map((p) => `<button class="card" data-p="${p.id}"><div class="thumb">${p.thumb ? `<img src="${p.thumb}" alt="">` : icon('cube')}</div><div class="meta"><b>${esc(p.name)}</b><small>${p.features} feature${p.features === 1 ? '' : 's'}</small></div></button>`).join('')}</div>`, { wide: true, ic: 'component', cancel: true });
    m.querySelectorAll('[data-p]').forEach((b) => (b.onclick = async () => { app.closeModal(); await this.add(b.dataset.p); }));
  }

  async add(projectId) {
    const app = this.app;
    const p = await store.getProject(projectId);
    if (!p) return;
    const comps = this.components();
    // place it beside what is already there
    let x = 0;
    for (const [, b] of app.vp.bodies) { const bb = b.data.geo.geo.boundingBox; if (bb) x = Math.max(x, bb.max.x); }
    const n = comps.filter((c) => c.p.source?.projectId === projectId).length + 1;
    const name = n > 1 ? `${p.name} <${n}>` : p.name;
    app.addFeature('component', { name, doc: structuredClone(p.doc), source: { projectId, name: p.name, updated: p.updated }, x: String(x ? Math.round(x + 20) : 0), y: '0', z: '0', rx: '0', ry: '0', rz: '0', grounded: !comps.length && !app.result.bodies.length });
    const f = app.doc.features[app.doc.marker - 1];
    f.name = name;
    // body names and materials come from the source project
    for (const [bid, meta] of Object.entries(p.doc.bodies || {})) app.doc.bodies[`${f.id}/${bid}`] = { ...meta, name: `${name}: ${meta.name || bid}` };
    app.renderLeft?.();
    app.toast(`Inserted ${p.name}. Add mates to position it.`, 'ok');
  }

  async update(fid) {
    const app = this.app, f = app.doc.features.find((x) => x.id === fid);
    const src = f?.p.source && (await store.getProject(f.p.source.projectId));
    if (!src) return app.toast('The source project is no longer on this computer; the stored copy is kept.', 'warn');
    app.snapshot();
    f.p.doc = structuredClone(src.doc);
    f.p.source = { ...f.p.source, name: src.name, updated: src.updated };
    for (const [bid, meta] of Object.entries(src.doc.bodies || {})) if (!app.doc.bodies[`${f.id}/${bid}`]) app.doc.bodies[`${f.id}/${bid}`] = { ...meta, name: `${f.name}: ${meta.name || bid}` };
    app.changed();
    app.toast(`Updated ${f.name} from ${src.name}`, 'ok');
  }

  async checkUpdates() {
    const out = {};
    for (const f of this.components()) {
      const src = f.p.source && (await store.getProject(f.p.source.projectId).catch(() => null));
      out[f.id] = !src ? 'missing' : src.updated > (f.p.source.updated || 0) ? 'newer' : 'current';
    }
    this.updates = out;
    return out;
  }

  // ---------- mates ----------
  startMate(edit = null) {
    const app = this.app;
    if (!this.components().length) return app.toast('Insert components first (Assemble ▸ Component)', 'warn');
    app.exitMode();
    app.mode = 'mate';
    const m = edit ? this.mates.find((x) => x.id === edit) : null;
    this.mate = m ? { ...structuredClone(m), editing: m.id, active: null } : { type: 'mate', a: null, b: null, offset: 0, angle: 90, flip: false, active: 'a' };
    app.banner('Mate: click a face on each part', () => app.exitMode());
    app.updateHighlights();
    app.renderRight();
  }

  // face pick → reference in the component's own frame (stored so mates survive moving the part)
  ref(hit) {
    const app = this.app, { comp, body } = this.splitId(hit.bodyId);
    const T = comp ? app.result.assembly?.transforms?.[comp] : null;
    const pr = app.pickRef(hit, hit.point);
    const s = pr.s && T ? { ...pr.s, c: invPoint(T, pr.s.c), n: invDir(T, pr.s.n), b: undefined } : pr.s;
    return { comp, body, p: T ? invPoint(T, hit.point) : hit.point, n: T ? invDir(T, hit.normal) : hit.normal, s, world: hit.point, wbody: hit.bodyId };
  }

  click(hit) {
    const M = this.mate;
    if (!M || !hit || (hit.kind !== 'face' && hit.kind !== 'plane') || !hit.bodyId) return;
    const key = M.active || (!M.a ? 'a' : !M.b ? 'b' : null);
    if (!key) return;
    const r = this.ref(hit);
    const other = key === 'a' ? M.b : M.a;
    if (other && other.comp === r.comp && (r.comp || other.body === r.body)) return this.app.toast('Pick the second face on a different part', 'warn');
    M[key] = r;
    M.active = key === 'a' && !M.b ? 'b' : null;
    // a pair of round faces is almost always a concentric mate
    if (M.a && M.b && !M.editing && M.type !== 'gear' && M.type !== 'rack' && hit.kind === 'face' && this.faceKind(M.a) === 'round' && this.faceKind(M.b) === 'round') M.type = 'concentric';
    this.app.updateHighlights();
    this.app.renderRight();
  }

  faceKind(ref) {
    const h = ref && this.app.locateFace({ body: ref.wbody, p: ref.world });
    return h ? (ref.s?.pl ? 'flat' : 'round') : null;
  }

  highlights(sel) {
    const M = this.mate;
    for (const r of [M?.a, M?.b]) if (r) { const h = this.app.locateFace({ body: r.wbody, p: r.world }); if (h) sel.push(h); }
  }

  okMate() {
    const app = this.app, M = this.mate;
    if (!M?.a || !M?.b) return app.toast('Pick a face on each part', 'warn');
    app.snapshot();
    const clean = (r) => ({ comp: r.comp, body: r.body, p: r.p, n: r.n, s: r.s, world: r.world, wbody: r.wbody });
    const lim = !!(M.limit && MATE_TYPES[M.type].limit);
    if (lim && !(M.max >= M.min)) return app.toast('The maximum must be at least the minimum', 'warn');
    const rec = { id: M.editing || `mt${Date.now().toString(36)}`, type: M.type, a: clean(M.a), b: clean(M.b), offset: +M.offset || 0, angle: +M.angle || 0, flip: !!M.flip, limit: lim, ...(lim ? { min: +M.min, max: +M.max } : {}), ...(M.type === 'gear' ? { ratio: +M.ratio || 1 } : {}), ...(M.type === 'rack' && M.radius ? { radius: +M.radius } : {}) };
    if (M.editing) { const i = this.mates.findIndex((x) => x.id === M.editing); this.mates[i] = { ...this.mates[i], ...rec }; } else this.mates.push(rec);
    this.mate = null;
    app.mode = null;
    app.banner(null);
    app.changed();
    app.renderRight();
  }

  matePanel(el) {
    const app = this.app, M = this.mate, T = MATE_TYPES[M.type], u = app.units;
    const refLabel = (r) => (r ? esc(app.bodyMeta(r.wbody).name) : 'Click a face');
    el.innerHTML = `<div class="panel-head">${icon('mate')}<h3>${M.editing ? 'Edit mate' : 'Mate'}<small>${esc(T.desc)}</small></h3><button class="iconbtn" data-x>${icon('close')}</button></div>
      <div class="panel-body"><div class="insp"><div class="insp-sec">
        <div class="field"><label>Type</label><select class="input" data-type>${Object.entries(MATE_TYPES).map(([k, t]) => `<option value="${k}" ${M.type === k ? 'selected' : ''}>${t.label}</option>`).join('')}</select></div>
        <div class="field"><label>First face</label><div class="selfield ${M.active === 'a' ? 'active' : ''} ${M.a ? 'has' : ''}" data-ref="a"><i class="dot"></i><span>${refLabel(M.a)}</span></div></div>
        <div class="field"><label>Second face</label><div class="selfield ${M.active === 'b' ? 'active' : ''} ${M.b ? 'has' : ''}" data-ref="b"><i class="dot"></i><span>${refLabel(M.b)}</span></div></div>
        ${T.limit ? `<div class="field check"><label>Range (limits)</label><label class="switch"><input type="checkbox" data-lim ${M.limit ? 'checked' : ''}><span></span></label></div>` : ''}
        ${T.limit && M.limit ? `<div class="field"><label>Minimum</label><div class="num"><input data-min type="number" step="${M.type === 'angle' ? 5 : 0.5}" value="${M.type === 'angle' ? M.min ?? 0 : +((M.min ?? 0) / u.scale).toFixed(4)}"><span class="unit">${M.type === 'angle' ? '°' : u.label}</span></div></div>
        <div class="field"><label>Maximum</label><div class="num"><input data-max type="number" step="${M.type === 'angle' ? 5 : 0.5}" value="${M.type === 'angle' ? M.max ?? 90 : +((M.max ?? 20) / u.scale).toFixed(4)}"><span class="unit">${M.type === 'angle' ? '°' : u.label}</span></div></div>` : ''}
        ${T.offset && !(T.limit && M.limit) ? `<div class="field"><label>${M.type === 'distance' ? 'Distance' : 'Offset'}</label><div class="num"><input data-off type="number" step="0.5" value="${+(M.offset / u.scale).toFixed(4)}"><span class="unit">${u.label}</span></div></div>` : ''}
        ${T.angle && !M.limit ? `<div class="field"><label>Angle</label><div class="num"><input data-ang type="number" step="5" value="${M.angle}"><span class="unit">°</span></div></div>` : ''}
        ${T.ratio ? `<div class="field"><label>Ratio</label><div class="num"><input data-ratio type="number" step="0.1" min="0.001" value="${M.ratio ?? 1}"><span class="unit">×</span></div></div>` : ''}
        ${T.rackR ? `<div class="field"><label>Pitch radius</label><div class="num"><input data-rr type="number" step="0.5" min="0" value="${M.radius ? +(M.radius / u.scale).toFixed(4) : ''}" placeholder="from the face"><span class="unit">${u.label}</span></div></div>` : ''}
        ${T.flip ? `<div class="field check"><label>${T.flipLabel || 'Flip'}</label><label class="switch"><input type="checkbox" data-flip ${M.flip ? 'checked' : ''}><span></span></label></div>` : ''}
        <div class="help">${M.type === 'gear' ? 'Pick a round face on each gear (the bore or the outside). The second gear turns ratio × as far as the first; use teeth of the first ÷ teeth of the second. Add concentric mates to hold each gear on its shaft.' : M.type === 'rack' ? 'Pick a round face on the pinion, then the flat end face of the rack: the rack slides along that face’s normal by pitch radius × the turn.' : T.needs === 'axis' ? 'Pick two round faces, such as a pin and a hole.' : T.needs === 'plane' ? 'Pick two flat faces.' : 'Pick two flat or round faces.'} Parts that are not grounded move to satisfy all the mates together.</div>
      </div></div></div>
      <div class="panel-foot"><span class="spacer"></span><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-ok>${icon('check')}OK</button></div>`;
    el.querySelectorAll('[data-x]').forEach((b) => (b.onclick = () => app.exitMode()));
    el.querySelector('[data-ok]').onclick = () => this.okMate();
    el.querySelector('[data-type]').onchange = (e) => { M.type = e.target.value; this.matePanel(el); };
    el.querySelectorAll('[data-ref]').forEach((d) => (d.onclick = () => { M.active = d.dataset.ref; this.matePanel(el); }));
    el.querySelector('[data-off]')?.addEventListener('change', (e) => { M.offset = (+e.target.value || 0) * u.scale; });
    el.querySelector('[data-ang]')?.addEventListener('change', (e) => { M.angle = +e.target.value || 0; });
    el.querySelector('[data-flip]')?.addEventListener('change', (e) => { M.flip = e.target.checked; });
    el.querySelector('[data-ratio]')?.addEventListener('change', (e) => { M.ratio = Math.max(0.001, +e.target.value || 1); });
    el.querySelector('[data-rr]')?.addEventListener('change', (e) => { M.radius = (+e.target.value || 0) * u.scale || undefined; });
    el.querySelector('[data-lim]')?.addEventListener('change', (e) => {
      M.limit = e.target.checked;
      if (M.limit) { if (M.type === 'angle') { M.min ??= 0; M.max ??= 90; } else { M.min ??= 0; M.max ??= 20 * u.scale; } }
      this.matePanel(el);
    });
    const ang = M.type === 'angle';
    el.querySelector('[data-min]')?.addEventListener('change', (e) => { M.min = (+e.target.value || 0) * (ang ? 1 : u.scale); });
    el.querySelector('[data-max]')?.addEventListener('change', (e) => { M.max = (+e.target.value || 0) * (ang ? 1 : u.scale); });
  }

  // ---------- assembly panel ----------
  async openPanel() {
    const app = this.app;
    app.exitMode();
    app.mode = 'assembly';
    app.renderRight();
    await this.checkUpdates();
    if (app.mode === 'assembly') app.renderRight();
  }

  panel(el) {
    const app = this.app, A = app.result.assembly, comps = this.components();
    const status = Object.fromEntries((A?.mates || []).map((m) => [m.id, m]));
    const up = this.updates || {};
    const conflicts = (A?.mates || []).filter((m) => !m.ok).length;
    el.innerHTML = `<div class="panel-head">${icon('component')}<h3>Assembly<small>${comps.length} component${comps.length === 1 ? '' : 's'} · ${this.mates.length} mate${this.mates.length === 1 ? '' : 's'}</small></h3><button class="iconbtn" data-x>${icon('close')}</button></div>
      <div class="panel-body"><div class="insp">
        <div class="insp-sec"><div class="bom-actions" style="margin:0"><button class="btn sm" data-ins>${icon('plus')}Component</button><button class="btn sm primary" data-mate>${icon('mate')}Mate</button></div>
          <div class="field check" style="margin-top:10px"><label>Check collisions</label><label class="switch"><input type="checkbox" data-coll ${app.doc.asmCollide ? 'checked' : ''}><span></span></label></div>
          ${app.doc.asmCollide && this.coll ? (this.coll.length ? `<div class="asm-status bad">${icon('warn')}${this.coll.length} collision${this.coll.length === 1 ? '' : 's'}: ${this.coll.map((c) => `${esc(c.a)} ↔ ${esc(c.b)} (${app.vol(c.volume)})`).join(', ')}</div>` : `<div class="asm-status ok">${icon('ok')}No parts overlap</div>`) : ''}
          ${A ? `<div class="asm-status ${conflicts ? 'bad' : A.dof ? 'warn' : 'ok'}">${icon(conflicts ? 'warn' : A.dof ? 'info' : 'ok')}${conflicts ? `${conflicts} mate${conflicts === 1 ? '' : 's'} can't be satisfied` : A.dof ? `${A.dof} degree${A.dof === 1 ? '' : 's'} of freedom left` : 'Fully constrained'}</div>` : ''}</div>
        <div class="insp-sec"><h4>Components</h4>
          ${comps.length ? comps.map((f) => `<div class="asm-row" data-c="${f.id}">${icon('component')}<span class="nm">${esc(f.name)}<small>${esc(f.p.source?.name || '')}${up[f.id] === 'newer' ? ' · <b class="warn">update available</b>' : up[f.id] === 'missing' ? ' · source not found' : ''}</small></span>
            <button class="iconbtn ${f.p.grounded ? 'on' : ''}" data-ground="${f.id}" data-tip="${f.p.grounded ? 'Grounded' : 'Ground'}">${icon(f.p.grounded ? 'lock' : 'unlock')}</button>
            ${up[f.id] === 'newer' ? `<button class="iconbtn" data-up="${f.id}" data-tip="Update from the project">${icon('reset')}</button>` : ''}
            <button class="iconbtn" data-edit="${f.id}" data-tip="Position">${icon('move')}</button>
            <button class="iconbtn" data-openp="${f.id}" data-tip="Open the part">${icon('external')}</button></div>`).join('') : '<div class="empty">No components yet. Insert projects with Component.</div>'}</div>
        <div class="insp-sec"><h4>Mates</h4>
          ${this.mates.length ? this.mates.map((m, i) => { const s = status[m.id]; const bad = s && !s.ok; return `<div class="asm-row ${m.suppressed ? 'off' : ''}" data-m="${m.id}"><i class="asm-dot ${m.suppressed ? '' : bad ? 'bad' : s ? 'ok' : ''}"></i><span class="nm">${i + 1}. ${MATE_TYPES[m.type]?.label || m.type}${m.type === 'gear' ? ` · ${fmt(m.ratio ?? 1, 3)}×` : ''}${m.limit ? (m.type === 'angle' ? ` · ${fmt(m.min, 1)}–${fmt(m.max, 1)}°` : ` · ${app.len(m.min, 2)} to ${app.len(m.max, 2)}`) : `${m.offset ? ` · ${app.len(m.offset, 2)}` : ''}${m.type === 'angle' ? ` · ${fmt(m.angle, 1)}°` : ''}`}<small>${esc(app.bodyMeta(m.a.wbody).name)} → ${esc(app.bodyMeta(m.b.wbody).name)}${bad ? ` · ${esc(s.error || 'conflicts with other mates')}` : ''}</small></span>
            <button class="iconbtn" data-medit="${m.id}" data-tip="Edit">${icon('pencil')}</button><button class="iconbtn" data-msupp="${m.id}" data-tip="${m.suppressed ? 'Enable' : 'Suppress'}">${icon(m.suppressed ? 'eyeOff' : 'eye')}</button><button class="iconbtn" data-mdel="${m.id}" data-tip="Delete">${icon('trash')}</button></div>`; }).join('') : '<div class="empty">No mates yet. Use Mate to fit parts together.</div>'}</div>
        <div class="insp-sec"><div class="help">The first component is grounded unless you ground another. Grounded parts never move; the others are moved together until every mate is satisfied. Drag a part to move it along its free directions. Open a part to change it, then use Update here.</div></div>
      </div></div>
      <div class="panel-foot"><span class="spacer"></span><button class="btn primary" data-x>Done</button></div>`;
    el.querySelectorAll('[data-x]').forEach((b) => (b.onclick = () => app.exitMode()));
    el.querySelector('[data-ins]').onclick = () => this.insert();
    el.querySelector('[data-coll]').onchange = async (e) => { app.doc.asmCollide = e.target.checked; app.scheduleSave(); if (e.target.checked) await this.checkCollisions(); app.renderRight(); };
    el.querySelector('[data-mate]').onclick = () => this.startMate();
    const feat = (id) => app.doc.features.find((f) => f.id === id);
    el.querySelectorAll('[data-ground]').forEach((b) => (b.onclick = () => { app.snapshot(); const f = feat(b.dataset.ground); f.p.grounded = !f.p.grounded; app.changed(); }));
    el.querySelectorAll('[data-up]').forEach((b) => (b.onclick = async () => { await this.update(b.dataset.up); await this.checkUpdates(); app.renderRight(); }));
    el.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => { app.exitMode(); app.editFeature(b.dataset.edit); }));
    el.querySelectorAll('[data-openp]').forEach((b) => (b.onclick = () => { const f = feat(b.dataset.openp); if (f?.p.source?.projectId) app.openProject(f.p.source.projectId); }));
    el.querySelectorAll('[data-medit]').forEach((b) => (b.onclick = () => this.startMate(b.dataset.medit)));
    el.querySelectorAll('[data-msupp]').forEach((b) => (b.onclick = () => { app.snapshot(); const m = this.mates.find((x) => x.id === b.dataset.msupp); m.suppressed = !m.suppressed; app.changed(); }));
    el.querySelectorAll('[data-mdel]').forEach((b) => (b.onclick = () => { app.snapshot(); app.doc.mates = this.mates.filter((x) => x.id !== b.dataset.mdel); app.changed(); }));
  }

  // ---------- dragging components (in the assembly panel) ----------
  // The part follows the mouse in the view plane; on release its placement is set to where it was
  // dropped and the solver pulls it back onto its mates, so only the free directions really move.
  onDown(ev) {
    const app = this.app, vp = app.vp;
    const hit = vp.pick(ev, new Set(['body', 'face']));
    const { comp } = hit?.bodyId ? this.splitId(hit.bodyId) : {};
    const f = comp && this.components().find((c) => c.id === comp);
    if (!f) return;
    if (f.p.grounded || app.result.assembly?.free === 0) return app.toast(`${f.name} is grounded`, 'warn');
    const P = new THREE.Vector3(...hit.point), dir = new THREE.Vector3();
    vp.camera.getWorldDirection(dir);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(dir.negate(), P);
    const groups = [...vp.bodies].filter(([id]) => id.startsWith(`${comp}/`)).map(([, b]) => [b.group, b.group.position.clone()]);
    this.drag = { f, plane, P, groups, delta: new THREE.Vector3() };
    vp.controls.enabled = false;
  }
  onDrag(ev) {
    const d = this.drag;
    if (!d) return;
    const q = this.app.vp._setRay(ev).intersectPlane(d.plane, new THREE.Vector3());
    if (!q) return;
    d.delta.copy(q).sub(d.P);
    for (const [g, p0] of d.groups) g.position.copy(p0).add(d.delta);
    this.app.vp.requestRender();
  }
  onUp(moved) {
    const d = this.drag, app = this.app;
    this.drag = null;
    app.vp.controls.enabled = true;
    if (!d) return;
    if (!moved || d.delta.lengthSq() < 1e-12) { for (const [g, p0] of d.groups) g.position.copy(p0); return; }
    const T = app.result.assembly?.transforms?.[d.f.id] || { r: [0, 0, 0], t: [0, 0, 0] };
    const th = Math.hypot(...T.r), m = new THREE.Matrix4();
    if (th > 1e-12) m.makeRotationAxis(new THREE.Vector3(...T.r).divideScalar(th), th);
    const e = new THREE.Euler().setFromRotationMatrix(m, 'ZYX'), u = app.units.scale;
    const num = (v, k = 1) => String(+(v / k).toFixed(4));
    app.snapshot();
    Object.assign(d.f.p, { x: num(T.t[0] + d.delta.x, u), y: num(T.t[1] + d.delta.y, u), z: num(T.t[2] + d.delta.z, u), rx: num(THREE.MathUtils.radToDeg(e.x)), ry: num(THREE.MathUtils.radToDeg(e.y)), rz: num(THREE.MathUtils.radToDeg(e.z)) });
    app.changed();
  }

  // interference between bodies of different components (bodies of one part may overlap on purpose)
  async checkCollisions() {
    const app = this.app, ids = app.result.bodies.map((b) => b.id).filter((id) => app.bodyMeta(id).visible !== false);
    const compOf = (id) => this.splitId(id).comp || id;
    if (ids.length < 2) { this.coll = []; return this.coll; }
    let res = [];
    try { res = (await app.kernel.interference(ids)).results || []; } catch { res = []; }
    this.coll = res.filter((r) => compOf(r.a) !== compOf(r.b) && r.volume > 1e-3).map((r) => ({ a: app.bodyMeta(r.a).name, b: app.bodyMeta(r.b).name, volume: r.volume }));
    return this.coll;
  }

  // mates for the kernel (dropping display-only fields)
  forKernel() {
    const ref = (r) => ({ comp: r.comp, body: r.body, p: r.p, n: r.n, s: r.s, r: r.r });
    return this.mates.map((m) => ({ id: m.id, type: m.type, a: ref(m.a), b: ref(m.b), offset: m.offset, angle: m.angle, flip: m.flip, limit: !!m.limit, min: m.min, max: m.max, ratio: m.ratio, radius: m.radius, suppressed: m.suppressed }));
  }

  // after a solve: remember the radius of round mated faces, which helps find them again after the part changes
  learn(assembly) {
    let changed = false;
    for (const s of assembly?.mates || []) {
      const m = s.ok && this.mates.find((x) => x.id === s.id);
      if (!m) continue;
      if (s.ra && m.a.r !== s.ra) { m.a.r = s.ra; changed = true; }
      if (s.rb && m.b.r !== s.rb) { m.b.r = s.rb; changed = true; }
    }
    return changed;
  }
}
