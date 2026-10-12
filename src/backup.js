// Keeping projects safe beyond browser storage:
//  - asks the browser to keep this site's storage persistent (not cleared when space runs low);
//  - optional project folder (File System Access API, Chrome / Edge): every save also writes the
//    project as a .ruffle3d.json file there;
//  - backups: one .zip with every project and saved version, and restoring from it.
import { makeZip } from './export3mf.js';
import { store, newProjectId } from './store.js';

const safeName = (s) => String(s || 'design').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80).trim() || 'design';

// ---------- persistent storage ----------
export async function requestPersistence() {
  try {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch { return null; }
}
export async function storageInfo() {
  try {
    const [persisted, est] = await Promise.all([navigator.storage?.persisted?.(), navigator.storage?.estimate?.()]);
    return { persisted: !!persisted, usage: est?.usage || 0, quota: est?.quota || 0 };
  } catch { return { persisted: false, usage: 0, quota: 0 }; }
}

// ---------- project folder ----------
const FS_DB = 'ruffle3d-fs';
function fsDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(FS_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('handles');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function kv(mode, fn) {
  const db = await fsDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('handles', mode), s = t.objectStore('handles');
    const req = fn(s);
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}
export const folderSupported = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;
export async function getFolder() { try { return (await kv('readonly', (s) => s.get('dir'))) || null; } catch { return null; } }
export async function chooseFolder() {
  const h = await window.showDirectoryPicker({ id: 'ruffle3d-projects', mode: 'readwrite' });
  await kv('readwrite', (s) => s.put(h, 'dir'));
  return h;
}
export async function forgetFolder() { await kv('readwrite', (s) => s.delete('dir')); }
/** 'granted' | 'prompt' | 'denied' | 'none' */
export async function folderState(ask = false) {
  const h = await getFolder();
  if (!h) return 'none';
  try {
    let p = await h.queryPermission({ mode: 'readwrite' });
    if (p === 'prompt' && ask) p = await h.requestPermission({ mode: 'readwrite' });
    return p;
  } catch { return 'denied'; }
}
/** Writes one project file into the folder (silently skipped without permission). */
export async function writeToFolder(projectId, doc) {
  const h = await getFolder();
  if (!h) return false;
  try {
    if ((await h.queryPermission({ mode: 'readwrite' })) !== 'granted') return false;
    const file = await h.getFileHandle(`${safeName(doc.name)} (${projectId}).ruffle3d.json`, { create: true });
    const w = await file.createWritable();
    await w.write(JSON.stringify({ format: 'ruffle3d', version: 1, projectId, saved: new Date().toISOString(), doc }));
    await w.close();
    return true;
  } catch { return false; }
}

// ---------- backups ----------
export async function backupAll() {
  const enc = new TextEncoder(), entries = [];
  const list = await store.listProjects();
  for (const meta of list) {
    const p = await store.getProject(meta.id);
    if (!p) continue;
    const versions = await store.listVersions(meta.id);
    const base = `${safeName(p.name)} (${p.id})`;
    entries.push({ name: `${base}/project.ruffle3d.json`, data: enc.encode(JSON.stringify({ format: 'ruffle3d', version: 1, projectId: p.id, name: p.name, doc: p.doc, thumb: p.thumb })) });
    for (const v of versions) entries.push({ name: `${base}/versions/${v.id}.json`, data: enc.encode(JSON.stringify({ label: v.label, time: v.time, doc: v.doc, thumb: v.thumb })) });
  }
  entries.push({ name: 'README.txt', data: enc.encode(`Ruffle3D backup, ${new Date().toISOString()}\n${list.length} project(s). Restore it from the Projects page: Restore backup.\nEach project.ruffle3d.json can also be opened on its own with Open file.\n`) });
  return { zip: await makeZip(entries), projects: list.length };
}

async function inflateRaw(u8) {
  const ds = new DecompressionStream('deflate-raw');
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer());
}
/** Reads a ZIP (stored or deflated entries) into [{ name, data }]. */
export async function readZip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This is not a ZIP file');
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder(), out = [];
  for (let i = 0; i < n; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('The ZIP file is damaged');
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nl));
    const lnl = dv.getUint16(lo + 26, true), lxl = dv.getUint16(lo + 28, true);
    const raw = u8.subarray(lo + 30 + lnl + lxl, lo + 30 + lnl + lxl + csize);
    out.push({ name, data: method === 8 ? await inflateRaw(raw) : method === 0 ? raw.slice() : null });
    p += 46 + nl + xl + cl;
  }
  return out;
}

/** Restores projects from a backup ZIP as new projects (nothing is overwritten). Returns the count. */
export async function restoreBackup(buf) {
  const files = await readZip(buf), dec = new TextDecoder();
  const groups = new Map();
  for (const f of files) {
    if (!f.data) continue;
    const m = f.name.match(/^(.+?)\/(project\.ruffle3d\.json|versions\/.+\.json)$/);
    if (!m) continue;
    if (!groups.has(m[1])) groups.set(m[1], { project: null, versions: [] });
    const g = groups.get(m[1]);
    const json = JSON.parse(dec.decode(f.data));
    if (m[2] === 'project.ruffle3d.json') g.project = json; else g.versions.push(json);
  }
  let n = 0;
  for (const g of groups.values()) {
    if (!g.project?.doc) continue;
    const id = newProjectId();
    await store.saveProject({ id, name: g.project.name || g.project.doc.name, doc: g.project.doc, thumb: g.project.thumb });
    for (const v of g.versions.sort((a, b) => a.time - b.time)) await store.addVersion(id, v.label, v.doc, v.thumb, v.time);
    n++;
  }
  if (!n) throw new Error('No Ruffle3D projects were found in this file');
  return n;
}
