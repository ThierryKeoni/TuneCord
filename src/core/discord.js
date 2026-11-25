'use strict';
// Talks to the Discord desktop app over its local IPC socket (the same thing
// game "Rich Presence" uses). No Discord login, no Spotify link, no npm package.
//
// Wire format: [int32 LE op][int32 LE length][JSON]
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
const RETRY_MS = 8000;
const MIN_GAP_MS = 4100;        // Discord allows 5 SET_ACTIVITY per 20 s
// Newer activity fields. If an old Discord build rejects them we retry without.
const NEW_FIELDS = ['status_display_type', 'details_url', 'state_url'];
const NEW_ASSET_FIELDS = ['large_url', 'small_url'];

function socketCandidates(env = process.env, platform = process.platform) {
  const out = [];
  if (platform === 'win32') {
    for (let i = 0; i < 10; i++) out.push(`\\\\?\\pipe\\discord-ipc-${i}`);
    return out;
  }
  const base = env.XDG_RUNTIME_DIR || env.TMPDIR || env.TMP || env.TEMP || '/tmp';
  const dirs = [
    base,
    path.join(base, 'app', 'com.discordapp.Discord'),        // Flatpak Discord
    path.join(base, 'app', 'com.discordapp.DiscordCanary'),
    path.join(base, 'app', 'dev.vencord.Vesktop'),           // Vesktop (Flatpak)
    path.join(base, '.flatpak', 'dev.vencord.Vesktop', 'xdg-run'),
    path.join(base, 'snap.discord'),                         // Snap
    '/tmp'
  ];
  for (const d of [...new Set(dirs)]) for (let i = 0; i < 10; i++) out.push(path.join(d, `discord-ipc-${i}`));
  return out;
}

function encode(op, data) {
  const json = Buffer.from(JSON.stringify(data), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

/** Splits an incoming byte stream into {op, data} packets. */
class Decoder {
  constructor() { this.buf = Buffer.alloc(0); }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    while (this.buf.length >= 8) {
      const op = this.buf.readInt32LE(0);
      const len = this.buf.readInt32LE(4);
      if (this.buf.length < 8 + len) break;
      const body = this.buf.subarray(8, 8 + len).toString('utf8');
      this.buf = this.buf.subarray(8 + len);
      let data = null;
      try { data = JSON.parse(body); } catch (_) { /* ignore */ }
      out.push({ op, data });
    }
    return out;
  }
}

function connectFirst(paths) {
  return new Promise((resolve, reject) => {
    let i = 0;
    const next = () => {
      if (i >= paths.length) return reject(new Error('Discord is not running'));
      const p = paths[i++];
      const sock = net.createConnection(p);
      const fail = () => { sock.destroy(); next(); };
      sock.once('connect', () => { sock.removeListener('error', fail); resolve(sock); });
      sock.once('error', fail);
    };
    next();
  });
}

function stripNewFields(activity) {
  if (!activity) return activity;
  const a = { ...activity };
  for (const k of NEW_FIELDS) delete a[k];
  if (a.assets) {
    a.assets = { ...a.assets };
    for (const k of NEW_ASSET_FIELDS) delete a.assets[k];
  }
  return a;
}

/**
 * Keeps a connection to Discord alive, reconnects when Discord restarts, and
 * rate-limits SET_ACTIVITY so Discord never drops our updates.
 */
class DiscordConnection extends EventEmitter {
  constructor({ clientId = '', paths, now = () => Date.now() } = {}) {
    super();
    this.clientId = clientId;
    this.paths = paths || socketCandidates();
    this.now = now;
    this.sock = null;
    this.state = { status: 'disconnected', user: null, error: null, clientId };
    this.wanted = undefined;        // activity we want Discord to show (null = clear)
    this.applied = undefined;       // JSON of the last activity Discord accepted
    this.lastSentAt = 0;
    this.compat = false;            // true after Discord rejected the newer fields
    this.pending = new Map();       // nonce -> activity sent
  }

  getState() { return { ...this.state }; }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.getState());
  }

  isReady() { return this.state.status === 'ready'; }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.flushTimer);
    this.close();
  }

  /** Switch Discord application (the app name shown after "Listening to"). */
  setClientId(id) {
    id = String(id || '').trim();
    if (id === this.clientId) return;
    this.clientId = id;
    this.state.clientId = id;
    this.applied = undefined;
    this.close();
    clearTimeout(this.retryTimer);
    if (!this.stopped) this.connect();
  }

  /** Try again right now (e.g. after the user started Discord or fixed the ID). */
  reconnect() {
    this.close();
    clearTimeout(this.retryTimer);
    if (!this.stopped) this.connect();
  }

  close() {
    if (this.sock) {
      const s = this.sock;
      this.sock = null;
      s.removeAllListeners('close');
      try { s.end(encode(OP.CLOSE, {})); } catch (_) { /* ignore */ }
      const t = setTimeout(() => s.destroy(), 500);
      if (t.unref) t.unref();
    }
    if (this.state.status !== 'disconnected') this.setState({ status: 'disconnected', user: null });
  }

  scheduleRetry(ms = RETRY_MS) {
    clearTimeout(this.retryTimer);
    if (this.stopped) return;
    this.retryTimer = setTimeout(() => this.connect(), ms);
  }

  async connect() {
    if (this.sock || this.connecting) return;
    if (!/^\d{17,20}$/.test(this.clientId)) {
      this.setState({ status: 'no-client-id', error: null });
      return;
    }
    this.connecting = true;
    this.setState({ status: 'connecting', error: null });
    let sock;
    try {
      sock = await connectFirst(this.paths);
    } catch (err) {
      this.connecting = false;
      this.setState({ status: 'disconnected', error: null });
      this.scheduleRetry();
      return;
    }
    this.connecting = false;
    if (this.stopped) { sock.destroy(); return; }
    this.sock = sock;
    const dec = new Decoder();
    const usedId = this.clientId;
    sock.on('data', (chunk) => { for (const pkt of dec.push(chunk)) this.onPacket(pkt); });
    sock.on('close', () => {
      if (this.sock !== sock) return;
      this.sock = null;
      this.applied = undefined;
      this.setState({ status: 'disconnected', user: null });
      this.scheduleRetry();
    });
    sock.on('error', () => { /* 'close' follows */ });
    sock.write(encode(OP.HANDSHAKE, { v: 1, client_id: usedId }));
  }

  onPacket({ op, data }) {
    if (op === OP.PING) { this.write(OP.PONG, data); return; }
    if (op === OP.CLOSE) {
      // e.g. 4000 "Invalid Client ID"
      const msg = (data && data.message) || 'Discord closed the connection';
      const bad = data && (data.code === 4000 || /client id/i.test(msg));
      this.setState({ status: bad ? 'bad-client-id' : 'disconnected', error: msg });
      const s = this.sock; this.sock = null; if (s) s.destroy();
      if (!bad) this.scheduleRetry();
      return;
    }
    if (op !== OP.FRAME || !data) return;

    if (data.evt === 'READY') {
      const u = (data.data && data.data.user) || {};
      this.setState({
        status: 'ready',
        error: null,
        user: {
          id: u.id,
          name: u.global_name || u.username || 'You',
          username: u.username,
          avatar: u.id && u.avatar
            ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.${String(u.avatar).startsWith('a_') ? 'gif' : 'png'}?size=128`
            : null
        }
      });
      this.applied = undefined;
      this.flush();
      return;
    }

    if (data.cmd === 'SET_ACTIVITY') {
      const sent = this.pending.get(data.nonce);
      this.pending.delete(data.nonce);
      if (data.evt === 'ERROR') {
        const msg = (data.data && data.data.message) || 'Discord rejected the activity';
        if (!this.compat && sent) {
          // Older Discord without the 2025 fields: retry without them.
          this.compat = true;
          this.emit('log', `Discord: ${msg} — retrying in compatibility mode`);
          this.applied = undefined;
          this.lastSentAt = 0;
          this.flush();
          return;
        }
        this.emit('log', `Discord: ${msg}`);
        this.setState({ error: msg });
        return;
      }
      if (this.state.error) this.setState({ error: null });
    }
  }

  write(op, data) {
    if (!this.sock) return false;
    try { this.sock.write(encode(op, data)); return true; } catch (_) { return false; }
  }

  /** Ask Discord to show this activity (or clear it with null). Rate-limited, latest wins. */
  setActivity(activity) {
    this.wanted = activity || null;
    this.flush();
  }

  flush() {
    clearTimeout(this.flushTimer);
    if (!this.isReady() || this.wanted === undefined) return;
    const payload = this.compat ? stripNewFields(this.wanted) : this.wanted;
    const json = JSON.stringify(payload);
    if (json === this.applied) return;
    const wait = this.lastSentAt + MIN_GAP_MS - this.now();
    if (wait > 0) {
      this.flushTimer = setTimeout(() => this.flush(), wait);
      return;
    }
    const nonce = crypto.randomUUID();
    this.pending.set(nonce, payload);
    if (this.pending.size > 20) this.pending.delete(this.pending.keys().next().value);
    if (this.write(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: payload }, nonce })) {
      this.applied = json;
      this.lastSentAt = this.now();
      this.emit('sent', payload);
    }
  }

  /** Clear our activity right away (used on quit). */
  clearNow() {
    if (!this.isReady()) return;
    this.write(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: null }, nonce: crypto.randomUUID() });
  }
}

module.exports = { DiscordConnection, socketCandidates, encode, Decoder, stripNewFields, OP, MIN_GAP_MS };
