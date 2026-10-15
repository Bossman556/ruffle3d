// Ruffle3D desktop app (Electron). Serves the built app (dist/) from a private app:// origin so the
// WebAssembly kernel, module workers and the project database work exactly as in a browser, shows the
// window once the loading screen has painted, and adds native menus, window-state memory and a single
// running instance.
const { app, BrowserWindow, Menu, protocol, net, shell, dialog, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const DIST = path.join(__dirname, '..', 'dist');
const ORIGIN = 'app://ruffle3d';
const ICON = path.join(__dirname, '..', 'build', 'icon.png');
const DOCS = 'https://ruffle3d-website.vercel.app/docs/index.html';
const REPO = 'https://github.com/Bossman556/ruffle3d';

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

if (!app.requestSingleInstanceLock()) app.quit();

// ---------- window state ----------
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return { maximized: true }; }
}
function saveState(win) {
  try {
    const maximized = win.isMaximized();
    fs.writeFileSync(stateFile(), JSON.stringify({ bounds: maximized ? win.getNormalBounds() : win.getBounds(), maximized }));
  } catch { /* not critical */ }
}

// ---------- project files opened from the system (double-click, Open with, or a second launch) ----------
// Files arrive before the page can take them, so they wait in a queue until it says it is ready.
let pageReady = false;
const queue = [];
const projectArgs = (argv) => argv.filter((a) => /\.ruffle3d$/i.test(a) && fs.existsSync(a));
function openFiles(paths) {
  for (const p of paths) {
    try {
      if (fs.statSync(p).size > 500e6) throw new Error('the file is too large');
      queue.push({ name: path.basename(p), text: fs.readFileSync(p, 'utf8') });
    } catch (e) { dialog.showErrorBox('Could not open the file', `${path.basename(p)}: ${e.message}`); }
  }
  flush();
}
function flush() {
  if (!pageReady || !win) return;
  while (queue.length) win.webContents.send('open-file', queue.shift());
}
ipcMain.on('ready', () => { pageReady = true; flush(); });
app.on('open-file', (e, p) => { e.preventDefault(); openFiles([p]); }); // macOS

let win = null;
function createWindow() {
  const st = loadState();
  win = new BrowserWindow({
    ...(st.bounds || { width: 1440, height: 900 }),
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#111419',
    title: 'Ruffle3D',
    icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  // the loading screen is the page's first paint, so the window never shows blank
  win.once('ready-to-show', () => { if (st.maximized) win.maximize(); win.show(); });
  win.on('close', () => saveState(win));
  // links to the web open in the normal browser; nothing else may open windows or navigate away
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(ORIGIN)) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
  win.webContents.on('did-start-loading', () => { pageReady = false; });
  win.loadURL(`${ORIGIN}/index.html`);
}

// ---------- menus ----------
// Shortcuts the page already handles are shown in the menu but not captured by it
// (registerAccelerator: false), so the keys behave the same with or without the menu.
const send = (cmd) => win?.webContents.send('menu', cmd);
const shown = (accelerator) => ({ accelerator, registerAccelerator: false });
function about() {
  dialog.showMessageBox(win, {
    type: 'info',
    title: 'About Ruffle3D',
    message: `Ruffle3D ${app.getVersion()}`,
    detail: `Parametric CAD for product design. Free and open source under the GNU GPL v3 or later.\n${REPO}\n\nGeometry kernel: OpenCascade (LGPL 2.1)\nElectron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
    icon: ICON,
  });
}
function buildMenu() {
  const mac = process.platform === 'darwin';
  const tpl = [
    ...(mac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Design…', ...shown('CmdOrCtrl+N'), click: () => send('new') },
        { label: 'All Projects', click: () => send('home') },
        { label: 'Open File…', click: () => send('openfile') },
        { type: 'separator' },
        { label: 'Save', ...shown('CmdOrCtrl+S'), click: () => send('save') },
        { label: 'Save Version…', click: () => send('version') },
        { label: 'Export STEP…', click: () => send('export:step') },
        { label: 'Export STL…', click: () => send('export:stl') },
        { type: 'separator' },
        { label: 'Back Up All Projects…', click: () => send('backup') },
        { type: 'separator' },
        mac ? { role: 'close' } : { role: 'quit', label: 'Exit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', ...shown('CmdOrCtrl+Z'), click: () => send('undo') },
        { label: 'Redo', ...shown('CmdOrCtrl+Y'), click: () => send('redo') },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { type: 'separator' },
        { label: 'Search Commands…', ...shown('CmdOrCtrl+K'), click: () => send('palette') },
        { label: 'Preferences…', click: () => send('prefs') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom to Fit', ...shown('F6'), click: () => send('fit') },
        { label: 'Show or Hide Panels', ...shown('Tab'), click: () => send('panels') },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Actual Size' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'reload', label: 'Reload' },
        { role: 'toggleDevTools', label: 'Developer Tools' },
      ],
    },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        { label: 'Documentation', click: () => shell.openExternal(DOCS) },
        { label: 'Keyboard Shortcuts', click: () => send('shortcuts') },
        { type: 'separator' },
        { label: 'Source Code and Contributing', click: () => shell.openExternal(REPO) },
        { label: 'Report a Problem…', click: () => shell.openExternal(`${REPO}/issues/new/choose`) },
        { label: 'Donate to Ruffle3D…', click: () => shell.openExternal('https://ruffle3d-website.vercel.app/donate.html') },
        { type: 'separator' },
        { label: 'Check for Updates…', click: () => send('updates') },
        { label: 'Open Data Folder', click: () => shell.openPath(app.getPath('userData')) },
        ...(mac ? [] : [{ type: 'separator' }, { label: 'About Ruffle3D', click: about }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

app.on('second-instance', (_e, argv) => {
  openFiles(projectArgs(argv));
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  // serve dist/ (also from inside the packaged asar archive)
  protocol.handle('app', (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  if (process.platform === 'darwin') app.setAboutPanelOptions({ applicationName: 'Ruffle3D', applicationVersion: app.getVersion(), credits: 'Free and open source (GPL-3.0-or-later). Geometry kernel: OpenCascade.' });
  buildMenu();
  createWindow();
  openFiles(projectArgs(process.argv.slice(1)));
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
