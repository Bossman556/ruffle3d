// Bridge between the desktop shell and the app page (the page itself has no Node access).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ruffleDesktop', {
  platform: process.platform,
  ready: () => ipcRenderer.send('ready'),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, cmd) => cb(cmd)),
});
