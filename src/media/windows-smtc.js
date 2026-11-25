'use strict';
// Windows: talks to the system media session (the volume-flyout media card).
// Works with Spotify, Apple Music, iTunes, TIDAL, Deezer, Amazon Music, browsers
// (SoundCloud, YouTube Music…), foobar2000, MusicBee, etc.
const EventEmitter = require('events');
const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FRIENDLY = [
  [/spotify/i, 'Spotify'],
  [/applemusic|apple\.music|itunes/i, 'Apple Music'],
  [/tidal/i, 'TIDAL'],
  [/deezer/i, 'Deezer'],
  [/soundcloud/i, 'SoundCloud'],
  [/amazon.*music/i, 'Amazon Music'],
  [/youtube.?music|cinhimbnkkaeohfgghhklpknlkffjgod/i, 'YouTube Music'],
  [/zunemusic|mediaplayer/i, 'Media Player'],
  [/foobar/i, 'foobar2000'],
  [/musicbee/i, 'MusicBee'],
  [/cider/i, 'Cider'],
  [/msedge/i, 'Edge'],
  [/chrome/i, 'Chrome'],
  [/firefox/i, 'Firefox'],
  [/opera/i, 'Opera'],
  [/brave/i, 'Brave'],
  [/vlc/i, 'VLC']
];

function friendlyName(aumid) {
  for (const [re, name] of FRIENDLY) if (re.test(aumid)) return name;
  return String(aumid || 'Unknown').replace(/\.exe$/i, '').split(/[!_.]/)[0];
}

class SmtcSource extends EventEmitter {
  constructor() {
    super();
    this.name = 'Windows Media Session';
    this.lastError = null;
    this.art = new Map();
    this.backoff = 2000;
    this.firstSeen = new Map();   // window-title tracks: when we first saw them (for elapsed time)
    this.lastSummary = '';
  }

  start() {
    this.stopped = false;
    const src = path.join(__dirname, 'smtc.ps1');
    // PowerShell can't read from inside app.asar, so copy the script out first.
    const script = path.join(os.tmpdir(), 'tunecord-smtc.ps1');
    try {
      fs.writeFileSync(script, fs.readFileSync(src, 'utf8'), 'utf8');
    } catch (err) {
      this.fail(err);
      return;
    }
    const exe = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
    this.proc = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.proc.stdout.setEncoding('utf8');
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => this.onLine(line));
    this.proc.stderr.on('data', (d) => { this.lastError = String(d).trim().slice(0, 300); });
    this.proc.on('error', (err) => this.fail(err));
    this.proc.on('exit', () => {
      this.proc = null;
      if (this.stopped) return;
      this.emit('players', []);
      this.restart = setTimeout(() => this.start(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 60_000);
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.restart);
    if (this.proc) {
      try { this.proc.stdin.end(); } catch (_) { /* ignore */ }
      try { this.proc.kill(); } catch (_) { /* ignore */ }
    }
  }

  fail(err) {
    this.lastError = String((err && err.message) || err);
    this.emit('error', err);
  }

  onLine(line) {
    let data;
    try { data = JSON.parse(line.replace(/^﻿/, '')); } catch (_) { return; }
    if (data && data.error) { this.lastError = data.error; return; }
    if (!Array.isArray(data)) data = data ? [data] : [];
    this.backoff = 2000;
    this.lastError = null;

    const now = Date.now();
    this.logSessions(data);
    // Prefer the real media session; use the window title only when the app reports nothing useful.
    const realApps = new Set(data.filter((s) => !s.fromWindow && s.title).map((s) => friendlyName(s.aumid)));
    data = data.filter((s) => !s.fromWindow || !realApps.has(friendlyName(s.aumid)));
    const players = data.map((s) => {
      const key = `${s.artist || ''}|${s.title || ''}`.toLowerCase();
      let cached = this.art.get(s.id);
      if (s.art) this.art.set(s.id, cached = { key: s.artKey, data: s.art });
      const artUrl = cached && cached.key === s.artKey ? cached.data : null;
      const st = String(s.status || '').toLowerCase();
      let position = Number(s.position) || 0;
      if (s.fromWindow) {
        const fk = `${s.id}|${key}`;
        if (!this.firstSeen.has(fk)) {
          this.firstSeen.set(fk, now);
          if (this.firstSeen.size > 50) this.firstSeen.delete(this.firstSeen.keys().next().value);
        }
        position = (now - this.firstSeen.get(fk)) / 1000;
      }
      return {
        id: s.id,
        player: friendlyName(s.aumid),
        title: s.title || '',
        artist: s.artist || '',
        album: s.album || '',
        duration: Number(s.duration) || 0,
        position,
        fromWindow: !!s.fromWindow,
        canSeek: !s.fromWindow,
        status: st === 'playing' ? 'playing' : st === 'paused' ? 'paused' : 'stopped',
        artUrl,
        url: null,
        key,
        updatedAt: now
      };
    });
    this.emit('players', players);
  }

  /** Write what Windows reports to the Activity log whenever it changes (helps when a player isn't detected). */
  logSessions(data) {
    const summary = data.map((s) => `${s.aumid || '?'}${s.fromWindow ? ' (window title)' : ''}: ${s.title ? `"${s.title}"` : 'no title'} [${s.status}]`).join(' · ') || 'none';
    const shape = summary.replace(/"[^"]*"/g, 'x');
    if (shape === this.lastSummary) return;
    this.lastSummary = shape;
    this.emit('log', `Windows media sessions: ${summary}`);
  }

  async control(id, action, arg) {
    if (!this.proc) throw new Error('Media helper not running');
    this.proc.stdin.write(JSON.stringify({ id, action, arg }) + '\n');
  }
}

module.exports = { SmtcSource, friendlyName };
