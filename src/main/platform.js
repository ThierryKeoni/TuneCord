'use strict';
// OS integration: start at login.
const fs = require('fs');
const os = require('os');
const path = require('path');

function launchCommand(app) {
  // AppImage sets $APPIMAGE to the real file; process.execPath points into a temp mount.
  const exe = process.env.APPIMAGE || process.execPath;
  const args = app.isPackaged ? [] : [path.resolve(__dirname, '..', '..')];
  return { exe, args };
}

function quote(s) {
  return /[\s"'\\]/.test(s) ? `"${String(s).replace(/(["\\$`])/g, '\\$1')}"` : s;
}

function setAutostart(app, enabled) {
  if (process.platform === 'linux') {
    const dir = path.join(os.homedir(), '.config', 'autostart');
    const file = path.join(dir, 'tunecord.desktop');
    if (!enabled) { try { fs.unlinkSync(file); } catch (_) { /* not there */ } return; }
    const { exe, args } = launchCommand(app);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, [
      '[Desktop Entry]',
      'Type=Application',
      'Name=TuneCord',
      'Comment=Show your music as your Discord status',
      `Exec=${[exe, ...args, '--hidden'].map(quote).join(' ')}`,
      'X-GNOME-Autostart-enabled=true',
      'Terminal=false',
      ''
    ].join('\n'));
    return;
  }
  app.setLoginItemSettings({ openAtLogin: !!enabled, args: ['--hidden'] });
}

module.exports = { setAutostart };
