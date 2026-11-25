'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const EventEmitter = require('events');

const { render, discordText, shareLinks, serviceFromUrl, isHidden } = require('../src/core/formatter');
const { buildActivity } = require('../src/core/presence');
const { Config } = require('../src/core/config');
const { History } = require('../src/core/history');
const { Engine } = require('../src/core/engine');
const { DiscordConnection, encode, Decoder, socketCandidates, OP } = require('../src/core/discord');
const { friendlyName } = require('../src/media/windows-smtc');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tc-'));
const CLIENT = '123456789012345678';
const track = (o = {}) => ({
  id: 'p1', player: 'Spotify', title: 'Midnight City', artist: 'M83', album: 'Hurry Up',
  duration: 240, position: 60, status: 'playing', key: 'm83|midnight city', updatedAt: 0, ...o
});

/* ---------------- formatter ---------------- */

test('templates render tokens and optional sections', () => {
  assert.strictEqual(render('{title}[ — {artist}]', track()), 'Midnight City — M83');
  assert.strictEqual(render('{title}[ — {artist}]', track({ artist: '' })), 'Midnight City');
  assert.strictEqual(render('[by {artist}]', track()), 'by M83');
  assert.strictEqual(render('{position}/{duration}', track()), '1:00/4:00');
});

test('discordText enforces 2–128 chars', () => {
  assert.strictEqual(Array.from(discordText('A')).length, 2);
  assert.strictEqual(discordText(''), undefined);
  assert.ok(discordText('x'.repeat(300)).length <= 128);
  assert.ok(discordText('🎵'.repeat(100)).length <= 128);
});

test('service detection from URLs', () => {
  assert.strictEqual(serviceFromUrl('https://soundcloud.com/m83/midnight-city'), 'SoundCloud');
  assert.strictEqual(serviceFromUrl('https://music.youtube.com/watch?v=x'), 'YouTube Music');
  assert.strictEqual(serviceFromUrl('https://listen.tidal.com/track/1'), 'TIDAL');
  assert.strictEqual(serviceFromUrl('https://open.spotify.com/track/abc'), 'Spotify');
  assert.strictEqual(serviceFromUrl('file:///home/x.mp3'), null);
});

test('share links point to the service you are listening on', () => {
  assert.match(shareLinks(track({ player: 'TIDAL' })).source, /^https:\/\/tidal\.com\/search/);
  assert.strictEqual(shareLinks(track({ url: 'https://soundcloud.com/a/b', player: 'SoundCloud' })).source, 'https://soundcloud.com/a/b');
  assert.strictEqual(shareLinks(track({ player: 'foobar2000' })).sourceLabel, 'Spotify');
});

test('privacy filter', () => {
  assert.ok(isHidden(track(), ['m83']));
  assert.ok(!isHidden(track(), ['nickelback']));
});

/* ---------------- presence ---------------- */

test('activity: listening type, timestamps, art, buttons', () => {
  const cfg = new Config(tmp()).get();
  const a = buildActivity({ track: track(), position: 60, cfg, now: 1_000_000, art: 'https://i.scdn.co/image/x' });
  assert.strictEqual(a.type, 2);
  assert.strictEqual(a.status_display_type, 1);
  assert.strictEqual(a.details, 'Midnight City');
  assert.strictEqual(a.state, 'M83');
  assert.deepStrictEqual(a.timestamps, { start: 940_000, end: 1_180_000 });
  assert.strictEqual(a.assets.large_image, 'https://i.scdn.co/image/x');
  assert.strictEqual(a.assets.large_text, 'Hurry Up');
  assert.match(a.assets.small_image, /playing\.png$/);
  assert.strictEqual(a.buttons.length, 1);
  assert.strictEqual(a.buttons[0].label, 'Open in Spotify');
});

test('activity: paused has no timestamps and a pause icon', () => {
  const cfg = new Config(tmp()).get();
  const a = buildActivity({ track: track({ status: 'paused' }), position: 60, cfg, now: 0, paused: true });
  assert.strictEqual(a.timestamps, undefined);
  assert.match(a.assets.small_image, /paused\.png$/);
  assert.match(a.assets.large_image, /logo\.png$/); // no art → logo
});

test('activity: hidden tracks never leak', () => {
  const cfg = new Config(tmp()).get();
  const a = buildActivity({ track: track(), position: 0, cfg, now: 0, hidden: true });
  assert.ok(!JSON.stringify(a).includes('M83'));
  assert.ok(!JSON.stringify(a).includes('Midnight'));
});

/* ---------------- engine ---------------- */

function setup(cfgPatch = {}) {
  const dir = tmp();
  const config = new Config(dir);
  config.set({ discord: { clientId: CLIENT }, ...cfgPatch });
  const media = new EventEmitter();
  media.name = 'mock';
  media.start = () => {};
  media.stop = () => {};
  media.calls = [];
  media.control = async (id, action) => media.calls.push([id, action]);
  const discord = new EventEmitter();
  discord.sent = [];
  discord.ids = [];
  discord.setActivity = (a) => discord.sent.push(a);
  discord.setClientId = (id) => discord.ids.push(id);
  discord.isReady = () => true;
  discord.getState = () => ({ status: 'ready' });
  let now = 1_000_000;
  const history = new History(dir);
  const engine = new Engine({ config, media, discord, history, now: () => now });
  engine.webArt.set('m83|midnight city', 'https://art/x.jpg'); // skip network lookups
  engine.webArt.set('m83|wait', 'https://art/y.jpg');
  engine.start();
  clearInterval(engine.timer);
  return { engine, media, discord, config, history, advance: (ms) => { now += ms; engine.tick(); }, at: () => now };
}

test('engine keeps timestamps stable while playing, resets on seek', () => {
  const { media, discord, advance, at } = setup();
  media.emit('players', [track({ updatedAt: at() })]);
  const first = discord.sent.at(-1).timestamps.start;
  advance(5000);
  assert.strictEqual(discord.sent.at(-1).timestamps.start, first);
  media.emit('players', [track({ position: 200, updatedAt: at() })]); // seek
  assert.notStrictEqual(discord.sent.at(-1).timestamps.start, first);
});

test('engine: paused clear vs show', () => {
  const s1 = setup({ paused: { behavior: 'clear', graceSec: 5 } });
  s1.media.emit('players', [track({ status: 'paused', updatedAt: s1.at() })]);
  assert.ok(s1.discord.sent.at(-1));                    // in grace
  s1.advance(6000);
  assert.strictEqual(s1.discord.sent.at(-1), null);     // cleared

  const s2 = setup({ paused: { behavior: 'show', graceSec: 0 } });
  s2.media.emit('players', [track({ status: 'paused', updatedAt: s2.at() })]);
  assert.match(s2.discord.sent.at(-1).assets.small_image, /paused/);
});

test('engine: toggle off, blocked players, rename and per-player app', () => {
  const { engine, media, discord, config, at, advance } = setup({
    sources: { blocked: ['Chrome'], rename: { Firefox: 'SoundCloud' } },
    discord: { clientId: CLIENT, perPlayer: { SoundCloud: '999999999999999999' } }
  });
  media.emit('players', [
    track({ id: 'c', player: 'Chrome', title: 'Video', key: 'x|video', updatedAt: at() }),
    track({ id: 'f', player: 'Firefox', updatedAt: at() })
  ]);
  assert.strictEqual(engine.current.player, 'SoundCloud');
  assert.strictEqual(discord.ids.at(-1), '999999999999999999');
  assert.match(discord.sent.at(-1).buttons[0].label, /SoundCloud/);
  engine.toggleStatus(false);
  advance(1000);
  assert.strictEqual(discord.sent.at(-1), null);
  assert.strictEqual(config.get().statusEnabled, false);
});

test('engine: browser URL turns into service name (Linux)', () => {
  const { engine, media, at } = setup();
  media.emit('players', [track({ player: 'Firefox', url: 'https://music.youtube.com/watch?v=1', updatedAt: at() })]);
  assert.strictEqual(engine.current.player, 'YouTube Music');
  assert.strictEqual(engine.current.app, 'Firefox');
});

test('history scrobbles after half the track', () => {
  const { media, history, advance, at } = setup();
  media.emit('players', [track({ duration: 60, updatedAt: at() })]);
  for (let i = 0; i < 31; i++) advance(1000);
  assert.strictEqual(history.stats().totalPlays, 1);
});

test('windows app ids map to friendly names', () => {
  assert.strictEqual(friendlyName('Spotify.exe'), 'Spotify');
  assert.strictEqual(friendlyName('AppleInc.AppleMusicWin_nzyj5cx40ttqa!App'), 'Apple Music');
  assert.strictEqual(friendlyName('TIDAL.exe'), 'TIDAL');
});

/* ---------------- Discord IPC against a fake Discord ---------------- */

test('socket candidates cover Windows pipes and Linux Flatpak', () => {
  assert.strictEqual(socketCandidates({}, 'win32')[0], '\\\\?\\pipe\\discord-ipc-0');
  const lin = socketCandidates({ XDG_RUNTIME_DIR: '/run/user/1000' }, 'linux');
  assert.ok(lin.includes('/run/user/1000/discord-ipc-0'));
  assert.ok(lin.includes('/run/user/1000/app/com.discordapp.Discord/discord-ipc-0'));
});

test('decoder handles split and joined packets', () => {
  const d = new Decoder();
  const buf = Buffer.concat([encode(1, { a: 1 }), encode(3, { b: 2 })]);
  const out = [...d.push(buf.subarray(0, 5)), ...d.push(buf.subarray(5, 20)), ...d.push(buf.subarray(20))];
  assert.deepStrictEqual(out, [{ op: 1, data: { a: 1 } }, { op: 3, data: { b: 2 } }]);
});

function fakeDiscord({ rejectNewFields = false } = {}) {
  const sockPath = process.platform === 'win32'
    ? `\\\\?\\pipe\\tunecord-test-${process.pid}-${Math.random().toString(36).slice(2)}`
    : path.join(tmp(), 'discord-ipc-0');
  const got = [];
  const server = net.createServer((s) => {
    const dec = new Decoder();
    s.on('data', (c) => {
      for (const { op, data } of dec.push(c)) {
        got.push({ op, data });
        if (op === OP.HANDSHAKE) {
          if (data.client_id === '000000000000000000') { s.write(encode(OP.CLOSE, { code: 4000, message: 'Invalid Client ID' })); s.end(); continue; }
          s.write(encode(OP.FRAME, { cmd: 'DISPATCH', evt: 'READY', data: { user: { id: '42', username: 'alex', global_name: 'Alex', avatar: 'abc' } } }));
        }
        if (op === OP.FRAME && data.cmd === 'SET_ACTIVITY') {
          const a = data.args.activity;
          if (rejectNewFields && a && 'status_display_type' in a) {
            s.write(encode(OP.FRAME, { cmd: 'SET_ACTIVITY', evt: 'ERROR', nonce: data.nonce, data: { code: 4000, message: 'child "activity" fails' } }));
          } else {
            s.write(encode(OP.FRAME, { cmd: 'SET_ACTIVITY', evt: null, nonce: data.nonce, data: a }));
          }
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(sockPath, () => resolve({ server, sockPath, got })));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await wait(20); }
  return false;
}

test('IPC: handshake, READY user, SET_ACTIVITY', async () => {
  const fd = await fakeDiscord();
  const dc = new DiscordConnection({ clientId: CLIENT, paths: ['/nope/discord-ipc-0', fd.sockPath] });
  dc.start();
  assert.ok(await until(() => dc.isReady()));
  assert.strictEqual(dc.getState().user.name, 'Alex');
  assert.match(dc.getState().user.avatar, /cdn\.discordapp\.com\/avatars\/42\/abc\.png/);
  dc.setActivity({ type: 2, details: 'Midnight City', state: 'M83' });
  assert.ok(await until(() => fd.got.some((g) => g.data && g.data.cmd === 'SET_ACTIVITY')));
  const hs = fd.got.find((g) => g.op === OP.HANDSHAKE);
  assert.deepStrictEqual(hs.data, { v: 1, client_id: CLIENT });
  dc.stop();
  fd.server.close();
});

test('IPC: rate limit keeps only the latest update', async () => {
  const fd = await fakeDiscord();
  const dc = new DiscordConnection({ clientId: CLIENT, paths: [fd.sockPath] });
  dc.start();
  await until(() => dc.isReady());
  dc.setActivity({ details: 'one' });
  dc.setActivity({ details: 'two' });
  dc.setActivity({ details: 'three' });
  await wait(300);
  const sets = () => fd.got.filter((g) => g.data && g.data.cmd === 'SET_ACTIVITY').map((g) => g.data.args.activity.details);
  assert.deepStrictEqual(sets(), ['one']);
  assert.ok(dc.flushTimer, 'latest is queued');
  dc.stop();
  fd.server.close();
});

test('IPC: falls back when Discord rejects new fields', async () => {
  const fd = await fakeDiscord({ rejectNewFields: true });
  let t = 0;
  const dc = new DiscordConnection({ clientId: CLIENT, paths: [fd.sockPath], now: () => (t += 10_000) });
  dc.start();
  await until(() => dc.isReady());
  dc.setActivity({ type: 2, status_display_type: 1, details: 'x', assets: { large_image: 'a', large_url: 'https://x' } });
  assert.ok(await until(() => dc.compat));
  assert.ok(await until(() => fd.got.filter((g) => g.data && g.data.cmd === 'SET_ACTIVITY').length >= 2));
  const last = fd.got.filter((g) => g.data && g.data.cmd === 'SET_ACTIVITY').at(-1).data.args.activity;
  assert.ok(!('status_display_type' in last));
  assert.ok(!('large_url' in last.assets));
  dc.stop();
  fd.server.close();
});

test('IPC: invalid client id is reported, no busy retry', async () => {
  const fd = await fakeDiscord();
  const dc = new DiscordConnection({ clientId: '000000000000000000', paths: [fd.sockPath] });
  dc.start();
  assert.ok(await until(() => dc.getState().status === 'bad-client-id'));
  dc.stop();
  fd.server.close();
});

test('IPC: missing Discord → disconnected, retries quietly', async () => {
  const dc = new DiscordConnection({ clientId: CLIENT, paths: ['/nope/a', '/nope/b'] });
  dc.start();
  assert.ok(await until(() => dc.getState().status === 'disconnected' && dc.retryTimer));
  dc.stop();
});

test('IPC: no client id → asks for one', () => {
  const dc = new DiscordConnection({ clientId: '' });
  dc.start();
  assert.strictEqual(dc.getState().status, 'no-client-id');
  dc.stop();
});

/* ---------------- Windows: TIDAL window-title backup ---------------- */

const { SmtcSource } = require('../src/media/windows-smtc');

function smtcRun(lines) {
  const src = new SmtcSource();
  const out = []; const logs = [];
  src.on('players', (p) => out.push(p));
  src.on('log', (l) => logs.push(l));
  for (const l of lines) src.onLine(JSON.stringify(l));
  return { last: out.at(-1), logs };
}
const win = { id: 'window:TIDAL', aumid: 'TIDAL.exe', title: 'Midnight City', artist: 'M83', status: 'Playing', position: -1, duration: 0, fromWindow: true };

test('TIDAL from the window title when Windows reports nothing', () => {
  const { last, logs } = smtcRun([[win]]);
  assert.strictEqual(last.length, 1);
  assert.strictEqual(last[0].player, 'TIDAL');
  assert.strictEqual(last[0].title, 'Midnight City');
  assert.strictEqual(last[0].fromWindow, true);
  assert.ok(last[0].position >= 0 && last[0].position < 1);
  assert.match(logs[0], /TIDAL\.exe \(window title\)/);
});

test('real TIDAL media session wins over the window title', () => {
  const real = { id: 'TIDAL.exe#0', aumid: 'TIDAL.exe', title: 'Midnight City', artist: 'M83', status: 'Playing', position: 30, duration: 243 };
  const { last } = smtcRun([[real, win]]);
  assert.strictEqual(last.length, 1);
  assert.strictEqual(last[0].duration, 243);
  assert.ok(!last[0].fromWindow);
});

test('empty TIDAL media session falls back to the window title', () => {
  const empty = { id: 'TIDAL.exe#0', aumid: 'TIDAL.exe', title: '', artist: '', status: 'Playing', position: 0, duration: 0 };
  const { last } = smtcRun([[empty, win]]);
  assert.ok(last.some((p) => p.fromWindow && p.title === 'Midnight City'));
});
