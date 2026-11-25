'use strict';
const fs = require('fs');
const path = require('path');

const MAX_PLAYS = 2000;
const MAX_TRACKS = 5000;

function dayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function emptyData() {
  return { version: 1, plays: [], days: {}, artists: {}, tracks: {}, players: {} };
}

class History {
  constructor(dir) {
    this.file = path.join(dir, 'history.json');
    this.data = emptyData();
    try {
      this.data = { ...emptyData(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch (_) { /* fresh */ }
    this.dirty = false;
    this.timer = setInterval(() => this.flush(), 30_000);
    if (this.timer.unref) this.timer.unref();
  }

  static trackKey(t) {
    return `${(t.artist || '').toLowerCase()}\u0000${(t.title || '').toLowerCase()}`;
  }

  addSeconds(track, seconds, now = new Date()) {
    if (!track || !track.title || seconds <= 0) return;
    const d = this.data;
    const day = dayKey(now);
    d.days[day] = (d.days[day] || 0) + seconds;
    if (track.artist) d.artists[track.artist] = (d.artists[track.artist] || 0) + seconds;
    if (track.player) d.players[track.player] = (d.players[track.player] || 0) + seconds;
    const k = History.trackKey(track);
    const t = d.tracks[k] || (d.tracks[k] = { title: track.title, artist: track.artist || '', plays: 0, seconds: 0 });
    t.seconds += seconds;
    this.dirty = true;
  }

  addPlay(track, now = new Date()) {
    if (!track || !track.title) return;
    const d = this.data;
    d.plays.push({ t: now.getTime(), title: track.title, artist: track.artist || '', album: track.album || '', player: track.player || '' });
    if (d.plays.length > MAX_PLAYS) d.plays.splice(0, d.plays.length - MAX_PLAYS);
    const k = History.trackKey(track);
    const t = d.tracks[k] || (d.tracks[k] = { title: track.title, artist: track.artist || '', plays: 0, seconds: 0 });
    t.plays += 1;
    this.prune();
    this.dirty = true;
  }

  prune() {
    const keys = Object.keys(this.data.tracks);
    if (keys.length <= MAX_TRACKS) return;
    keys.sort((a, b) => this.data.tracks[a].seconds - this.data.tracks[b].seconds);
    for (const k of keys.slice(0, keys.length - MAX_TRACKS)) delete this.data.tracks[k];
  }

  stats(now = new Date()) {
    const d = this.data;
    const today = dayKey(now);
    const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);

    let streak = 0;
    const cursor = new Date(now);
    if (!(d.days[dayKey(cursor)] >= 300)) cursor.setDate(cursor.getDate() - 1);
    while (d.days[dayKey(cursor)] >= 300) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }

    const last7 = [];
    for (let i = 6; i >= 0; i--) {
      const c = new Date(now);
      c.setDate(c.getDate() - i);
      last7.push({ day: dayKey(c), minutes: Math.round((d.days[dayKey(c)] || 0) / 60) });
    }

    const tracks = Object.values(d.tracks)
      .filter((t) => t.plays > 0)
      .sort((a, b) => b.plays - a.plays || b.seconds - a.seconds)
      .slice(0, 10);
    const totalSec = Object.values(d.days).reduce((a, b) => a + b, 0);

    return {
      todayMinutes: Math.round((d.days[today] || 0) / 60),
      totalMinutes: Math.round(totalSec / 60),
      totalPlays: d.plays.length,
      streakDays: streak,
      last7,
      topArtists: top(d.artists, 10).map(([name, s]) => ({ name, minutes: Math.round(s / 60) })),
      topPlayers: top(d.players, 5).map(([name, s]) => ({ name, minutes: Math.round(s / 60) })),
      topTracks: tracks.map((t) => ({ title: t.title, artist: t.artist, plays: t.plays, minutes: Math.round(t.seconds / 60) })),
      recent: d.plays.slice(-25).reverse()
    };
  }

  clear() {
    this.data = emptyData();
    this.dirty = true;
    this.flush();
  }

  flush() {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (err) {
      console.error('[history] save failed', err);
    }
  }

  close() {
    clearInterval(this.timer);
    this.flush();
  }
}

module.exports = { History, dayKey };
