'use strict';
// macOS: Spotify and Apple Music via JavaScript for Automation (asks for the
// "control Spotify/Music" permission once). If the free `media-control` CLI is
// installed (brew install media-control) we also pick up TIDAL, browsers
// (SoundCloud, YouTube Music…) and every other app in Control Center's Now Playing.
const EventEmitter = require('events');
const { execFile } = require('child_process');

const JXA = `
function run() {
  var out = [];
  var apps = [['Spotify', 'com.spotify.client'], ['Apple Music', 'com.apple.Music']];
  for (var i = 0; i < apps.length; i++) {
    try {
      var app = Application(apps[i][1]);
      if (!app.running()) continue;
      var st = app.playerState();
      if (st === 'stopped') continue;
      var t = app.currentTrack();
      var isSpotify = apps[i][0] === 'Spotify';
      var item = {
        id: apps[i][1], player: apps[i][0], status: String(st),
        title: t.name(), artist: t.artist(), album: t.album(),
        duration: isSpotify ? t.duration() / 1000 : t.duration(),
        position: app.playerPosition(), artUrl: null, url: null
      };
      if (isSpotify) {
        try { item.artUrl = t.artworkUrl(); } catch (e) {}
        try { var sid = t.id(); if (sid && sid.indexOf('spotify:track:') === 0) item.url = 'https://open.spotify.com/track/' + sid.split(':')[2]; } catch (e) {}
      }
      out.push(item);
    } catch (e) {}
  }
  return JSON.stringify(out);
}`;

function run(cmd, args, timeout = 4000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

const BUNDLE_NAMES = {
  'com.spotify.client': 'Spotify',
  'com.apple.Music': 'Apple Music',
  'com.apple.Safari': 'Safari',
  'com.google.Chrome': 'Chrome',
  'org.mozilla.firefox': 'Firefox',
  'com.microsoft.edgemac': 'Edge',
  'company.thebrowser.Browser': 'Arc',
  'com.brave.Browser': 'Brave',
  'com.tidal.desktop': 'TIDAL',
  'com.deezer.deezer-desktop': 'Deezer',
  'com.electron.cider': 'Cider',
  'com.github.th-ch.youtube-music': 'YouTube Music',
  'com.amazon.music': 'Amazon Music'
};

class MacSource extends EventEmitter {
  constructor({ interval = 2000 } = {}) {
    super();
    this.name = 'AppleScript (Spotify / Music)';
    this.interval = interval;
    this.lastError = null;
    this.mediaControl = null;
  }

  async start() {
    try {
      await run('media-control', ['get'], 3000);
      this.mediaControl = true;
      this.name = 'AppleScript + media-control';
    } catch (_) {
      this.mediaControl = false;
    }
    this.timer = setInterval(() => this.poll(), this.interval);
    this.poll();
  }

  stop() { clearInterval(this.timer); }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    const now = Date.now();
    const players = [];
    try {
      const out = await run('osascript', ['-l', 'JavaScript', '-e', JXA]);
      for (const p of JSON.parse(out.trim() || '[]')) players.push(this.normalize(p, now));
      this.lastError = null;
    } catch (err) {
      this.lastError = String(err.message || err).slice(0, 300);
    }

    if (this.mediaControl) {
      try {
        const out = await run('media-control', ['get']);
        const m = JSON.parse(out.trim() || 'null');
        if (m && m.title) {
          const bundle = m.bundleIdentifier || m.parentApplicationBundleIdentifier || 'system';
          if (!players.some((p) => p.id === bundle)) {
            players.push(this.normalize({
              id: 'mc:' + bundle,
              player: BUNDLE_NAMES[bundle] || bundle.split('.').pop(),
              status: m.playing ? 'playing' : 'paused',
              title: m.title,
              artist: m.artist,
              album: m.album,
              duration: m.duration,
              position: m.elapsedTimeNow ?? m.elapsedTime,
              artUrl: m.artworkData ? `data:${m.artworkMimeType || 'image/jpeg'};base64,${m.artworkData}` : null
            }, now));
          }
        }
      } catch (_) { /* nothing playing or tool missing */ }
    }

    this.polling = false;
    this.emit('players', players);
  }

  normalize(p, now) {
    const st = String(p.status || '').toLowerCase();
    return {
      id: p.id,
      player: p.player,
      title: p.title || '',
      artist: p.artist || '',
      album: p.album || '',
      duration: Number(p.duration) || 0,
      position: Number(p.position) || 0,
      status: st === 'playing' ? 'playing' : st === 'paused' ? 'paused' : 'stopped',
      artUrl: p.artUrl || null,
      url: p.url || null,
      key: `${p.artist || ''}|${p.title || ''}`.toLowerCase(),
      updatedAt: now,
      canSeek: true
    };
  }

  async control(id, action, arg) {
    if (id.startsWith('mc:')) {
      const map = { playpause: 'toggle-play-pause', play: 'play', pause: 'pause', next: 'next-track', previous: 'previous-track' };
      if (action === 'seek') return run('media-control', ['seek', String(Math.round(Number(arg)))]);
      if (!map[action]) throw new Error(`Unknown action ${action}`);
      return run('media-control', [map[action]]);
    }
    const verbs = { playpause: 'playpause()', play: 'play()', pause: 'pause()', next: 'nextTrack()', previous: 'previousTrack()' };
    const target = `Application(${JSON.stringify(id)})`;
    let script;
    if (action === 'seek') script = `${target}.playerPosition = ${Math.max(0, Number(arg) || 0)}`;
    else if (verbs[action]) script = `${target}.${verbs[action]}`;
    else throw new Error(`Unknown action ${action}`);
    await run('osascript', ['-l', 'JavaScript', '-e', script]);
    setTimeout(() => this.poll(), 250);
  }
}

module.exports = { MacSource };
