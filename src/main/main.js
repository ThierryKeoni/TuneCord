'use strict';
const path = require('path');
const {
  app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut,
  nativeImage, shell, clipboard, dialog
} = require('electron');
const fs = require('fs');

const HEADLESS = process.argv.includes('--headless');
const START_HIDDEN = process.argv.includes('--hidden');

if (HEADLESS && process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform', 'headless');
app.setName('TuneCord');

/* ---- crash log: %APPDATA%\TuneCord\logs\main.log (Windows) ---- */
const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'main.log');
function fileLog(msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    try { if (fs.statSync(LOG_FILE).size > 1_000_000) fs.renameSync(LOG_FILE, LOG_FILE + '.old'); } catch (_) { /* new */ }
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) { /* nowhere to log */ }
}
let fatalShown = false;
function fatal(err) {
  const text = (err && err.stack) || String(err);
  fileLog(`FATAL ${text}`);
  if (HEADLESS || fatalShown) return;
  fatalShown = true;
  const show = () => dialog.showErrorBox('TuneCord ran into a problem',
    `${(err && err.message) || err}\n\nDetails were saved to:\n${LOG_FILE}\n\nPlease send that file to the developer.`);
  if (app.isReady()) show(); else app.whenReady().then(show);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', (r) => fileLog(`Unhandled rejection: ${(r && r.stack) || r}`));
fileLog(`Starting TuneCord ${app.getVersion()} on ${process.platform} ${require('os').release()} (${process.arch})`);

// Broken GPU drivers can make windows never appear: after a GPU crash, start in software mode.
const NO_GPU_FLAG = path.join(app.getPath('userData'), 'disable-gpu');
if (fs.existsSync(NO_GPU_FLAG) || process.argv.includes('--disable-gpu')) app.disableHardwareAcceleration();
app.on('child-process-gone', (_e, d) => {
  fileLog(`Child process gone: ${d.type} ${d.reason} (${d.exitCode})`);
  if (d.type === 'GPU' && d.reason !== 'clean-exit') {
    try { fs.writeFileSync(NO_GPU_FLAG, 'gpu crashed'); } catch (_) { /* ignore */ }
  }
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function main() {
  const { Config } = require('../core/config');
  const { History } = require('../core/history');
  const { Engine } = require('../core/engine');
  const { DiscordConnection } = require('../core/discord');
  const { RemoteServer } = require('../core/remote');
  const { createMediaSource } = require('../media');
  const platform = require('./platform');

  const ASSETS = path.join(__dirname, '..', '..', 'assets');
  let win = null;
  let tray = null;
  let quitting = false;
  let config, history, engine, discord, remote;
  const logs = [];

  function log(msg) {
    fileLog(msg);
    const line = `${new Date().toLocaleTimeString()}  ${msg}`;
    logs.push(line);
    if (logs.length > 200) logs.shift();
    if (HEADLESS) console.log(line);
    send('log', line);
  }

  function send(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  /* ---------------- window ---------------- */

  function createWindow() {
    const compact = config.get().app.compact;
    win = new BrowserWindow({
      width: compact ? 440 : 1080,
      height: compact ? 104 : 720,
      minWidth: compact ? 400 : 860,
      minHeight: compact ? 104 : 580,
      show: false,
      backgroundColor: '#111214',
      title: 'TuneCord',
      icon: path.join(ASSETS, 'icon.png'),
      autoHideMenuBar: true,
      alwaysOnTop: compact,
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    const wantShow = !(START_HIDDEN || config.get().app.startHidden);
    win.once('ready-to-show', () => { if (wantShow && win) win.show(); });
    setTimeout(() => { if (wantShow && win && !win.isVisible()) { fileLog('ready-to-show timeout, forcing show'); win.show(); } }, 8000);
    win.webContents.on('did-fail-load', (_e, code, desc) => fileLog(`UI failed to load: ${code} ${desc}`));
    win.webContents.on('render-process-gone', (_e, d) => {
      fileLog(`UI process gone: ${d.reason}`);
      if (d.reason !== 'clean-exit' && win) win.reload();
    });
    win.on('close', (e) => {
      if (!quitting && config.get().app.closeToTray && tray) {
        e.preventDefault();
        win.hide();
        if (process.platform === 'darwin' && app.dock) app.dock.hide();
      }
    });
    win.on('closed', () => { win = null; });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e) => e.preventDefault());
  }

  function showWindow() {
    if (!win) createWindow();
    if (process.platform === 'darwin' && app.dock) app.dock.show();
    win.show();
    win.focus();
  }

  function setCompact(on) {
    config.set({ app: { compact: !!on } });
    if (!win) return;
    if (on) {
      win.setMinimumSize(400, 104);
      win.setSize(440, 104, true);
      win.setAlwaysOnTop(true, 'floating');
    } else {
      win.setAlwaysOnTop(false);
      win.setMinimumSize(860, 580);
      win.setSize(1080, 720, true);
      win.center();
    }
  }

  /* ---------------- tray ---------------- */

  function trayIcon() {
    if (process.platform === 'darwin') {
      const img = nativeImage.createFromPath(path.join(ASSETS, 'trayTemplate.png'));
      img.setTemplateImage(true);
      return img;
    }
    return nativeImage.createFromPath(path.join(ASSETS, process.platform === 'win32' ? 'tray.ico' : 'tray.png'));
  }

  const DISCORD_LABEL = {
    ready: 'connected', connecting: 'connecting…', disconnected: 'not running',
    'no-client-id': 'needs an Application ID', 'bad-client-id': 'wrong Application ID'
  };

  let trayKey = '';
  function updateTray(state) {
    if (!tray) return;
    const c = state.current;
    const key = [state.enabled, c && c.title, c && c.status, state.discord.status].join('|');
    if (key === trayKey) return;
    trayKey = key;
    const nowPlaying = c ? `${c.status === 'playing' ? '▶' : '⏸'}  ${c.title}${c.artist ? ' — ' + c.artist : ''}` : 'Nothing playing';
    tray.setToolTip(`TuneCord\n${nowPlaying.slice(0, 100)}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: nowPlaying.slice(0, 60), enabled: false },
      { label: `Discord: ${DISCORD_LABEL[state.discord.status] || state.discord.status}`, enabled: false },
      { type: 'separator' },
      { label: 'Show on Discord', type: 'checkbox', checked: state.enabled, click: () => engine.toggleStatus() },
      { type: 'separator' },
      { label: c && c.status === 'playing' ? 'Pause' : 'Play', enabled: !!c, click: () => engine.control('playpause') },
      { label: 'Next', enabled: !!c, click: () => engine.control('next') },
      { label: 'Previous', enabled: !!c, click: () => engine.control('previous') },
      { type: 'separator' },
      { label: 'Open TuneCord', click: showWindow },
      { label: 'Mini player', type: 'checkbox', checked: config.get().app.compact, click: (i) => { setCompact(i.checked); showWindow(); } },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } }
    ]));
  }

  /* ---------------- hotkeys ---------------- */

  function registerHotkeys() {
    globalShortcut.unregisterAll();
    const hk = config.get().hotkeys;
    const bind = (accel, fn, name) => {
      if (!accel) return;
      try {
        if (!globalShortcut.register(accel, fn)) log(`Hotkey ${accel} (${name}) is taken by another app`);
      } catch (_) {
        log(`Hotkey "${accel}" is not valid`);
      }
    };
    bind(hk.toggleStatus, () => log(`Discord status ${engine.toggleStatus() ? 'on' : 'off'} (hotkey)`), 'toggle status');
    bind(hk.playPause, () => engine.control('playpause'), 'play/pause');
    bind(hk.next, () => engine.control('next'), 'next');
    bind(hk.previous, () => engine.control('previous'), 'previous');
  }

  /* ---------------- IPC ---------------- */

  function registerIpc() {
    const QRCode = require('qrcode');
    const { BUILTIN_CLIENT_ID } = require('../core/app-id');

    ipcMain.handle('init', () => ({
      state: engine.getState(),
      config: config.get(),
      logs,
      platform: process.platform,
      version: app.getVersion(),
      builtinClientId: !!BUILTIN_CLIENT_ID
    }));
    ipcMain.handle('config:set', (_e, patch) => config.set(patch));
    ipcMain.handle('config:replace', (_e, p, v) => {
      if (!['sources.rename', 'discord.perPlayer', 'sources.blocked', 'privacy.hideList'].includes(p)) throw new Error('Not allowed');
      return config.replace(p, v);
    });
    ipcMain.handle('control', (_e, action, arg) => engine.control(action, arg));
    ipcMain.handle('player:select', (_e, name) => engine.selectPlayer(name));
    ipcMain.handle('status:toggle', (_e, force) => engine.toggleStatus(force));
    ipcMain.handle('preview', (_e, tpls) => engine.renderPreview(tpls));
    ipcMain.handle('stats:get', () => history.stats());
    ipcMain.handle('stats:clear', () => { history.clear(); return history.stats(); });
    ipcMain.handle('qr:make', (_e, text) => QRCode.toDataURL(String(text), { margin: 1, width: 280, color: { dark: '#111214', light: '#ffffff' } }));
    ipcMain.handle('discord:test', () => engine.sendTestPresence());
    ipcMain.handle('discord:reconnect', () => { discord.reconnect(); return discord.getState(); });
    ipcMain.handle('remote:info', () => remote.info());
    ipcMain.handle('remote:regen', () => {
      config.set({ remote: { token: require('crypto').randomBytes(12).toString('base64url') } });
      remote.stop(); remote.sync();
      return remote.info();
    });
    ipcMain.handle('open:url', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
    ipcMain.handle('copy', (_e, text) => clipboard.writeText(String(text)));
    ipcMain.handle('window:compact', (_e, on) => setCompact(on));
    ipcMain.handle('logs:open', () => shell.openPath(LOG_DIR));
    ipcMain.handle('app:quit', () => { quitting = true; app.quit(); });
  }

  /* ---------------- boot ---------------- */

  app.whenReady().then(() => boot()).catch(fatal);

  function boot() {
    const dataDir = app.getPath('userData');
    config = new Config(dataDir);
    history = new History(dataDir);
    discord = new DiscordConnection();
    engine = new Engine({ config, media: createMediaSource(), discord, history });
    remote = new RemoteServer({ engine, config });

    engine.on('log', log);
    let lastPush = 0;
    let pending = null;
    engine.on('state', (state) => {
      updateTray(state);
      const now = Date.now();
      if (now - lastPush > 250) { lastPush = now; send('state', state); return; }
      clearTimeout(pending);
      pending = setTimeout(() => { lastPush = Date.now(); send('state', engine.getState()); }, 260);
    });
    let prev = {};
    discord.on('state', (s) => {
      if (s.status !== prev.status) {
        if (s.status === 'ready') log(`Connected to Discord as ${s.user ? s.user.name : 'you'}`);
        else if (s.status === 'bad-client-id') log('Discord says the Application ID is wrong');
        else if (s.status === 'disconnected' && prev.status === 'ready') log('Discord closed — waiting for it to come back');
      }
      prev = s;
    });

    config.on('change', (_data, patch) => {
      if (patch.hotkeys) registerHotkeys();
      if (patch.remote) remote.sync();
      if (patch.app && 'autostart' in patch.app) {
        try { platform.setAutostart(app, patch.app.autostart); } catch (err) { log(`Autostart: ${err.message}`); }
      }
      send('config', config.get());
    });

    registerIpc();
    engine.start();
    discord.start();
    engine.tick(); // sets the right Application ID straight away
    remote.sync();

    if (HEADLESS) {
      if (process.platform === 'darwin' && app.dock) app.dock.hide();
      log('TuneCord running headless.');
      return;
    }

    try {
      tray = new Tray(trayIcon());
    } catch (err) {
      fileLog(`Tray unavailable: ${err.message}`);
    }
    if (tray) {
      tray.on('click', () => (process.platform === 'win32' ? showWindow() : undefined));
      updateTray(engine.getState());
    }
    registerHotkeys();
    createWindow();
  }

  app.on('second-instance', () => { if (!HEADLESS) showWindow(); });
  app.on('activate', () => { if (!HEADLESS) showWindow(); });
  app.on('window-all-closed', () => {
    if (HEADLESS || tray) return;
    app.quit();
  });
  app.on('before-quit', () => {
    quitting = true;
    try { globalShortcut.unregisterAll(); } catch (_) { /* ignore */ }
    try { discord && discord.clearNow(); } catch (_) { /* ignore */ }
    try { engine && engine.stop(); } catch (_) { /* ignore */ }
    try { discord && discord.stop(); } catch (_) { /* ignore */ }
    try { remote && remote.stop(); } catch (_) { /* ignore */ }
    try { history && history.close(); } catch (_) { /* ignore */ }
  });
}
