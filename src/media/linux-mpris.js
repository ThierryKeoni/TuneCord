'use strict';
// Linux / Steam Deck: every music app (Spotify, Strawberry, Elisa, Rhythmbox,
// browsers, Cider, YouTube Music desktop…) exposes MPRIS over the session D-Bus.
// Browsers also report the page URL, so SoundCloud/TIDAL/YouTube Music tabs are recognised.
const EventEmitter = require('events');

const PREFIX = 'org.mpris.MediaPlayer2.';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const SKIP = new Set(['org.mpris.MediaPlayer2.playerctld']); // proxy that duplicates others

const v = (x) => (x && typeof x === 'object' && 'value' in x ? x.value : x);
const num = (x) => {
  const n = Number(v(x));
  return Number.isFinite(n) ? n : 0;
};

class MprisSource extends EventEmitter {
  constructor({ interval = 1500 } = {}) {
    super();
    this.name = 'MPRIS (D-Bus)';
    this.interval = interval;
    this.entries = new Map();
    this.lastError = null;
  }

  async start() {
    try {
      this.dbus = require('dbus-next');
      this.bus = this.dbus.sessionBus();
      this.bus.on('error', (err) => this.fail(err));
      const obj = await this.bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus');
      this.dbusIface = obj.getInterface('org.freedesktop.DBus');
      this.lastError = null;
    } catch (err) {
      this.fail(err);
      this.retry = setTimeout(() => this.start(), 10_000);
      return;
    }
    this.timer = setInterval(() => this.poll(), this.interval);
    this.poll();
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.retry);
    try { this.bus && this.bus.disconnect(); } catch (_) { /* ignore */ }
  }

  fail(err) {
    this.lastError = String((err && err.message) || err);
    this.emit('error', err);
  }

  async entry(name) {
    let e = this.entries.get(name);
    if (e) return e;
    const obj = await this.bus.getProxyObject(name, '/org/mpris/MediaPlayer2');
    const props = obj.getInterface('org.freedesktop.DBus.Properties');
    let identity = name.slice(PREFIX.length).split('.')[0];
    try { identity = v(await props.Get('org.mpris.MediaPlayer2', 'Identity')) || identity; } catch (_) { /* optional */ }
    e = { name, props, player: obj.getInterface(PLAYER_IFACE), identity };
    this.entries.set(name, e);
    return e;
  }

  async poll() {
    if (this.polling || !this.dbusIface) return;
    this.polling = true;
    try {
      const names = (await this.dbusIface.ListNames()).filter((n) => n.startsWith(PREFIX) && !SKIP.has(n));
      for (const known of this.entries.keys()) if (!names.includes(known)) this.entries.delete(known);

      const players = [];
      for (const name of names) {
        try {
          const e = await this.entry(name);
          const all = await e.props.GetAll(PLAYER_IFACE);
          const md = v(all.Metadata) || {};
          const status = String(v(all.PlaybackStatus) || 'Stopped').toLowerCase();
          const artists = v(md['xesam:artist']);
          const title = v(md['xesam:title']) || '';
          const artist = Array.isArray(artists) ? artists.join(', ') : (artists || '');
          let artUrl = v(md['mpris:artUrl']) || null;
          if (artUrl && artUrl.startsWith('https://open.spotify.com/image/')) {
            artUrl = artUrl.replace('https://open.spotify.com/image/', 'https://i.scdn.co/image/');
          }
          players.push({
            id: name,
            player: e.identity,
            title,
            artist,
            album: v(md['xesam:album']) || '',
            duration: num(md['mpris:length']) / 1e6,
            position: num(all.Position) / 1e6,
            status: status === 'playing' ? 'playing' : status === 'paused' ? 'paused' : 'stopped',
            artUrl,
            url: v(md['xesam:url']) || null,
            key: `${artist}|${title}`.toLowerCase(),
            updatedAt: Date.now(),
            canSeek: !!v(all.CanSeek)
          });
        } catch (_) {
          this.entries.delete(name);
        }
      }
      this.lastError = null;
      this.emit('players', players);
    } catch (err) {
      this.fail(err);
    } finally {
      this.polling = false;
    }
  }

  async control(id, action, arg) {
    try {
      await this.runControl(id, action, arg);
    } finally {
      setTimeout(() => this.poll(), 250);
    }
  }

  async runControl(id, action, arg) {
    const e = await this.entry(id);
    switch (action) {
      case 'playpause': return e.player.PlayPause();
      case 'play': return e.player.Play();
      case 'pause': return e.player.Pause();
      case 'next': return e.player.Next();
      case 'previous': return e.player.Previous();
      case 'seek': {
        const us = BigInt(Math.max(0, Math.round(Number(arg) * 1e6)));
        const all = await e.props.GetAll(PLAYER_IFACE);
        const trackId = v((v(all.Metadata) || {})['mpris:trackid']);
        if (trackId) return e.player.SetPosition(trackId, us);
        const cur = BigInt(Math.round(num(all.Position)));
        return e.player.Seek(us - cur);
      }
      default: throw new Error(`Unknown action ${action}`);
    }
  }
}

module.exports = { MprisSource };
