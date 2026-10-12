// Project dashboard: recent projects (with thumbnails), templates, search and project management.
import { icon } from './icons.js';
import { store, newProjectId } from './store.js';
import { TEMPLATES } from './demo.js';
import { backupAll, restoreBackup, folderSupported, chooseFolder, forgetFolder, folderState, getFolder, writeToFolder, storageInfo } from './backup.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ago = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'Edited just now';
  if (s < 3600) return `Edited ${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `Edited ${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `Edited ${Math.floor(s / 86400)} d ago`;
  return `Edited ${new Date(t).toLocaleDateString()}`;
};
const TPL_ICON = { 'blank-mm': 'plus', 'blank-in': 'plus', bracket: 'hole', enclosure: 'shell', surface: 'surfloft' };

export class Home {
  constructor(app) {
    this.app = app;
    this.el = document.getElementById('home');
    this.isOpen = false;
    this.view = 'recent';
    this.query = '';
  }

  async open(view = 'recent') {
    this.view = view;
    this.isOpen = true;
    this.el.classList.add('open');
    try { this.folder = await folderState(); this.persist = (await storageInfo()).persisted; } catch { /* unsupported */ }
    await this.render();
    this.el.querySelector('.home-search')?.focus();
  }

  close() {
    this.isOpen = false;
    this.el.classList.remove('open');
  }

  onKey(e) {
    if (e.key === 'Escape' && this.app.projectId) this.close();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); this.open('templates'); }
  }

  async render() {
    const projects = await store.listProjects();
    const q = this.query.toLowerCase();
    const shown = projects.filter((p) => !q || p.name.toLowerCase().includes(q));
    const tplCards = TEMPLATES.map((t) => `
      <div class="card ${t.id.startsWith('blank') ? 'new' : ''}" data-tpl="${t.id}">
        <div class="thumb">${t.thumb ? `<img src="${t.thumb}" alt="">` : icon(TPL_ICON[t.id] || 'cube')}</div>
        <div class="meta"><b>${esc(t.name)}</b><small>${esc(t.sub)}</small></div>
      </div>`).join('');
    const projCards = shown.map((p) => `
      <div class="card" data-open="${p.id}">
        <div class="thumb">${p.thumb ? `<img src="${p.thumb}" alt="">` : icon('cube')}</div>
        <div class="meta"><b>${esc(p.name)}</b><small>${ago(p.updated)} · ${p.features} feature${p.features === 1 ? '' : 's'}</small></div>
        <div class="card-menu"><button class="iconbtn" data-pmenu="${p.id}">${icon('more')}</button></div>
      </div>`).join('');
    this.el.innerHTML = `
      <aside class="home-side">
        <div class="logo">${icon('logo')}<span>Ruffle<em>3D</em></span></div>
        <button class="nav ${this.view === 'recent' ? 'on' : ''}" data-view="recent">${icon('clock')}Recent</button>
        <button class="nav ${this.view === 'templates' ? 'on' : ''}" data-view="templates">${icon('dashboard')}New from template</button>
        <div class="spacer"></div>
        <button class="nav" data-act="openfile">${icon('open')}Open file…</button>
        <button class="nav" data-act="backup">${icon('download')}Back up all projects</button>
        <button class="nav" data-act="restore">${icon('upload')}Restore backup…</button>
        ${folderSupported() ? `<button class="nav" data-act="folder">${icon('folder')}${this.folder === 'granted' ? 'Project folder: on' : this.folder === 'prompt' ? 'Reconnect project folder' : 'Save to a folder…'}</button>` : ''}
        ${this.persist === false ? `<div class="home-warn">${icon('warn')}Your browser may clear projects when disk space runs low. Back up regularly${folderSupported() ? ' or turn on a project folder' : ''}.</div>` : ''}
        <button class="nav" data-act="prefs">${icon('settings')}Preferences</button>
        ${this.app.projectId ? `<button class="nav" data-act="back">${icon('exit')}Back to design</button>` : ''}
      </aside>
      <main class="home-main">
        <div class="home-hero">
          <div><h1>${this.view === 'templates' ? 'Start a new design' : projects.length ? 'Welcome back' : 'Welcome to Ruffle3D'}</h1>
            <p>${this.view === 'templates' ? 'Pick a starting point. Every template is fully parametric.' : 'Parametric 3D CAD for product design — sketch, model, assemble, render and document.'}</p></div>
          <div style="display:flex;gap:8px;align-items:center">
            ${this.view === 'recent' ? `<input class="input home-search" placeholder="Search projects…" value="${esc(this.query)}">` : ''}
            <button class="btn primary" data-tpl="blank-mm">${icon('plus')}New design</button>
          </div>
        </div>
        ${this.view === 'templates' ? `<div class="cards tpl">${tplCards}</div>` : `
          <div class="home-section">Start from a template</div>
          <div class="cards tpl">${tplCards}</div>
          <div class="home-section">Recent projects <span class="badge">${projects.length}</span></div>
          ${projCards ? `<div class="cards">${projCards}</div>` : `<div class="empty">${icon('folder')}${q ? 'No projects match your search.' : 'No projects yet — start from a template above.'}</div>`}`}
      </main>`;
    const el = this.el;
    el.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => { this.view = b.dataset.view; this.render(); }));
    el.querySelectorAll('[data-tpl]').forEach((b) => (b.onclick = async () => {
      const t = TEMPLATES.find((x) => x.id === b.dataset.tpl);
      const doc = t.make();
      if (t.id.startsWith('blank')) doc.name = 'Untitled design';
      await this.app.createProject(doc);
    }));
    el.querySelectorAll('[data-open]').forEach((c) => (c.onclick = (e) => { if (!e.target.closest('[data-pmenu]')) this.app.openProject(c.dataset.open); }));
    el.querySelectorAll('[data-pmenu]').forEach((b) => (b.onclick = (e) => {
      e.stopPropagation();
      const id = b.dataset.pmenu;
      const r = b.getBoundingClientRect();
      this.app.showCtx(r.left - 150, r.bottom + 4, [
        { label: 'Open', icon: 'open', fn: () => this.app.openProject(id) },
        { label: 'Rename', icon: 'pencil', fn: () => this.rename(id) },
        { label: 'Duplicate', icon: 'copy', fn: () => this.duplicate(id) },
        '-',
        { label: 'Delete', icon: 'trash', danger: true, fn: () => this.remove(id) },
      ]);
    }));
    const search = el.querySelector('.home-search');
    if (search) search.oninput = () => { this.query = search.value; this.render().then(() => { const s = this.el.querySelector('.home-search'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }); };
    el.querySelector('[data-act=openfile]').onclick = () => this.app.openFile();
    el.querySelector('[data-act=backup]').onclick = async () => {
      try {
        const { zip, projects } = await backupAll();
        this.app.download(new Blob([zip], { type: 'application/zip' }), `Ruffle3D backup ${new Date().toISOString().slice(0, 10)}.zip`);
        this.app.toast(`Backed up ${projects} project${projects === 1 ? '' : 's'} with their versions`, 'ok');
      } catch (e) { this.app.toast(`Backup failed: ${e.message}`, 'warn'); }
    };
    el.querySelector('[data-act=restore]').onclick = () => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.zip';
      inp.onchange = async () => {
        const f = inp.files[0];
        if (!f) return;
        try { const n = await restoreBackup(await f.arrayBuffer()); this.app.toast(`Restored ${n} project${n === 1 ? '' : 's'} from ${f.name}`, 'ok'); this.render(); } catch (e) { this.app.toast(e.message, 'warn'); }
      };
      inp.click();
    };
    el.querySelector('[data-act=folder]')?.addEventListener('click', async () => {
      try {
        if (this.folder === 'prompt') this.folder = await folderState(true);
        else if (this.folder === 'granted') {
          const h = await getFolder();
          this.app.modal('Project folder', `<p>Every save also writes the project to <b>${h?.name || 'your folder'}</b> as a <code>.ruffle3d.json</code> file, so your work is safe even if the browser's storage is cleared.</p>`, { ic: 'folder', okLabel: 'Choose another folder', onOk: () => { this.pickFolder(); } });
          const m = document.querySelector('#modal .panel-foot');
          if (m) { const off = document.createElement('button'); off.className = 'btn ghost'; off.textContent = 'Stop saving to the folder'; off.onclick = async () => { await forgetFolder(); this.folder = 'none'; this.app.closeModal(); this.render(); }; m.prepend(off); }
          return;
        } else return this.pickFolder();
        this.render();
      } catch (e) { if (e.name !== 'AbortError') this.app.toast(e.message, 'warn'); }
    });
    el.querySelector('[data-act=prefs]').onclick = () => this.app.openPrefs();
    el.querySelector('[data-act=back]')?.addEventListener('click', () => this.close());
  }

  async pickFolder() {
    try {
      await chooseFolder();
      this.folder = await folderState();
      // write every project once so the folder is complete straight away
      let n = 0;
      for (const meta of await store.listProjects()) { const p = await store.getProject(meta.id); if (p && (await writeToFolder(p.id, p.doc))) n++; }
      this.app.toast(`Saving to the folder. ${n} project${n === 1 ? '' : 's'} written.`, 'ok');
      this.render();
    } catch (e) { if (e.name !== 'AbortError') this.app.toast(e.message, 'warn'); }
  }

  async rename(id) {
    const p = await store.getProject(id);
    this.app.prompt('Rename project', p.name, async (v) => {
      if (!v) return;
      p.name = v; p.doc.name = v;
      await store.saveProject(p);
      if (this.app.projectId === id) { this.app.doc.name = v; this.app.refreshAll(); }
      this.render();
    });
  }

  async duplicate(id) {
    const p = await store.getProject(id);
    const doc = structuredClone(p.doc);
    doc.name = `${p.name} (copy)`;
    await store.saveProject({ id: newProjectId(), name: doc.name, doc, thumb: p.thumb });
    this.render();
  }

  async remove(id) {
    const p = await store.getProject(id);
    const m = this.app.modal('Delete project', `<p>Delete <b>${esc(p.name)}</b> and all its saved versions? This cannot be undone.</p>`, {
      ic: 'trash', okLabel: 'Delete project',
      onOk: async () => {
        await store.deleteProject(id);
        if (this.app.projectId === id) { this.app.projectId = null; try { localStorage.removeItem('ruffle3d.lastProject'); } catch { /* ignore */ } }
        this.render();
      },
    });
    m.querySelector('[data-m=ok]').classList.add('danger');
    m.querySelector('[data-m=ok]').style.background = 'var(--danger)';
  }
}
