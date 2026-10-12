// Captures real screenshots of the Ruffle3D interface for the website, using headless Chrome / Edge over the
// DevTools protocol (no extra dependencies). Uses a throw-away browser profile.
// Usage: npm run package && node scripts/capture-screens.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'site', 'assets', 'img', 'screens');
mkdirSync(out, { recursive: true });
const browsers = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'];
const exe = browsers.find((b) => existsSync(b));
if (!exe) throw new Error('Chrome or Edge is needed to capture screenshots');

const PORT = 5199, DBG = 9339, W = 1600, H = 1000;
const server = spawn(process.execPath, [path.join(root, 'scripts', 'serve.mjs'), path.join(root, 'website'), String(PORT)], { stdio: 'ignore' });
const profile = path.join(tmpdir(), `ruffle3d-capture-${Date.now()}`);
const chrome = spawn(exe, ['--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`, '--hide-scrollbars', '--enable-unsafe-swiftshader', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let ws, seq = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
  writeFileSync(path.join(out, `${name}.jpg`), Buffer.from(data, 'base64'));
  console.log('  ✓', name);
};

try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await wait(300);
    try { target = (await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* starting */ }
  }
  if (!target) throw new Error('Could not connect to the headless browser');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => { const d = JSON.parse(m.data); const p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result); } };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1.25, mobile: false });
  await send('Page.navigate', { url: `http://localhost:${PORT}/app/` });
  await wait(9000);

  const helpers = `
    const a = window.app, wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const ready = async () => { for (let i = 0; i < 120 && (a.booting || a.building || a.kernel?.building); i++) await wait(250); await wait(600); };
    const tpl = async (id) => { a.home.open('templates'); await wait(300); document.querySelector('[data-tpl=' + id + ']').click(); await wait(1500); await ready(); };
  `;
  // projects for the dashboard (thumbnails are written when each project saves)
  await evaluate(`${helpers} for (const t of ['enclosure', 'surface', 'bracket']) { await tpl(t); a.scheduleSave(true); await wait(1500); } return true;`);
  await evaluate(`${helpers} a.home.open('recent'); await wait(1200); return true;`);
  await shot('dashboard');

  // solid modelling: bracket, body selected, inspector with mass properties
  await evaluate(`${helpers} a.home.close(); a.designTab = 'solid'; a.renderToolbar(); a.vp.setView([1, -1.25, 0.95], false); a.vp.fitAll(false); await wait(500);
    a.selection = [{ kind: 'body', bodyId: 'exA' }]; a.updateHighlights(); a.renderRight(); a.renderLeft(); await wait(2500); return true;`);
  await shot('design-solid');

  // parametric sketch editing
  await evaluate(`${helpers} a.selection = []; a.updateHighlights(); a.editFeature('skA'); await wait(1800); return true;`);
  await shot('sketch');
  await evaluate(`${helpers} a.sketcher.end(false); await wait(800); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await wait(800); return true;`);

  // appearance editor
  await evaluate(`${helpers} a.selection = [{ kind: 'body', bodyId: 'exA' }]; a.runCommand('appearance'); await wait(1500); return true;`);
  await shot('appearance');
  await evaluate(`${helpers} a.exitMode(); await wait(400); return true;`);

  // drawing workspace, with a section through the bracket
  await evaluate(`${helpers} a.drawing.opts.section = 'Y'; a.drawing.opts.sectionAt = 50; a.drawing.opts.dims = false; a.setWorkspace('drawing'); await wait(6000);
    // a few placed annotations: overall length with tolerance, a hole diameter, height, a note and a flatness frame
    const dw = a.drawing, V = dw.layout.views, fr = V.front.rect, pts = dw.snaps.front.pts;
    const lo = pts.reduce((p, q) => (q[1] > p[1] ? q : p)), hi = pts.reduce((p, q) => (q[1] < p[1] ? q : p));
    const left = pts.filter((p) => Math.abs(p[1] - lo[1]) < 1e-6).reduce((p, q) => (q[0] < p[0] ? q : p)), right = pts.filter((p) => Math.abs(p[1] - lo[1]) < 1e-6).reduce((p, q) => (q[0] > p[0] ? q : p));
    const id = () => 'cap' + Math.random().toString(36).slice(2, 7);
    const c = dw.snaps.top.circles.filter((x) => x.full).sort((p, q) => p.r - q.r)[0];
    a.doc.dwgAnno = [
      { id: id(), t: 'lin', view: 'front', a: left, b: right, at: V.front.toView(fr[0], fr[3] + 17), dir: 'h', tol: '±0.1' },
      { id: id(), t: 'lin', view: 'front', a: lo, b: hi, at: V.front.toView(fr[0] - 10, fr[1]), dir: 'v' },
      { id: id(), t: 'dia', view: 'top', c: c.c, r: c.r, at: [c.c[0] + c.r * 2.5, c.c[1] + c.r * 2.5] },
      { id: id(), t: 'gdt', at: [fr[2] - 30, fr[1] - 8], leader: [fr[2] - 40, fr[1] + 0.2], sym: 'flatness', tol: '0.05', datums: '' },
      { id: id(), t: 'note', at: [12 + 14, dw.layout.H - 52], leader: null, text: 'NOTES\\n1. BREAK ALL SHARP EDGES 0.3 MAX\\n2. ANODISE BLACK' },
    ];
    dw.render(); await wait(800); return true;`);
  await shot('drawing');
  await evaluate(`${helpers} a.drawing.opts.section = 'none'; a.setWorkspace('design'); await wait(1000); return true;`);

  // surfacing: mouse shell with curvature map
  await evaluate(`${helpers} a.home.open('recent'); await wait(800);
    const card = [...document.querySelectorAll('[data-open]')].find((c) => c.innerText.includes('Mouse Shell')); card.click(); await wait(1500); await ready();
    a.designTab = 'surface'; a.renderToolbar(); a.vp.setView([0.9, -1.1, 0.75], false); a.vp.fitAll(false); await wait(500);
    a.runCommand('curvmap'); await wait(7000); return true;`);
  await shot('surface-curvature');
  await evaluate(`${helpers} a.runCommand('zebra'); await wait(1500); return true;`);
  await shot('surface-zebra');
  await evaluate(`${helpers} a.exitMode(); await wait(500); return true;`);

  // CV surface editing
  await evaluate(`${helpers} await tpl('blank-mm'); a.designTab = 'surface'; a.renderToolbar();
    a.openFeature('cvsurface', null, { w: '80', l: '60', nu: '6', nv: '5' }); await wait(800); await a.okCommand(); await ready();
    const fid = a.doc.features[0].id; a.startCVEdit(fid); await wait(500);
    const s = a.cvEdit.s; for (const [i, dz] of [[13, 18], [14, 14], [19, 10], [8, 8], [9, 12]]) s.pts[i][2] += dz; a.cvEdit.commit(); await ready();
    a.cvEdit.resync(); s.sel = new Set([13]); a.cvEdit.render(); a.renderRight();
    a.vp.setView([0.8, -1.2, 0.8], false); a.vp.fitAll(false); await wait(1200); return true;`);
  await shot('cv-edit');
  await evaluate(`${helpers} a.exitMode(); return true;`);

  // render workspace
  await evaluate(`${helpers} a.home.open('recent'); await wait(800);
    const card = [...document.querySelectorAll('[data-open]')].find((c) => c.innerText.includes('Mouse Shell')); card.click(); await wait(1500); await ready();
    a.setWorkspace('render'); a.vp.setEnvironment('studio'); await wait(1500); a.vp.setView([0.9, -1.1, 0.75], false); a.vp.fitAll(false); await wait(2000); return true;`);
  await shot('render');

  // stress simulation: a cantilevered aluminium arm with two holes, 400 N on the free end
  await evaluate(`${helpers} await tpl('blank-mm'); a.doc.name = 'Arm study';
    a.doc.features = [
      { id: 'arm', type: 'box', name: 'Arm', p: { w: '160', d: '30', h: '12', x: '0', y: '0', z: '0', op: 'new' } },
      { id: 'hl', type: 'hole', name: 'Holes', p: { points: [{ body: 'arm', p: [-20, 0, 12], n: [0, 0, 1] }, { body: 'arm', p: [30, 0, 12], n: [0, 0, 1] }], diameter: '12', through: true, depth: '10' } },
    ];
    a.doc.marker = 2; a.doc.bodies = { arm: { name: 'Arm', material: 'aluminum' } }; a.changed(); await ready();
    a.doc.sim = { body: 'arm', mesh: 'medium', fixed: [{ body: 'arm', p: [-80, 0, 6], n: [-1, 0, 0] }], loads: [{ id: 'L1', type: 'force', value: 400, dir: '-Z', faces: [{ body: 'arm', p: [80, 0, 6], n: [1, 0, 0] }] }] };
    a.setWorkspace('simulate'); await wait(500); await a.sim.solve(); await wait(800);
    a.vp.setView([0.75, -1.3, 0.8], false); a.vp.fitAll(false); await wait(1500); return true;`);
  await shot('simulation');
  // generative design on the same arm: keep 35% of the material
  await evaluate(`${helpers} a.doc.sim.genMesh = 'coarse'; a.doc.sim.volume = 35; a.sim.setType('topology'); await a.sim.solve(); await wait(800);
    a.vp.setView([0.75, -1.3, 0.8], false); a.vp.fitAll(false); await wait(1200); return true;`);
  await shot('generative');
  // CNC toolpaths on the arm: facing, profile and drilling
  await evaluate(`${helpers} a.sim.setType('static'); a.setWorkspace('manufacture'); await wait(500);
    const c = a.camws.cam; c.setup.top = 1;
    c.ops = [{ id: 'f', type: 'face', tool: 'fm25', faces: [] }, { id: 'd', type: 'drill', tool: 'dr8', faces: [{ body: 'arm', p: [-14, 0, 6], n: [-1, 0, 0] }, { body: 'arm', p: [36, 0, 6], n: [-1, 0, 0] }] }, { id: 'p', type: 'profile', tool: 'em6', side: 'outside', through: true, faces: [{ body: 'arm', p: [60, 10, 12], n: [0, 0, 1] }] }];
    await a.camws.compute(); a.camws.sel = null; a.renderRight();
    a.vp.setView([0.75, -1.3, 0.9], false); a.vp.fitAll(false); await wait(1200); return true;`);
  await shot('manufacture');
  await evaluate(`${helpers} a.sim.setType('static'); a.setWorkspace('design'); await wait(500); return true;`);

  // assembly: a base plate, two pins and a top plate, positioned by mates
  const mates = await evaluate(`${helpers}
    const mk = async (id, name, features, bodies) => { await tpl('blank-mm'); a.doc.name = name; a.doc.features = features; a.doc.marker = features.length; a.doc.bodies = bodies; a.changed(); await ready(); a.scheduleSave(true); await wait(1200); return a.projectId; };
    const plate = (mat) => [{ id: 'pl', type: 'box', name: 'Plate', p: { w: '90', d: '40', h: '8', x: '0', y: '0', z: '0', op: 'new' } }, { id: 'ho', type: 'hole', name: 'Holes', p: { points: [{ body: 'pl', p: [-30, 0, 8], n: [0, 0, 1] }, { body: 'pl', p: [30, 0, 8], n: [0, 0, 1] }], diameter: '8', through: true, depth: '8' } }];
    const base = await mk('base', 'Base plate', plate(), { pl: { name: 'Base', material: 'aluminum' } });
    const top = await mk('top', 'Top plate', plate(), { pl: { name: 'Top', material: 'pla' } });
    const pin = await mk('pin', 'Guide pin', [{ id: 'pn', type: 'cylinder', name: 'Pin', p: { r: '4', h: '36', axis: 'Z', x: '0', y: '0', z: '0', op: 'new' } }], { pn: { name: 'Pin', material: 'steel' } });
    await tpl('blank-mm'); a.doc.name = 'Guide assembly'; a.changed(); await ready();
    for (const id of [base, pin, pin, top]) { await a.asm.add(id); await ready(); }
    const [B, P1, P2, T] = a.asm.components().map((c) => c.id);
    const r = (comp, body, p, n) => ({ comp, body, p, n, world: p, wbody: comp + '/' + body });
    const hole = (C, x) => r(C, 'pl', [x + 4, 0, 4], [-1, 0, 0]), side = (C) => r(C, 'pn', [4, 0, 18], [1, 0, 0]);
    a.doc.mates = [
      { id: 'm1', type: 'concentric', a: hole(B, -30), b: side(P1) }, { id: 'm2', type: 'flush', a: r(B, 'pl', [0, 15, 0], [0, 0, -1]), b: r(P1, 'pn', [1, 0, 0], [0, 0, -1]) },
      { id: 'm3', type: 'concentric', a: hole(B, 30), b: side(P2) }, { id: 'm4', type: 'flush', a: r(B, 'pl', [0, 15, 0], [0, 0, -1]), b: r(P2, 'pn', [1, 0, 0], [0, 0, -1]) },
      { id: 'm5', type: 'concentric', a: hole(T, -30), b: side(P1) }, { id: 'm6', type: 'concentric', a: hole(T, 30), b: side(P2) },
      { id: 'm7', type: 'distance', offset: 18, a: r(B, 'pl', [0, 15, 8], [0, 0, 1]), b: r(T, 'pl', [0, 15, 0], [0, 0, -1]) },
    ];
    a.designTab = 'solid'; a.renderToolbar(); a.changed(); await ready(); await a.asm.openPanel(); await wait(400);
    a.vp.setView([0.9, -1.4, 0.75], false); a.vp.fitAll(false); await wait(1500);
    return a.result.assembly.mates.map((m) => m.id + ':' + m.ok).join(' ') + ' dof ' + a.result.assembly.dof;`);
  console.log('  assembly mates', mates);
  await shot('assembly');
  await evaluate(`${helpers} a.exitMode(); return true;`);

  // light theme
  await evaluate(`${helpers} a.setWorkspace('design'); a.home.open('recent'); await wait(500);
    const card = [...document.querySelectorAll('[data-open]')].find((c) => c.innerText.includes('Electronics')); card.click(); await wait(1500); await ready();
    a.setPref('theme', 'light'); a.designTab = 'solid'; a.renderToolbar(); a.vp.setView([1, -1.1, 1.1], false); a.vp.fitAll(false); await wait(1500); return true;`);
  await shot('light-theme');
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  chrome.kill();
  server.kill();
  await wait(800);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* profile still locked */ }
}
