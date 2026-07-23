// Desktop Companion — Electron main process.
// Creates a transparent, frameless, always-on-top, click-through window that
// hosts the character overlay. Tracks the OS cursor (so the pet can look at
// it), proxies AI API calls (no CORS), and provides a tray menu.
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, shell } = require('electron');
const path = require('path');

let win, tray, cursorTimer;
const WIN_W = 320, WIN_H = 460;

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    width: WIN_W, height: WIN_H,
    x: wa.x + wa.width - WIN_W, y: wa.y + wa.height - WIN_H,
    transparent: true, frame: false, resizable: false, movable: true,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: false, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Start click-through; the renderer turns it off while the cursor is over the pet.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  // Feed the OS cursor position to the renderer (~12fps) for gaze/follow.
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    try {
      const p = screen.getCursorScreenPoint();
      const b = win.getBounds();
      const disp = screen.getDisplayNearestPoint({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }).workArea;
      win.webContents.send('cursor', { x: p.x, y: p.y, bounds: b, screen: disp });
    } catch (e) {}
  }, 80);

  win.on('closed', () => { clearInterval(cursorTimer); win = null; });
}

function createTray() {
  try {
    tray = new Tray(path.join(__dirname, '..', 'src', 'assets', 'normal.png'));
    const menu = Menu.buildFromTemplate([
      { label: 'Hiện / Ẩn', click: () => { if (!win) return; win.isVisible() ? win.hide() : win.show(); } },
      { label: 'Luôn nổi trên cùng', type: 'checkbox', checked: true, click: (mi) => win && win.setAlwaysOnTop(mi.checked, 'screen-saver') },
      { type: 'separator' },
      { label: 'Thoát', click: () => { app.isQuiting = true; app.quit(); } }
    ]);
    tray.setToolTip('Desktop Companion');
    tray.setContextMenu(menu);
    tray.on('click', () => { if (win) (win.isVisible() ? win.focus() : win.show()); });
  } catch (e) { /* tray icon optional */ }
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// Tray app: keep running when the window closes (quit only via tray).
app.on('window-all-closed', () => { /* stay alive */ });

// ---- IPC ----
ipcMain.on('set-interactive', (_e, interactive) => {
  if (!win) return;
  if (interactive) win.setIgnoreMouseEvents(false);
  else win.setIgnoreMouseEvents(true, { forward: true });
});

ipcMain.on('move-by', (_e, { dx, dy }) => {
  if (!win) return;
  const b = win.getBounds();
  win.setBounds({ x: Math.round(b.x + dx), y: Math.round(b.y + dy), width: b.width, height: b.height });
});

ipcMain.on('quit', () => { app.isQuiting = true; app.quit(); });

ipcMain.on('open-external', (_e, url) => { try { shell.openExternal(url); } catch (e) {} });

// AI proxy — bypasses browser CORS (so OpenAI/Ollama/etc. all work in the app).
ipcMain.handle('api-fetch', async (_e, { url, options }) => {
  try {
    const res = await fetch(url, options || {});
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: String((err && err.message) || err) };
  }
});
