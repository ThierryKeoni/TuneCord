'use strict';
// Phone remote: a tiny web page on your local network. Scan the QR code in the
// app and control music + your Discord status from the couch.
const http = require('http');
const os = require('os');
const fs = require('fs');
const { fileURLToPath } = require('url');

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out.sort((a, b) => Number(!/^192\.168\./.test(a)) - Number(!/^192\.168\./.test(b)));
}

class RemoteServer {
  constructor({ engine, config }) {
    this.engine = engine;
    this.config = config;
    this.server = null;
  }

  info() {
    const { port, token, enabled } = this.config.get().remote;
    const ip = lanAddresses()[0] || '127.0.0.1';
    return { enabled, running: !!this.server, url: `http://${ip}:${port}/?t=${token}`, error: this.error || null };
  }

  sync() {
    const { enabled, port } = this.config.get().remote;
    if (enabled && (!this.server || this.port !== port)) { this.stop(); this.start(); }
    if (!enabled) this.stop();
  }

  start() {
    const { port } = this.config.get().remote;
    this.port = port;
    this.error = null;
    this.server = http.createServer((req, res) => this.handle(req, res).catch(() => { res.writeHead(500); res.end(); }));
    this.server.on('error', (err) => { this.error = err.message; this.server = null; });
    this.server.listen(port, '0.0.0.0');
  }

  stop() {
    if (this.server) { this.server.close(); this.server = null; }
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const token = this.config.get().remote.token;
    const authed = url.searchParams.get('t') === token || req.headers['x-token'] === token;
    if (!authed) { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('Forbidden'); return; }

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const s = this.engine.getState();
      const c = s.current;
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        enabled: s.enabled,
        live: s.live,
        line: s.activity ? [s.activity.details, s.activity.state].filter(Boolean).join(' · ') : null,
        discord: { status: s.discord.status },
        current: c && { title: c.title, artist: c.artist, album: c.album, player: c.player, status: c.status, position: c.position, duration: c.duration, key: c.key }
      }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/art') return this.sendArt(res);
    if (req.method === 'POST' && url.pathname === '/api/cmd') {
      const body = await readBody(req);
      let cmd = {};
      try { cmd = JSON.parse(body); } catch (_) { /* empty */ }
      if (cmd.action === 'toggleStatus') this.engine.toggleStatus();
      else if (['playpause', 'next', 'previous', 'seek'].includes(cmd.action)) await this.engine.control(cmd.action, cmd.arg);
      res.writeHead(204); res.end();
      return;
    }
    res.writeHead(404); res.end();
  }

  sendArt(res) {
    const art = this.engine.current && this.engine.current.artUrl;
    if (!art) { res.writeHead(404); res.end(); return; }
    if (art.startsWith('data:')) {
      const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(art);
      if (!m) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': m[1] || 'image/png', 'cache-control': 'no-store' });
      res.end(Buffer.from(m[3], m[2] ? 'base64' : 'utf8'));
      return;
    }
    if (art.startsWith('file://')) {
      fs.readFile(fileURLToPath(art), (err, buf) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
        res.end(buf);
      });
      return;
    }
    if (/^https?:\/\//.test(art)) { res.writeHead(302, { location: art }); res.end(); return; }
    res.writeHead(404); res.end();
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 10_000) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#111214">
<title>TuneCord Remote</title>
<style>
  :root { --bg:#111214; --fg:#f2f3f5; --dim:#949ba4; --acc:#5865f2; --ok:#23a55a; }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  body { margin:0; min-height:100vh; background:var(--bg); color:var(--fg);
    font:16px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif; display:flex; flex-direction:column; align-items:center; padding:24px 20px 32px; }
  #bg { position:fixed; inset:0; background-size:cover; background-position:center; filter:blur(48px) brightness(.35) saturate(1.3); transform:scale(1.2); z-index:-1; }
  .art { width:min(78vw,340px); aspect-ratio:1; border-radius:18px; background:#2b2d31 center/cover; box-shadow:0 30px 60px rgba(0,0,0,.5); margin-top:12px; }
  h1 { font-size:22px; margin:22px 0 4px; text-align:center; }
  .sub { color:var(--dim); text-align:center; }
  .bar { width:min(86vw,360px); height:6px; border-radius:3px; background:rgba(255,255,255,.15); margin:22px 0 6px; overflow:hidden; }
  .bar i { display:block; height:100%; width:0; background:var(--fg); border-radius:3px; }
  .times { width:min(86vw,360px); display:flex; justify-content:space-between; color:var(--dim); font-size:13px; font-variant-numeric:tabular-nums; }
  .ctl { display:flex; gap:26px; margin:22px 0; align-items:center; }
  button { border:0; background:none; color:var(--fg); padding:0; cursor:pointer; }
  .ctl button svg { width:38px; height:38px; fill:currentColor; }
  .ctl .pp { width:78px; height:78px; border-radius:50%; background:var(--fg); color:var(--bg); display:grid; place-items:center; }
  .ctl .pp svg { width:36px; height:36px; }
  .status { margin-top:auto; width:min(90vw,380px); background:rgba(0,0,0,.35); border-radius:14px; padding:14px 16px; display:flex; align-items:center; gap:12px; }
  .status .txt { flex:1; min-width:0; }
  .status .lbl { font-size:12px; color:var(--ok); }
  .status .val { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .tog { width:52px; height:30px; border-radius:15px; background:#4e5058; position:relative; flex:none; }
  .tog::after { content:""; position:absolute; top:3px; left:3px; width:24px; height:24px; border-radius:50%; background:#fff; transition:left .2s; }
  .tog.on { background:var(--ok); } .tog.on::after { left:25px; }
</style></head><body>
<div id="bg"></div>
<div class="art" id="art"></div>
<h1 id="title">Nothing playing</h1>
<div class="sub" id="artist">Start some music on your computer</div>
<div class="bar"><i id="prog"></i></div>
<div class="times"><span id="pos">0:00</span><span id="dur">0:00</span></div>
<div class="ctl">
  <button data-a="previous" aria-label="Previous"><svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg></button>
  <button data-a="playpause" class="pp" aria-label="Play/Pause"><svg viewBox="0 0 24 24" id="ppi"><path d="M8 5v14l11-7z"/></svg></button>
  <button data-a="next" aria-label="Next"><svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg></button>
</div>
<div class="status">
  <div class="txt"><div class="lbl" id="lbl">Discord status</div><div class="val" id="st">—</div></div>
  <button class="tog" id="tog" data-a="toggleStatus" aria-label="Toggle Discord status"></button>
</div>
<script>
const T = new URLSearchParams(location.search).get('t');
const $ = (id) => document.getElementById(id);
const fmt = (s) => { s = Math.max(0, Math.floor(s||0)); return Math.floor(s/60) + ':' + String(s%60).padStart(2,'0'); };
let state = null, lastKey = null, fetchedAt = 0;
async function cmd(action, arg) {
  await fetch('/api/cmd?t=' + T, { method:'POST', body: JSON.stringify({ action, arg }) });
  setTimeout(load, 300);
}
document.querySelectorAll('[data-a]').forEach(b => b.onclick = () => cmd(b.dataset.a));
document.querySelector('.bar').onclick = (e) => {
  const c = state && state.current; if (!c || !c.duration) return;
  const r = e.currentTarget.getBoundingClientRect();
  cmd('seek', (e.clientX - r.left) / r.width * c.duration);
};
async function load() {
  try { state = await (await fetch('/api/state?t=' + T)).json(); fetchedAt = Date.now(); render(); } catch (e) {}
}
function render() {
  const c = state && state.current;
  $('title').textContent = c ? c.title : 'Nothing playing';
  $('artist').textContent = c ? [c.artist, c.player].filter(Boolean).join(' · ') : 'Start some music on your computer';
  $('ppi').innerHTML = c && c.status === 'playing' ? '<path d="M6 5h4v14H6zm8 0h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
  if (c && c.key !== lastKey) {
    lastKey = c.key;
    const u = 'url(/api/art?t=' + T + '&k=' + encodeURIComponent(c.key) + ')';
    $('art').style.backgroundImage = u; $('bg').style.backgroundImage = u;
  }
  $('tog').classList.toggle('on', !!state.enabled);
  $('lbl').textContent = state.discord.status === 'ready' ? (state.live ? 'On Discord now' : 'Discord connected') : 'Discord: ' + state.discord.status.replace(/-/g, ' ');
  $('st').textContent = state.enabled ? (state.line || '—') : 'Status off';
  tick();
}
function tick() {
  const c = state && state.current; if (!c) return;
  const pos = c.position + (c.status === 'playing' ? (Date.now() - fetchedAt) / 1000 : 0);
  $('pos').textContent = fmt(pos); $('dur').textContent = fmt(c.duration);
  $('prog').style.width = c.duration ? Math.min(100, pos / c.duration * 100) + '%' : '0';
}
load(); setInterval(load, 2000); setInterval(tick, 500);
</script></body></html>`;

module.exports = { RemoteServer, lanAddresses };
