'use strict';
const EventEmitter = require('events');
const { isHidden, shareLinks, serviceFromUrl, render } = require('./formatter');
const { lookupArtwork } = require('./artwork');
const { buildActivity } = require('./presence');
const { BUILTIN_CLIENT_ID } = require('./app-id');

const SAMPLE_TRACK = {
  id: 'sample', title: 'Midnight City', artist: 'M83', album: "Hurry Up, We're Dreaming",
  player: 'Spotify', duration: 243, position: 95, status: 'playing', key: 'sample'
};

/**
 * The brain: takes players from the media source, decides what Discord should
 * show and records listening stats. The Discord connection does the rate-limiting.
 */
class Engine extends EventEmitter {
  constructor({ config, media, discord, history, now = () => Date.now() }) {
    super();
    this.config = config;
    this.media = media;
    this.discord = discord;
    this.history = history;
    this.now = now;

    this.players = [];
    this.current = null;
    this.lastActiveId = null;
    this.pausedSince = null;
    this.anchor = null;            // stable timestamps per track
    this.webArt = new Map();       // track key -> https art for Discord
    this.activity = null;          // what we want Discord to show
    this.listen = { key: null, seconds: 0, scrobbled: false, lastTick: 0 };
  }

  start() {
    this.media.on('players', (players) => this.onPlayers(players));
    this.media.on('error', (err) => this.emit('log', `Media: ${err.message || err}`));
    if (this.discord) {
      this.discord.on('state', () => this.emitState());
      this.discord.on('sent', (a) => this.emit('log', a
        ? `Discord → ${[a.details, a.state].filter(Boolean).join(' · ')}`
        : 'Discord activity cleared'));
      this.discord.on('log', (m) => this.emit('log', m));
    }
    this.config.on('change', () => this.tick());
    this.timer = setInterval(() => this.tick(), 1000);
    this.media.start();
  }

  stop() {
    clearInterval(this.timer);
    this.media.stop();
  }

  /* ---------------- players ---------------- */

  onPlayers(players) {
    const cfg = this.config.get();
    const blocked = (cfg.sources.blocked || []).map((s) => s.toLowerCase());
    const rename = cfg.sources.rename || {};
    const prev = new Map(this.players.map((p) => [p.id, p]));
    this.players = players
      .map((p) => {
        const app = p.player;
        const player = rename[app] || serviceFromUrl(p.url) || app;
        const old = prev.get(p.id);
        const artUrl = p.artUrl || (old && old.key === p.key ? old.artUrl : null);
        return { ...p, app, player, artUrl };
      })
      .filter((p) => p.title && !blocked.includes(String(p.player).toLowerCase()) && !blocked.includes(String(p.app).toLowerCase()));

    this.current = this.pickCurrent();
    if (this.current) this.fillArtwork(this.current);
    this.tick();
  }

  pickCurrent() {
    const cfg = this.config.get();
    const list = this.players;
    if (!list.length) return null;
    if (cfg.sources.mode === 'pinned' && cfg.sources.pinned) {
      const pinned = list.find((p) => p.player === cfg.sources.pinned);
      if (pinned) { this.lastActiveId = pinned.id; return pinned; }
    }
    const playing = list.filter((p) => p.status === 'playing');
    const sticky = playing.find((p) => p.id === this.lastActiveId);
    const choice = sticky || playing[0] || list.find((p) => p.id === this.lastActiveId) || list[0];
    this.lastActiveId = choice.id;
    return choice;
  }

  /** Discord can only show album art from an https URL. Players that give raw image bytes get an iTunes lookup. */
  async fillArtwork(track) {
    const key = track.key;
    if (/^https:\/\//.test(track.artUrl || '')) { this.webArt.set(key, track.artUrl); }
    if (this.webArt.has(key)) return;
    this.webArt.set(key, null);
    if (this.webArt.size > 300) this.webArt.delete(this.webArt.keys().next().value);
    const url = await lookupArtwork(track);
    if (!url) return;
    this.webArt.set(key, url);
    if (this.current && this.current.key === key && !this.current.artUrl) {
      this.current.artUrl = url;
      const p = this.players.find((x) => x.id === track.id);
      if (p) p.artUrl = url;
    }
    this.tick();
  }

  positionOf(track, at = this.now()) {
    if (!track) return 0;
    let pos = track.position || 0;
    if (track.status === 'playing' && track.updatedAt) pos += (at - track.updatedAt) / 1000;
    return track.duration ? Math.min(pos, track.duration) : pos;
  }

  clientIdFor(track) {
    const d = this.config.get().discord;
    const per = track && d.perPlayer && String(d.perPlayer[track.player] || '').trim();
    return per || d.clientId || BUILTIN_CLIENT_ID;
  }

  /* ---------------- activity ---------------- */

  computeActivity(at = this.now()) {
    const cfg = this.config.get();
    const t = this.current;
    if (!cfg.statusEnabled || !t || t.status === 'stopped') {
      this.pausedSince = null;
      return null;
    }

    let paused = false;
    if (t.status === 'paused') {
      if (!this.pausedSince) this.pausedSince = at;
      const pausedFor = at - this.pausedSince;
      if (pausedFor >= cfg.paused.graceSec * 1000) {
        if (cfg.paused.behavior === 'clear') return null;
        if (cfg.paused.clearAfterMin && pausedFor > cfg.paused.clearAfterMin * 60_000) return null;
        paused = cfg.paused.behavior === 'show';
      }
    } else {
      this.pausedSince = null;
    }

    const pos = this.positionOf(t, at);
    let start;
    if (t.status === 'playing') {
      const s = Math.round(at - pos * 1000);
      // keep the same start time unless the song changed or someone seeked (>3 s)
      if (this.anchor && this.anchor.key === t.key && Math.abs(this.anchor.start - s) < 3000) start = this.anchor.start;
      else { start = s; this.anchor = { key: t.key, start: s }; }
    } else {
      this.anchor = null;
    }

    return buildActivity({
      track: t,
      position: pos,
      cfg,
      now: at,
      art: this.webArt.get(t.key) || (/^https:\/\//.test(t.artUrl || '') ? t.artUrl : null),
      paused,
      hidden: isHidden(t, cfg.privacy.hideList),
      start
    });
  }

  tick() {
    const at = this.now();
    this.trackListening(at);
    if (this.testUntil && at < this.testUntil) { this.emitState(); return; }
    this.testUntil = 0;

    this.activity = this.computeActivity(at);
    if (this.discord) {
      this.discord.setClientId(this.clientIdFor(this.current));
      this.discord.setActivity(this.activity);
    }
    this.emitState();
  }

  trackListening(at) {
    const l = this.listen;
    const dt = l.lastTick ? Math.min(5, (at - l.lastTick) / 1000) : 0;
    l.lastTick = at;
    const t = this.current;
    if (!t || t.status !== 'playing' || !this.config.get().history.enabled || !this.history) return;
    if (l.key !== t.key) { l.key = t.key; l.seconds = 0; l.scrobbled = false; }
    l.seconds += dt;
    this.history.addSeconds(t, dt);
    const threshold = t.duration ? Math.min(Math.max(t.duration * 0.5, 15), 240) : 30;
    if (!l.scrobbled && l.seconds >= threshold) {
      l.scrobbled = true;
      this.history.addPlay(t);
    }
  }

  /* ---------------- actions ---------------- */

  async control(action, arg) {
    const t = this.current;
    if (!t) return false;
    try {
      await this.media.control(t.id, action, arg);
      return true;
    } catch (err) {
      this.emit('log', `Control failed: ${err.message || err}`);
      return false;
    }
  }

  selectPlayer(name) {
    if (!name) this.config.set({ sources: { mode: 'auto', pinned: null } });
    else this.config.set({ sources: { mode: 'pinned', pinned: name } });
    this.current = this.pickCurrent();
    this.tick();
  }

  toggleStatus(force) {
    const enabled = typeof force === 'boolean' ? force : !this.config.get().statusEnabled;
    this.config.set({ statusEnabled: enabled });
    return enabled;
  }

  /** Show a sample song on Discord for 30 s — checks the Discord side without any music. */
  sendTestPresence() {
    if (!this.discord || !this.discord.isReady()) {
      return { ok: false, reason: this.discord ? discordProblem(this.discord.getState()) : 'Discord is off' };
    }
    const at = this.now();
    this.testUntil = at + 30_000;
    const t = { ...SAMPLE_TRACK, updatedAt: at, title: 'TuneCord test ✓' };
    this.activity = buildActivity({ track: t, position: 95, cfg: this.config.get(), now: at, art: null });
    this.discord.setActivity(this.activity);
    this.emitState();
    return { ok: true };
  }

  /** Live preview for the presence designer (sample song when nothing plays). */
  renderPreview(templates) {
    const t = this.current || SAMPLE_TRACK;
    const pos = this.current ? this.positionOf(t) : 95;
    const out = {};
    for (const [k, v] of Object.entries(templates || {})) out[k] = render(String(v || ''), t, pos);
    return { ...out, sample: !this.current };
  }

  /* ---------------- state for UI ---------------- */

  getState() {
    const at = this.now();
    const cfg = this.config.get();
    const t = this.current;
    // Preview activity even when Discord is closed / status is off
    let preview = this.activity;
    if (!preview && t) {
      const saved = cfg.statusEnabled;
      cfg.statusEnabled = true;
      const pausedSince = this.pausedSince;
      preview = this.computeActivity(at);
      this.pausedSince = pausedSince;
      cfg.statusEnabled = saved;
    }
    return {
      enabled: cfg.statusEnabled,
      live: !!this.activity,
      activity: preview,
      testing: !!this.testUntil,
      hidden: t ? isHidden(t, cfg.privacy.hideList) : false,
      current: t ? { ...t, position: this.positionOf(t, at), links: shareLinks(t) } : null,
      players: this.players.map((p) => ({ id: p.id, player: p.player, app: p.app, title: p.title, artist: p.artist, status: p.status })),
      pinned: cfg.sources.mode === 'pinned' ? cfg.sources.pinned : null,
      discord: this.discord ? this.discord.getState() : { status: 'disabled' },
      hasClientId: !!this.clientIdFor(t),
      media: { backend: this.media.name, error: this.media.lastError || null }
    };
  }

  emitState() {
    this.emit('state', this.getState());
  }
}

function discordProblem(s) {
  return {
    'no-client-id': 'No Discord Application ID set (Settings → Discord)',
    'bad-client-id': 'Discord says the Application ID is wrong',
    connecting: 'Still connecting to Discord',
    disconnected: 'Discord desktop app isn\'t running'
  }[s.status] || `Discord: ${s.status}`;
}

module.exports = { Engine, discordProblem, SAMPLE_TRACK };
