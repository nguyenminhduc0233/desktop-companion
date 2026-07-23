// Safe bridge exposed to the pet renderer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  isElectron: true,
  platform: process.platform,
  apiFetch: (url, options) => ipcRenderer.invoke('api-fetch', { url, options }),
  onCursor: (cb) => ipcRenderer.on('cursor', (_e, data) => cb(data)),
  setInteractive: (b) => ipcRenderer.send('set-interactive', b),
  moveBy: (dx, dy) => ipcRenderer.send('move-by', { dx, dy }),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  quit: () => ipcRenderer.send('quit')
});
