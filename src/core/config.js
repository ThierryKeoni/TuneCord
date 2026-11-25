'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');

const DEFAULTS = {
  statusEnabled: true,

  presence: {
    activityType: 'listening',  // 'listening' ("Listening to …") | 'playing' ("Playing …")
    statusLine: 'artist',       // what the member list shows after "Listening to": 'artist' | 'title' | 'app'
    // Tokens: {title} {artist} {album} {player} {emoji} {status} {position} {duration}
    // [ ... ] disappears when a token inside it is empty.
    details: '{title}',
    state: '{artist}',
    largeText: '{album}',
    timestamps: 'progress',     // 'progress' (bar with both times) | 'elapsed' | 'none'
    icon: 'state',              // small icon: 'state' (play/pause) | 'none'
    buttons: ['source', 'none'],// each: 'none' | 'source' | 'spotify' | 'appleMusic' | 'youtubeMusic' | 'tidal' | 'soundcloud' | 'deezer' | 'youtube'
    clickableText: true         // title/artist are links in Discord
  },

  paused: {
    behavior: 'show',           // 'clear' | 'show' (marked as paused) | 'keep'
    graceSec: 0,
    clearAfterMin: 15           // stop showing a paused song after this many minutes (0 = never)
  },

  sources: {
    mode: 'auto',               // 'auto' | 'pinned'
    pinned: null,
    blocked: [],                // player names to ignore, e.g. ["Spotify"] if Discord already shows it
    rename: {}                  // { "Chrome": "SoundCloud" }
  },

  privacy: {
    hideList: [],
    hiddenText: '🎵 Listening to music'
  },

  discord: {
    clientId: '',               // empty = built-in one (see src/core/app-id.js)
    appName: 'Music',           // only for the in-app preview: the name of your Discord application
    perPlayer: {}               // { "Apple Music": "1234…" } → "Listening to Apple Music"
  },

  remote: {
    enabled: false,
    port: 47778,
    token: null
  },

  hotkeys: {
    toggleStatus: 'CommandOrControl+Alt+D',
    playPause: '',
    next: '',
    previous: ''
  },

  history: { enabled: true },

  app: {
    autostart: false,
    startHidden: false,
    closeToTray: true,
    compact: false,
    theme: 'auto'               // 'auto' (album art) | 'discord'
  }
};

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (isPlainObject(v) && isPlainObject(base[k])) out[k] = deepMerge(base[k], v);
    else out[k] = v;
  }
  return out;
}

class Config extends EventEmitter {
  constructor(dir) {
    super();
    this.file = path.join(dir, 'config.json');
    this.data = deepMerge(DEFAULTS, {});
    try {
      this.data = deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch (_) { /* first run */ }
    if (!this.data.remote.token) this.data.remote.token = crypto.randomBytes(12).toString('base64url');
    this.data.configVersion = 1;
    this.validate();
    this.save();
  }

  get() { return this.data; }

  set(patch) {
    this.data = deepMerge(this.data, patch);
    this.validate();
    this.save();
    this.emit('change', this.data, patch);
    return this.data;
  }

  /** Replace a map-like setting entirely (deepMerge can't delete keys). */
  replace(pathStr, value) {
    const keys = pathStr.split('.');
    let o = this.data;
    for (const k of keys.slice(0, -1)) o = o[k];
    o[keys.at(-1)] = value;
    this.validate();
    this.save();
    const patch = keys.reverse().reduce((acc, k) => ({ [k]: acc }), value);
    this.emit('change', this.data, patch);
    return this.data;
  }

  validate() {
    const d = this.data;
    const p = d.presence;
    if (!['listening', 'playing'].includes(p.activityType)) p.activityType = 'listening';
    if (!['artist', 'title', 'app'].includes(p.statusLine)) p.statusLine = 'artist';
    if (!['progress', 'elapsed', 'none'].includes(p.timestamps)) p.timestamps = 'progress';
    if (!['state', 'none'].includes(p.icon)) p.icon = 'state';
    if (!Array.isArray(p.buttons)) p.buttons = ['source', 'none'];
    p.buttons = [p.buttons[0] || 'none', p.buttons[1] || 'none'];
    if (!['clear', 'show', 'keep'].includes(d.paused.behavior)) d.paused.behavior = 'show';
    d.paused.graceSec = clamp(+d.paused.graceSec || 0, 0, 3600);
    d.paused.clearAfterMin = clamp(+d.paused.clearAfterMin || 0, 0, 1440);
    d.remote.port = clamp(+d.remote.port || 47778, 1024, 65535);
    if (!Array.isArray(d.sources.blocked)) d.sources.blocked = [];
    if (!isPlainObject(d.sources.rename)) d.sources.rename = {};
    if (!Array.isArray(d.privacy.hideList)) d.privacy.hideList = [];
    if (!isPlainObject(d.discord.perPlayer)) d.discord.perPlayer = {};
    d.discord.clientId = String(d.discord.clientId || '').replace(/\D/g, '');
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[config] save failed', err);
    }
  }
}

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

module.exports = { Config, DEFAULTS, deepMerge };
