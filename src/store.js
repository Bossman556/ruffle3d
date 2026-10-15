// Local project storage (IndexedDB): projects with thumbnails, plus saved versions per project.
const DB = 'ruffle3d';
const OLD_DB = 'forge3d'; // the app was called Forge3D before; its data is copied over once
let dbp = null;

// One-time copy of localStorage keys from the old app name.
for (const k of ['prefs', 'lastProject', 'designTab', 'autosave.v1']) {
  try { if (localStorage.getItem(`ruffle3d.${k}`) == null && localStorage.getItem(`forge3d.${k}`) != null) localStorage.setItem(`ruffle3d.${k}`, localStorage.getItem(`forge3d.${k}`)); } catch { /* storage disabled */ }
}

function openDb(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('versions')) {
        const v = db.createObjectStore('versions', { keyPath: 'id' });
        v.createIndex('project', 'projectId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Copies projects and versions from the old Forge3D database (kept intact) the first time Ruffle3D opens.
async function migrate(db) {
  try {
    if (localStorage.getItem('ruffle3d.migrated')) return;
    const names = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : [OLD_DB];
    if (names.includes(OLD_DB)) {
      const old = await openDb(OLD_DB);
      for (const store of ['projects', 'versions']) {
        if (!old.objectStoreNames.contains(store)) continue;
        const rows = await new Promise((res, rej) => { const r = old.transaction(store, 'readonly').objectStore(store).getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); });
        await new Promise((res, rej) => {
          const t = db.transaction(store, 'readwrite');
          const os = t.objectStore(store);
          for (const row of rows) os.add(row).onerror = (e) => { e.preventDefault(); e.stopPropagation(); }; // keep existing rows
          t.oncomplete = res; t.onerror = () => rej(t.error);
        });
      }
      old.close();
    }
    localStorage.setItem('ruffle3d.migrated', '1');
  } catch { /* migration is best-effort */ }
}

function open() {
  if (dbp) return dbp;
  dbp = openDb(DB).then(async (db) => { await migrate(db); return db; });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((r) => (out = r));
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
  });
}
const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const newProjectId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const store = {
  async listProjects() {
    const all = await tx('projects', 'readonly', (s) => req2p(s.getAll()));
    // the list view does not need the full documents
    return (all || []).map(({ doc, ...meta }) => ({ ...meta, features: doc?.features?.length || 0 })).sort((a, b) => b.updated - a.updated);
  },
  async getProject(id) { return tx('projects', 'readonly', (s) => req2p(s.get(id))); },
  async saveProject(p) { return tx('projects', 'readwrite', (s) => req2p(s.put({ ...p, updated: Date.now() }))); },
  async deleteProject(id) {
    const vs = await this.listVersions(id);
    await tx('versions', 'readwrite', (s) => Promise.all(vs.map((v) => req2p(s.delete(v.id)))));
    return tx('projects', 'readwrite', (s) => req2p(s.delete(id)));
  },
  async listVersions(projectId) {
    const all = await tx('versions', 'readonly', (s) => req2p(s.index('project').getAll(projectId)));
    return (all || []).sort((a, b) => b.time - a.time);
  },
  async addVersion(projectId, label, doc, thumb, time = Date.now()) {
    const v = { id: `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, projectId, label, doc, thumb, time };
    await tx('versions', 'readwrite', (s) => req2p(s.put(v)));
    return v;
  },
  async getVersion(id) { return tx('versions', 'readonly', (s) => req2p(s.get(id))); },
};

// ---------- preferences ----------
const PREF_KEY = 'ruffle3d.prefs';
export const DEFAULT_PREFS = {
  theme: 'dark', nav: 'ruffle', shadows: true, ao: false, edges: true, viewcube: true, grid: true, fov: 40,
  tooltips: true, autosave: true, accent: 'blue', colorIcons: true, vpBg: 'default', updates: true,
};
export function loadPrefs() {
  try {
    const p = { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') };
    if (p.nav === 'forge') p.nav = 'ruffle';
    return p;
  } catch { return { ...DEFAULT_PREFS }; }
}
export function savePrefs(p) {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* storage disabled */ }
}
export function resolvedTheme(pref) {
  if (pref === 'system') return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  return pref || 'dark';
}
