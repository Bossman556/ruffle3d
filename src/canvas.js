// Canvases: reference images (photos, sketches, blueprints) placed on a plane to model over.
// Stored in doc.canvases as { id, name, data (data URL), aspect, plane, width, x, y, offset, angle,
// opacity, flip, visible }. They are display-only and never part of the geometry.
import { icon } from './icons.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const MAX_SIDE = 2048; // images are downscaled so projects stay small

export function canvasList(doc) { return (doc.canvases ||= []); }

// Reads an image file, downscales it and returns { data, aspect }.
export function readImage(file, maxSide = MAX_SIDE) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxSide / Math.max(img.naturalWidth || maxSide, img.naturalHeight || maxSide));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round((img.naturalWidth || maxSide) * k)); c.height = Math.max(1, Math.round((img.naturalHeight || maxSide) * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const png = /png|webp|gif|svg/i.test(file.type);
      resolve({ data: c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.9), aspect: c.height / c.width });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This file is not an image the browser can read')); };
    img.src = url;
  });
}

export class CanvasManager {
  constructor(app) { this.app = app; }

  add() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/png,image/jpeg,image/webp,image/gif';
    inp.onchange = async () => {
      const file = inp.files[0];
      if (!file) return;
      let img;
      try { img = await readImage(file); } catch (e) { return this.app.toast(e.message, 'warn'); }
      this.app.snapshot();
      const c = { id: `cv${Date.now().toString(36)}`, name: file.name.replace(/\.[a-z0-9]+$/i, ''), data: img.data, aspect: img.aspect, plane: 'XZ', width: 100, x: 0, y: 0, offset: 0, angle: 0, opacity: 0.6, flip: false, visible: true };
      canvasList(this.app.doc).push(c);
      this.app.scheduleSave();
      this.app.display(this.app.result);
      this.open(c.id);
    };
    inp.click();
  }

  // Manager modal: list on the left, settings for the selected canvas on the right.
  open(selId) {
    const app = this.app, list = canvasList(app.doc);
    let sel = list.find((c) => c.id === selId) || list[0];
    const m = app.modal('Canvases', '<div class="canv"></div>', { wide: true, ic: 'canvas', cancel: false, sub: 'Reference images to model over' });
    const apply = () => { app.scheduleSave(); app.display(app.result); };
    const draw = () => {
      const u = app.units;
      const num = (k, label, unit, step = 1) => `<div class="field"><label>${label}</label><div class="num"><input data-n="${k}" value="${+(k === 'width' || k === 'x' || k === 'y' || k === 'offset' ? sel[k] / u.scale : sel[k]).toFixed(4)}" type="number" step="${step}"><span class="unit">${unit}</span></div></div>`;
      m.querySelector('.canv').innerHTML = `
        <div class="canv-list">
          ${list.map((c) => `<button class="canv-item ${c === sel ? 'on' : ''}" data-id="${c.id}"><img src="${c.data}" alt=""><span>${esc(c.name)}</span>${c.visible === false ? icon('eyeOff') : ''}</button>`).join('') || '<p class="muted">No canvases yet.</p>'}
          <button class="btn sm" data-add style="width:100%">${icon('plus')}Add image…</button>
        </div>
        <div class="canv-edit">${sel ? `
          <div class="field"><label>Name</label><input class="input" data-name value="${esc(sel.name)}"></div>
          <div class="field"><label>Plane</label><div class="seg" data-plane>${['XY', 'XZ', 'YZ'].map((p) => `<button data-v="${p}" class="${sel.plane === p ? 'on' : ''}">${p}</button>`).join('')}</div></div>
          ${num('width', 'Width', u.label)}
          <div class="help" style="margin:-2px 0 6px">Height follows the image: ${+(sel.width * sel.aspect / u.scale).toFixed(2)} ${u.label}. Set the width to a known size on the image to calibrate it.</div>
          ${num('x', 'Centre X', u.label)}${num('y', 'Centre Y', u.label)}${num('offset', 'Offset from plane', u.label)}${num('angle', 'Rotation', '°', 1)}
          <div class="field"><label>Opacity</label><input type="range" min="0.05" max="1" step="0.05" value="${sel.opacity}" data-op></div>
          <div class="field check"><label>Mirror</label><label class="switch"><input type="checkbox" data-flip ${sel.flip ? 'checked' : ''}><span></span></label></div>
          <div class="field check"><label>Visible</label><label class="switch"><input type="checkbox" data-vis ${sel.visible !== false ? 'checked' : ''}><span></span></label></div>
          <div class="bom-actions"><button class="btn sm" data-del>${icon('trash')}Remove</button></div>` : '<p class="muted">Add a photo or sketch of your product, then set its size so it matches the model.</p>'}</div>`;
      m.querySelectorAll('.canv-item').forEach((b) => (b.onclick = () => { sel = list.find((c) => c.id === b.dataset.id); draw(); }));
      m.querySelector('[data-add]').onclick = () => { app.closeModal(); this.add(); };
      if (!sel) return;
      m.querySelector('[data-name]').onchange = (e) => { sel.name = e.target.value.trim() || sel.name; apply(); draw(); };
      m.querySelectorAll('[data-plane] button').forEach((b) => (b.onclick = () => { sel.plane = b.dataset.v; apply(); draw(); }));
      m.querySelectorAll('[data-n]').forEach((inp) => (inp.oninput = () => {
        const k = inp.dataset.n, v = +inp.value;
        if (!Number.isFinite(v) || (k === 'width' && v <= 0)) return;
        sel[k] = k === 'angle' ? v : v * app.units.scale;
        apply();
      }));
      m.querySelector('[data-op]').oninput = (e) => { sel.opacity = +e.target.value; apply(); };
      m.querySelector('[data-flip]').onchange = (e) => { sel.flip = e.target.checked; apply(); };
      m.querySelector('[data-vis]').onchange = (e) => { sel.visible = e.target.checked; apply(); draw(); };
      m.querySelector('[data-del]').onclick = () => { app.snapshot(); list.splice(list.indexOf(sel), 1); sel = list[0]; apply(); draw(); };
    };
    draw();
  }
}
