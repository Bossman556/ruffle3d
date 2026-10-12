// Decals: images (logos, labels, graphics) projected onto a body's faces for renders and screenshots.
// Stored in doc.decals as { id, name, data (data URL), aspect, body, p, n, width, angle, opacity, visible }.
// Display-only: they never change the geometry.
import { icon } from './icons.js';
import { readImage } from './canvas.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const decalList = (doc) => (doc.decals ||= []);

export class DecalManager {
  constructor(app) { this.app = app; this.placing = null; }

  add() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/png,image/jpeg,image/webp,image/svg+xml';
    inp.onchange = async () => {
      const file = inp.files[0];
      if (!file) return;
      let img;
      try { img = await readImage(file, 1024); } catch (e) { return this.app.toast(e.message, 'warn'); }
      const d = { id: `dc${Date.now().toString(36)}`, name: file.name.replace(/\.[a-z0-9]+$/i, ''), data: img.data, aspect: img.aspect, body: null, p: null, n: null, width: 30, angle: 0, opacity: 1, visible: true };
      this.startPlace(d, true);
    };
    inp.click();
  }

  // Click a face to put the decal there (new decals are added on the first click).
  startPlace(d, isNew = false) {
    const app = this.app;
    app.closeModal();
    app.exitMode();
    this.placing = { d, isNew };
    app.mode = 'decalpick';
    app.banner(`Click a face to place “${esc(d.name)}”`, () => app.exitMode());
  }

  place(hit) {
    const app = this.app, pl = this.placing;
    if (!pl || !hit || (hit.kind !== 'face' && hit.kind !== 'plane') || !hit.bodyId) return;
    app.snapshot();
    const d = pl.d;
    Object.assign(d, { body: hit.bodyId, p: hit.point, n: hit.normal });
    // a sensible first size: about a third of the body
    if (pl.isNew) {
      const bb = app.vp.bodies.get(hit.bodyId)?.data.geo.geo.boundingBox;
      if (bb) d.width = Math.max(1, +(bb.min.distanceTo(bb.max) * 0.3).toFixed(1));
      decalList(app.doc).push(d);
    }
    this.placing = null;
    app.mode = null;
    app.banner(null);
    app.scheduleSave();
    app.display(app.result);
    this.open(d.id);
  }

  open(selId) {
    const app = this.app, list = decalList(app.doc);
    let sel = list.find((c) => c.id === selId) || list[0];
    const m = app.modal('Decals', '<div class="canv"></div>', { wide: true, ic: 'decal', cancel: false, sub: 'Images on the model for renders' });
    const apply = () => { app.scheduleSave(); app.display(app.result); };
    const draw = () => {
      const u = app.units;
      m.querySelector('.canv').innerHTML = `
        <div class="canv-list">
          ${list.map((c) => `<button class="canv-item ${c === sel ? 'on' : ''}" data-id="${c.id}"><img src="${c.data}" alt="" style="object-fit:contain;background:#fff"><span>${esc(c.name)}</span>${c.visible === false ? icon('eyeOff') : ''}</button>`).join('') || '<p class="muted">No decals yet.</p>'}
          <button class="btn sm" data-add style="width:100%">${icon('plus')}Add image…</button>
        </div>
        <div class="canv-edit">${sel ? `
          <div class="field"><label>Name</label><input class="input" data-name value="${esc(sel.name)}"></div>
          <div class="field"><label>On</label><span>${sel.body ? esc(app.bodyMeta(sel.body).name) : '<i class="muted">Not placed</i>'}</span></div>
          <div class="field"><label>Width</label><div class="num"><input data-w type="number" step="0.5" value="${+(sel.width / u.scale).toFixed(3)}"><span class="unit">${u.label}</span></div></div>
          <div class="field"><label>Rotation</label><div class="num"><input data-a type="number" step="5" value="${sel.angle}"><span class="unit">°</span></div></div>
          <div class="field"><label>Opacity</label><input type="range" min="0.1" max="1" step="0.05" value="${sel.opacity}" data-op></div>
          <div class="field check"><label>Visible</label><label class="switch"><input type="checkbox" data-vis ${sel.visible !== false ? 'checked' : ''}><span></span></label></div>
          <div class="help">Decals are projected straight onto the faces under them, so they follow gentle curves. Use a PNG with transparency for logos.</div>
          <div class="bom-actions"><button class="btn sm" data-move>${icon('move')}Move…</button><button class="btn sm" data-del>${icon('trash')}Remove</button></div>` : '<p class="muted">Add a logo, label or graphic, then click the face to put it on.</p>'}</div>`;
      m.querySelectorAll('.canv-item').forEach((b) => (b.onclick = () => { sel = list.find((c) => c.id === b.dataset.id); draw(); }));
      m.querySelector('[data-add]').onclick = () => this.add();
      if (!sel) return;
      m.querySelector('[data-name]').onchange = (e) => { sel.name = e.target.value.trim() || sel.name; apply(); draw(); };
      m.querySelector('[data-w]').oninput = (e) => { const v = +e.target.value; if (v > 0) { sel.width = v * app.units.scale; apply(); } };
      m.querySelector('[data-a]').oninput = (e) => { const v = +e.target.value; if (Number.isFinite(v)) { sel.angle = v; apply(); } };
      m.querySelector('[data-op]').oninput = (e) => { sel.opacity = +e.target.value; apply(); };
      m.querySelector('[data-vis]').onchange = (e) => { sel.visible = e.target.checked; apply(); draw(); };
      m.querySelector('[data-move]').onclick = () => this.startPlace(sel);
      m.querySelector('[data-del]').onclick = () => { app.snapshot(); list.splice(list.indexOf(sel), 1); sel = list[0]; apply(); draw(); };
    };
    draw();
  }
}
