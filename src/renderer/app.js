'use strict';
/* global window, document, navigator */
const api = window.tunecord;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

const S = {
  state: null,
  config: null,
  receivedAt: 0,
  page: 'now',
  seenPlayers: new Set(),
  lastArt: null,
  info: {},
  lastTplInput: null,
  sample: null
};

const TOKENS = ['title', 'artist', 'album', 'player', 'emoji', 'status', 'position', 'duration'];
const PRESETS = [
  { name: 'Spotify style', details: '{title}', state: '{artist}', largeText: '{album}' },
  { name: '"by" artist', details: '{title}', state: '[by {artist}]', largeText: '[on {album}]' },
  { name: 'Emoji', details: '🎵 {title}', state: '🎤 {artist}', largeText: '💿 {album}' },
  { name: 'Show player', details: '{title}[ — {artist}]', state: 'on {player}', largeText: '{album}' }
];
const BUTTONS = [
  ['none', 'No button'],
  ['source', 'Open in the player I use'],
  ['spotify', 'Listen on Spotify'],
  ['appleMusic', 'Listen on Apple Music'],
  ['youtubeMusic', 'Listen on YouTube Music'],
  ['tidal', 'Listen on TIDAL'],
  ['soundcloud', 'Listen on SoundCloud'],
  ['deezer', 'Listen on Deezer'],
  ['youtube', 'Watch on YouTube']
];
const PER_PLAYER = ['Spotify', 'Apple Music', 'TIDAL', 'SoundCloud', 'YouTube Music', 'Deezer', 'Amazon Music'];

/* ---------------- helpers ---------------- */

const fmt = (s) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
const patchFor = (path, value) => path.split('.').reverse().reduce((acc, k) => ({ [k]: acc }), value);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const cleanErr = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cssUrl = (u) => `url("${String(u).replace(/["\\\n]/g, (c) => '\\' + c)}")`;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 1900);
}

async function setConfig(patch) {
  S.config = await api.setConfig(patch);
  renderConfig();
}

/* ---------------- navigation ---------------- */

function go(page) {
  S.page = page;
  $$('.nav[data-page]').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
  if (page === 'stats') loadStats();
  if (page === 'remote') loadRemote();
  if (page === 'sources') renderSources();
  if (page === 'presence') refreshSample();
  renderPreviews();
}

/* ---------------- album-art colour ---------------- */

function applyAccent(url) {
  const root = document.documentElement.style;
  const reset = () => { root.removeProperty('--acc'); root.removeProperty('--acc-ink'); };
  if (!url || S.config.app.theme === 'discord') return reset();
  const img = new Image();
  if (/^https?:/.test(url)) img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 24;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, 24, 24);
      const px = ctx.getImageData(0, 0, 24, 24).data;
      let r = 0, g = 0, b = 0, w = 0;
      for (let i = 0; i < px.length; i += 4) {
        const max = Math.max(px[i], px[i + 1], px[i + 2]);
        const min = Math.min(px[i], px[i + 1], px[i + 2]);
        const sat = max ? (max - min) / max : 0;
        const weight = sat * sat * (max / 255) + 0.01;
        r += px[i] * weight; g += px[i + 1] * weight; b += px[i + 2] * weight; w += weight;
      }
      const [h, s] = rgbToHsl(r / w, g / w, b / w);
      root.setProperty('--acc', `hsl(${Math.round(h)} ${Math.round(Math.max(45, Math.min(90, s)))}% 64%)`);
      root.setProperty('--acc-ink', `hsl(${Math.round(h)} 60% 9%)`);
    } catch (_) { reset(); }
  };
  img.onerror = reset;
  img.src = url;
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [235, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}

/* ---------------- Discord preview ---------------- */

const PLAY_SVG = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE_SVG = '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';

function appLabel() {
  const c = S.state && S.state.current;
  const per = S.config.discord.perPlayer || {};
  if (c && per[c.player]) return c.player;
  return S.config.discord.appName || 'Music';
}

/** Draws a Discord-style profile card + member-list row from an activity object. */
function drawPreview(el, activity, { dim = false, offText = '' } = {}) {
  const st = S.state;
  const user = (st && st.discord.user) || { name: 'You', username: 'you' };
  const avatar = user.avatar ? `style="${esc(`background-image:${cssUrl(user.avatar)}`)}"` : '';
  el.classList.toggle('dim', !!dim);

  if (!activity) {
    el.innerHTML = `
      <div class="dc-member"><div class="av" ${avatar}></div><div><div class="nm">${esc(user.name)}</div><div class="st">Online</div></div></div>
      <div class="dc-off">${esc(offText || 'No activity shown')}</div>`;
    return;
  }
  const a = activity;
  const verb = a.type === 0 ? 'Playing' : 'Listening to';
  const app = appLabel();
  const memberWhat = a.status_display_type === 1 ? (a.state || app) : a.status_display_type === 2 ? (a.details || app) : app;
  const art = a.assets && a.assets.large_image;
  const small = a.assets && a.assets.small_image;
  const smallKind = small ? (/paused/.test(small) ? 'paused' : 'playing') : null;
  const ts = a.timestamps || null;
  el.dataset.start = ts ? ts.start : '';
  el.dataset.end = ts && ts.end ? ts.end : '';

  el.innerHTML = `
    <div class="dc-member"><div class="av" ${avatar}></div><div><div class="nm">${esc(user.name)}</div><div class="st">${verb} <b>${esc(memberWhat)}</b></div></div></div>
    <div class="dc-profile">
      <div class="dc-banner"></div>
      <div class="dc-profile-body">
        <div class="dc-profile-avatar" ${avatar}></div>
        <div class="dc-profile-name">${esc(user.name)}</div>
        <div class="dc-profile-tag">${esc(user.username || '')}</div>
        <div class="dc-act">
          <div class="dc-act-head">${verb} ${esc(app)}</div>
          <div class="dc-act-main">
            <div class="dc-act-art" style="${art && !/logo\.png$/.test(art) ? esc(`background-image:${cssUrl(art)}`) : ''}" title="${esc(a.assets && a.assets.large_text)}">
              ${smallKind ? `<div class="dc-small ${smallKind}" title="${esc(a.assets.small_text)}">${smallKind === 'paused' ? PAUSE_SVG : PLAY_SVG}</div>` : ''}
            </div>
            <div class="dc-act-lines">
              <div class="d ${a.details_url ? 'link' : ''}">${esc(a.details)}</div>
              ${a.state ? `<div class="s ${a.state_url ? 'link' : ''}">${esc(a.state)}</div>` : ''}
              ${a.assets && a.assets.large_text ? `<div class="l">${esc(a.assets.large_text)}</div>` : ''}
              ${ts ? `<div class="dc-time"><span class="p">0:00</span>${ts.end ? '<div class="bar"><i></i></div><span class="e"></span>' : '<span>elapsed</span>'}</div>` : ''}
            </div>
          </div>
          ${a.buttons && a.buttons.length ? `<div class="dc-btns">${a.buttons.map((b) => `<div class="dc-btn" title="${esc(b.url)}">${esc(b.label)}</div>`).join('')}</div>` : ''}
        </div>
      </div>
    </div>`;
  tickPreview(el);
}

function tickPreview(el) {
  const start = Number(el.dataset.start);
  if (!start) return;
  const end = Number(el.dataset.end);
  const now = Date.now();
  const p = $('.dc-time .p', el);
  if (!p) return;
  if (end) {
    const elapsed = Math.min(now, end) - start;
    p.textContent = fmt(elapsed / 1000);
    $('.dc-time .e', el).textContent = fmt((end - start) / 1000);
    $('.dc-time .bar i', el).style.width = `${Math.max(0, Math.min(100, (elapsed / (end - start)) * 100))}%`;
  } else {
    p.textContent = fmt((now - start) / 1000);
  }
}

/** Activity for the designer when nothing is playing: built from the sample song. */
async function refreshSample() {
  if (S.state && S.state.activity) { S.sample = null; return; }
  const p = S.config.presence;
  const r = await api.preview({ details: p.details, state: p.state, largeText: p.largeText });
  const now = Date.now();
  const btnLabel = (k) => (k === 'source' ? 'Open in Spotify' : (BUTTONS.find((b) => b[0] === k) || [])[1]);
  S.sample = {
    type: p.activityType === 'playing' ? 0 : 2,
    status_display_type: { app: 0, artist: 1, title: 2 }[p.statusLine],
    details: r.details || 'Midnight City',
    state: r.state || undefined,
    details_url: p.clickableText ? 'x' : undefined,
    state_url: p.clickableText && r.state ? 'x' : undefined,
    assets: {
      large_image: null,
      large_text: r.largeText || undefined,
      small_image: p.icon === 'state' ? 'playing.png' : undefined,
      small_text: 'Playing on Spotify'
    },
    timestamps: p.timestamps === 'none' ? undefined : { start: now - 95_000, end: p.timestamps === 'progress' ? now + 148_000 : undefined },
    buttons: p.buttons.filter((k) => k !== 'none').map((k) => ({ label: btnLabel(k), url: '' }))
  };
  renderPreviews();
}

function renderPreviews() {
  const st = S.state;
  if (!st) return;
  const nowEl = $('[data-preview="now"]');
  const a = st.activity;
  const off = !st.enabled ? 'Status is off — Discord shows nothing from TuneCord'
    : st.current ? 'Nothing is shown right now' : 'Nothing playing';
  drawPreview(nowEl, a, { dim: !!a && !st.live, offText: off });

  const presEl = $('[data-preview="presence"]');
  drawPreview(presEl, a || S.sample, { offText: 'Loading preview…' });
  $('#preview-note').textContent = a ? 'Shows the song that is playing now.' : 'Example song: nothing is playing right now.';
}

/* ---------------- state rendering ---------------- */

function renderState() {
  const st = S.state;
  if (!st) return;
  const c = st.current;
  st.players.forEach((p) => S.seenPlayers.add(p.app || p.player));

  document.body.classList.toggle('playing', !!(c && c.status === 'playing'));
  $$('.t-title').forEach((el) => { el.textContent = c ? c.title : 'Nothing playing'; });
  $$('.t-artist').forEach((el) => {
    el.textContent = c ? [c.artist, c.album].filter(Boolean).join(' · ') || ' ' : 'Start Spotify, Apple Music, TIDAL, SoundCloud or any player and it shows up here.';
  });
  $$('.t-player').forEach((el) => {
    el.textContent = c ? `${c.status === 'playing' ? 'Playing' : 'Paused'} on ${c.player}` : 'Waiting for music';
  });
  $$('.pp-icon').forEach((el) => {
    el.innerHTML = c && c.status === 'playing' ? '<path d="M6 5h4v14H6zm8 0h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
  });
  $$('[data-ctl]').forEach((b) => { b.disabled = !c; });
  $('#share').style.visibility = c ? 'visible' : 'hidden';

  const art = c && c.artUrl;
  if (art !== S.lastArt) {
    S.lastArt = art;
    $$('.art').forEach((el) => { el.style.backgroundImage = art ? cssUrl(art) : ''; });
    $('#ambient').style.backgroundImage = art ? cssUrl(art) : '';
    document.body.classList.toggle('has-art', !!art);
    applyAccent(art);
  }

  $$('.js-status-toggle').forEach((b) => b.classList.toggle('on', st.enabled));
  renderDiscord();
  renderNote();
  renderPlayers();
  renderPreviews();
  if (S.page === 'sources') renderSources();
  tickProgress();
}

function tickProgress() {
  const c = S.state && S.state.current;
  if (!c) {
    $$('.t-prog').forEach((el) => { el.style.width = '0'; });
    $$('.t-pos, .t-dur').forEach((el) => { el.textContent = '0:00'; });
  } else {
    let pos = c.position + (c.status === 'playing' ? (Date.now() - S.receivedAt) / 1000 : 0);
    if (c.duration) pos = Math.min(pos, c.duration);
    const pct = c.duration ? (pos / c.duration) * 100 : 0;
    $$('.t-prog').forEach((el) => { el.style.width = `${pct}%`; });
    $('.seek-knob').style.left = `${pct}%`;
    $$('.t-pos').forEach((el) => { el.textContent = fmt(pos); });
    $$('.t-dur').forEach((el) => { el.textContent = c.duration ? fmt(c.duration) : '–:––'; });
  }
  $$('.dc-preview').forEach(tickPreview);
}

const DC = {
  ready: ['Connected', 'ok'],
  connecting: ['Connecting…', 'busy'],
  disconnected: ['Discord not running', ''],
  'no-client-id': ['Needs Application ID', 'bad'],
  'bad-client-id': ['Wrong Application ID', 'bad'],
  disabled: ['Off', '']
};

function renderDiscord() {
  const d = S.state.discord;
  const [label, cls] = DC[d.status] || [d.status, ''];
  for (const pill of [$('#dc-pill'), $('#dc-pill-2')]) {
    pill.className = `dc-pill ${cls}`;
    pill.querySelector('span').textContent = `Discord · ${label}`;
  }
  const u = d.user;
  $('#dc-avatar').style.backgroundImage = u && u.avatar ? cssUrl(u.avatar) : '';
  $('#dc-name').textContent = u ? u.name : label;
  $('#dc-detail').textContent = u
    ? `@${u.username || ''} · ${S.state.live ? 'your music is on your profile' : 'nothing shown right now'}`
    : d.status === 'disconnected' ? 'Open the Discord desktop app. TuneCord connects by itself.'
      : d.status === 'no-client-id' ? 'Paste an Application ID below.'
        : d.status === 'bad-client-id' ? (d.error || 'Check the Application ID below.') : '';

  // banner on Now playing
  const banner = $('#setup-banner');
  let show = true;
  if (d.status === 'no-client-id' || d.status === 'bad-client-id') {
    $('#setup-title').textContent = d.status === 'no-client-id' ? 'One-time setup: Discord Application ID' : 'Discord didn\'t accept the Application ID';
    $('#setup-text').textContent = 'Takes two minutes: make a free application on Discord\'s developer site and paste its ID in Settings.';
    $('#setup-btn').hidden = false;
  } else if (d.status === 'disconnected') {
    $('#setup-title').textContent = 'Discord isn\'t running';
    $('#setup-text').textContent = 'Open the Discord desktop app (the website can\'t show Rich Presence). TuneCord connects automatically.';
    $('#setup-btn').hidden = true;
  } else show = false;
  banner.hidden = !show;
}

function renderNote() {
  const st = S.state;
  let note = '';
  if (st.testing) note = '🧪 Showing a test song for 30 seconds.';
  else if (!st.enabled) note = 'Status is off.';
  else if (st.discord.status !== 'ready') note = 'Preview — goes live as soon as Discord is connected.';
  else if (st.hidden) note = '🙈 This song is on your filter list.';
  else if (st.live) note = 'Live on your Discord profile.';
  else if (st.current && st.current.status === 'paused') note = 'Paused — hidden per your settings.';
  $('#friend-note').textContent = note;
}

function renderPlayers() {
  const st = S.state;
  const list = $('#player-list');
  $('#backend').textContent = st.media.error ? `⚠ ${st.media.backend}` : st.media.backend;
  $('#backend').title = st.media.error || '';
  if (!st.players.length) {
    list.innerHTML = `<div class="empty">No players found yet. Open your music app and press play.${st.media.error ? `<br><span class="small">${esc(st.media.error)}</span>` : ''}</div>`;
    return;
  }
  const cur = st.current && st.current.id;
  list.innerHTML = st.players.map((p) => `
    <button class="player ${p.id === cur ? 'current' : ''}" data-player="${esc(p.player)}" title="Pin this player">
      <div class="pbody"><div class="pname">${esc(p.player)}${p.app && p.app !== p.player ? ` <small>via ${esc(p.app)}</small>` : ''}</div><div class="ptrack">${esc(p.title)}${p.artist ? ' — ' + esc(p.artist) : ''}</div></div>
      ${st.pinned === p.player ? '<span class="badge pin">Pinned</span>' : ''}
      <span class="badge ${p.status === 'playing' ? 'play' : ''}">${p.status}</span>
    </button>`).join('');
}

/* ---------------- config rendering ---------------- */

function renderConfig() {
  const cfg = S.config;
  if (!cfg) return;
  document.body.classList.toggle('compact', !!cfg.app.compact);

  $$('[data-cfg]').forEach((el) => el.classList.toggle('on', !!getPath(cfg, el.dataset.cfg)));
  $$('[data-cfg-on]').forEach((el) => el.classList.toggle('on', getPath(cfg, el.dataset.cfgOn) === el.dataset.on));
  $$('[data-cfg-num]').forEach((el) => { if (document.activeElement !== el) el.value = getPath(cfg, el.dataset.cfgNum); });
  $$('[data-cfg-text]').forEach((el) => { if (document.activeElement !== el) el.value = getPath(cfg, el.dataset.cfgText) || ''; });
  $$('[data-cfg-seg]').forEach((seg) => {
    const v = getPath(cfg, seg.dataset.cfgSeg);
    $$('button', seg).forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  });
  $$('#source-mode button').forEach((b) => b.classList.toggle('on', b.dataset.v === cfg.sources.mode));
  $('#theme-switch').classList.toggle('on', cfg.app.theme !== 'discord');

  $$('[data-tpl]').forEach((el) => { if (document.activeElement !== el) el.value = cfg.presence[el.dataset.tpl] || ''; });
  $$('.presets .chip').forEach((c, i) => {
    const p = PRESETS[i];
    c.classList.toggle('on', p.details === cfg.presence.details && p.state === cfg.presence.state && p.largeText === cfg.presence.largeText);
  });
  $$('[data-button]').forEach((sel) => { sel.value = cfg.presence.buttons[+sel.dataset.button] || 'none'; });

  $('#hide-list').innerHTML = cfg.privacy.hideList.length
    ? cfg.privacy.hideList.map((w, i) => `<span class="tag">${esc(w)}<button data-unhide="${i}" title="Remove">×</button></span>`).join('')
    : '<span class="muted small">Nothing filtered.</span>';

  const cid = $('#client-id');
  if (document.activeElement !== cid) cid.value = cfg.discord.clientId || '';
  cid.placeholder = S.info.builtinClientId ? 'Built-in (leave empty)' : 'e.g. 1311223344556677889';
  $('#client-id-hint').textContent = S.info.builtinClientId
    ? 'TuneCord has a built-in application. Only fill this in if you want your own name or icon.'
    : 'Required once. See the steps below.';
  const pp = $('#per-player');
  if (!pp.contains(document.activeElement)) {
    pp.innerHTML = PER_PLAYER.map((n) => `<span>${esc(n)}</span><input class="input mono" data-per="${esc(n)}" placeholder="Same as above" value="${esc(cfg.discord.perPlayer[n] || '')}" inputmode="numeric">`).join('');
  }

  $$('[data-hk]').forEach((el) => { if (!el.classList.contains('recording')) el.value = pretty(cfg.hotkeys[el.dataset.hk] || ''); });
  if (S.page === 'sources') renderSources();
  if (S.page === 'remote') loadRemote();
  if (S.page === 'presence') refreshSample();
}

/* ---------------- presence designer ---------------- */

const saveTemplates = debounce(() => {
  const patch = {};
  $$('[data-tpl]').forEach((el) => { patch[el.dataset.tpl] = el.value; });
  setConfig({ presence: patch });
}, 450);

function setupDesigner() {
  $('#tokens').innerHTML = TOKENS.map((t) => `<button class="chip" data-token="${t}">{${t}}</button>`).join('');
  $('#presets').innerHTML = PRESETS.map((p, i) => `<button class="chip" data-preset="${i}">${esc(p.name)}</button>`).join('');
  $$('[data-button]').forEach((sel) => { sel.innerHTML = BUTTONS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join(''); });

  $$('[data-tpl]').forEach((el) => {
    el.addEventListener('focus', () => { S.lastTplInput = el; });
    el.addEventListener('input', saveTemplates);
  });
  S.lastTplInput = $('[data-tpl="details"]');
  $('#tokens').addEventListener('mousedown', (e) => e.preventDefault()); // keep caret in the field
  $('#tokens').addEventListener('click', (e) => {
    const b = e.target.closest('[data-token]');
    if (!b) return;
    const input = S.lastTplInput;
    const ins = `{${b.dataset.token}}`;
    const s = input.selectionStart ?? input.value.length;
    input.value = input.value.slice(0, s) + ins + input.value.slice(input.selectionEnd ?? s);
    input.focus();
    input.setSelectionRange(s + ins.length, s + ins.length);
    saveTemplates();
  });
  $('#presets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-preset]');
    if (!b) return;
    const { details, state, largeText } = PRESETS[+b.dataset.preset];
    setConfig({ presence: { details, state, largeText } });
  });
  $$('[data-button]').forEach((sel) => sel.addEventListener('change', () => {
    const buttons = $$('[data-button]').map((s) => s.value);
    setConfig({ presence: { buttons } });
  }));
  $('#hide-add').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.value.trim()) return;
    const list = [...S.config.privacy.hideList, e.target.value.trim()];
    e.target.value = '';
    api.replaceConfig('privacy.hideList', list).then((c) => { S.config = c; renderConfig(); });
  });
  $('#hide-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-unhide]');
    if (!b) return;
    const list = S.config.privacy.hideList.filter((_, i) => i !== +b.dataset.unhide);
    api.replaceConfig('privacy.hideList', list).then((c) => { S.config = c; renderConfig(); });
  });
}

/* ---------------- sources ---------------- */

function renderSources() {
  const cfg = S.config;
  const list = $('#source-list');
  if (list.contains(document.activeElement)) return; // don't wipe a field you're typing in
  const live = new Map((S.state ? S.state.players : []).map((p) => [p.app || p.player, p]));
  const names = new Set([...S.seenPlayers, ...cfg.sources.blocked, ...Object.keys(cfg.sources.rename)]);
  if (!names.size) {
    list.innerHTML = '<div class="empty">No players seen yet — start playing something.</div>';
  } else {
    list.innerHTML = [...names].sort().map((n) => {
      const p = live.get(n);
      const shown = cfg.sources.rename[n] || (p && p.player) || n;
      const blocked = cfg.sources.blocked.includes(n) || cfg.sources.blocked.includes(shown);
      const pinned = cfg.sources.pinned === shown;
      return `<div class="source">
        <div class="grow"><b>${esc(n)}</b><span class="muted small">${p ? esc(`${p.status} · ${p.title}`) : blocked ? 'hidden' : 'not running'}</span></div>
        <input class="input" data-rename="${esc(n)}" value="${esc(cfg.sources.rename[n] || '')}" placeholder="Show as…" title="Name shown on Discord, e.g. SoundCloud">
        <button class="chip ${pinned ? 'on' : ''}" data-pin="${esc(shown)}">${pinned ? 'Pinned' : 'Pin'}</button>
        <span class="muted small">Show</span>
        <button class="switch ${blocked ? '' : 'on'}" data-block="${esc(n)}" title="Show this player on Discord"></button>
      </div>`;
    }).join('');
  }
  $('#source-hint').textContent = cfg.sources.mode === 'pinned'
    ? (cfg.sources.pinned ? `Only ${cfg.sources.pinned} is used while it's open.` : 'Pick a player to pin.')
    : 'The player that is actually playing wins. If several play at once, TuneCord sticks with the one that started first.';
}

/* ---------------- stats ---------------- */

async function loadStats() {
  const st = await api.stats();
  $('#k-today').textContent = st.todayMinutes;
  $('#k-streak').textContent = st.streakDays;
  $('#k-plays').textContent = st.totalPlays;
  $('#k-total').textContent = (st.totalMinutes / 60).toFixed(st.totalMinutes < 600 ? 1 : 0);
  const max = Math.max(30, ...st.last7.map((d) => d.minutes));
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  $('#week').innerHTML = st.last7.map((d, i) => `
    <div class="col ${i === 6 ? 'today' : ''}" title="${d.minutes} min">
      <span class="m">${d.minutes || ''}</span>
      <div class="bar" style="height:${(d.minutes / max) * 100}%"></div>
      <span class="d">${i === 6 ? 'Today' : days[new Date(d.day + 'T12:00').getDay()]}</span>
    </div>`).join('');
  $('#top-artists').innerHTML = st.topArtists.length
    ? st.topArtists.map((a) => `<li><span class="n">${esc(a.name)}</span><span class="v">${a.minutes} min</span></li>`).join('')
    : '<li class="empty">Play some music to fill this up.</li>';
  $('#top-tracks').innerHTML = st.topTracks.length
    ? st.topTracks.map((t) => `<li><span class="n">${esc(t.title)} <small>${esc(t.artist)}</small></span><span class="v">${t.plays}×</span></li>`).join('')
    : '<li class="empty">Nothing yet.</li>';
  $('#recent').innerHTML = st.recent.length
    ? st.recent.map((p) => `<li><span>${esc(p.title)}${p.artist ? ' — ' + esc(p.artist) : ''}</span><span>${new Date(p.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></li>`).join('')
    : '<li class="empty">Nothing yet.</li>';
}

/* ---------------- remote ---------------- */

async function loadRemote() {
  const info = await api.remoteInfo();
  $('#remote-url').textContent = info.enabled ? info.url : '—';
  const err = $('#remote-err');
  err.hidden = !info.error;
  err.textContent = info.error ? `Couldn't start the remote: ${info.error}. Try another port.` : '';
  const qr = $('#remote-qr');
  if (info.enabled && info.running) {
    if (qr.dataset.url !== info.url) {
      qr.dataset.url = info.url;
      qr.innerHTML = `<img alt="Phone remote QR code" src="${await api.qr(info.url)}">`;
    }
  } else {
    qr.dataset.url = '';
    qr.innerHTML = `<span class="muted">${info.enabled ? 'Starting…' : 'Turn on to get a QR code'}</span>`;
  }
}

/* ---------------- hotkeys ---------------- */

const isMac = navigator.platform.toLowerCase().includes('mac');
function pretty(accel) { return accel.replace('CommandOrControl', isMac ? '⌘' : 'Ctrl').replace(/\+/g, ' + '); }
function accelFromEvent(e) {
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  let key = e.key;
  if (['Control', 'Meta', 'Alt', 'Shift'].includes(key)) return null;
  if (key === ' ') key = 'Space';
  else if (/^Arrow/.test(key)) key = key.replace('Arrow', '');
  else if (key.length === 1) key = key.toUpperCase();
  const keyFromCode = /^Key[A-Z]$|^Digit\d$/.test(e.code) ? e.code.slice(-1) : null;
  if (keyFromCode && e.altKey) key = keyFromCode;
  if (!mods.length && !/^F\d{1,2}$|^Media/.test(key)) return null;
  return [...mods, key].join('+');
}
function setupHotkeys() {
  $$('[data-hk]').forEach((el) => {
    el.readOnly = true;
    el.addEventListener('focus', () => { el.classList.add('recording'); el.value = 'Press keys…'; });
    el.addEventListener('blur', () => { el.classList.remove('recording'); renderConfig(); });
    el.addEventListener('keydown', (e) => {
      e.preventDefault();
      if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey && !e.metaKey) {
        setConfig({ hotkeys: { [el.dataset.hk]: '' } });
        el.blur();
        return;
      }
      if (e.key === 'Escape') { el.blur(); return; }
      const accel = accelFromEvent(e);
      if (!accel) return;
      setConfig({ hotkeys: { [el.dataset.hk]: accel } }).then(() => el.blur());
    });
  });
}

/* ---------------- events ---------------- */

function setupEvents() {
  $$('.nav[data-page]').forEach((b) => b.addEventListener('click', () => go(b.dataset.page)));
  document.addEventListener('click', async (e) => {
    const t = e.target;
    const ctl = t.closest('[data-ctl]');
    if (ctl) return api.control(ctl.dataset.ctl);

    const link = t.closest('[data-url]');
    if (link) { e.preventDefault(); return api.openUrl(link.dataset.url); }

    const tog = t.closest('.js-status-toggle');
    if (tog) {
      const on = await api.toggleStatus();
      return toast(on ? 'Showing on Discord' : 'Discord status off');
    }

    const sw = t.closest('[data-cfg]');
    if (sw) return setConfig(patchFor(sw.dataset.cfg, !getPath(S.config, sw.dataset.cfg)));

    const swOn = t.closest('[data-cfg-on]');
    if (swOn) {
      const isOn = getPath(S.config, swOn.dataset.cfgOn) === swOn.dataset.on;
      return setConfig(patchFor(swOn.dataset.cfgOn, isOn ? swOn.dataset.off : swOn.dataset.on));
    }

    const seg = t.closest('[data-cfg-seg] button');
    if (seg) return setConfig(patchFor(seg.parentElement.dataset.cfgSeg, seg.dataset.v));

    const goto = t.closest('[data-goto]');
    if (goto) return go(goto.dataset.goto);

    const player = t.closest('[data-player]');
    if (player) {
      const name = player.dataset.player;
      const wasPinned = S.state.pinned === name;
      await api.selectPlayer(wasPinned ? null : name);
      return toast(wasPinned ? 'Back to automatic' : `Pinned ${name} — click again to unpin`);
    }

    const pin = t.closest('[data-pin]');
    if (pin) return api.selectPlayer(S.config.sources.pinned === pin.dataset.pin ? null : pin.dataset.pin);

    const block = t.closest('[data-block]');
    if (block) {
      const n = block.dataset.block;
      const shown = S.config.sources.rename[n];
      const isBlocked = S.config.sources.blocked.includes(n) || (shown && S.config.sources.blocked.includes(shown));
      const list = isBlocked ? S.config.sources.blocked.filter((x) => x !== n && x !== shown) : [...S.config.sources.blocked, n];
      S.config = await api.replaceConfig('sources.blocked', list);
      return renderConfig();
    }

    const share = t.closest('[data-share]');
    if (share && S.state.current) {
      const c = S.state.current;
      if (share.dataset.share === 'copy') {
        await api.copy(`🎵 ${c.title}${c.artist ? ' — ' + c.artist : ''}${c.links.direct ? '\n' + c.links.direct : ''}`);
        return toast('Copied');
      }
      return api.openUrl(c.links[share.dataset.share]);
    }
  });

  $('#source-list').addEventListener('input', debounce(async (e) => {
    const el = e.target.closest('[data-rename]');
    if (!el) return;
    const rename = { ...S.config.sources.rename };
    const v = el.value.trim();
    if (v) rename[el.dataset.rename] = v; else delete rename[el.dataset.rename];
    S.config = await api.replaceConfig('sources.rename', rename);
  }, 600));
  $('#source-list').addEventListener('focusout', () => setTimeout(renderSources, 700));

  $('#source-mode').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.v === 'auto') api.selectPlayer(null);
    else if (S.state.current) api.selectPlayer(S.config.sources.pinned || S.state.current.player);
    else setConfig({ sources: { mode: 'pinned' } });
  });

  $$('[data-cfg-num]').forEach((el) => el.addEventListener('change', () => setConfig(patchFor(el.dataset.cfgNum, Number(el.value)))));
  $$('[data-cfg-text]').forEach((el) => el.addEventListener('input', debounce(() => setConfig(patchFor(el.dataset.cfgText, el.value)), 500)));

  $('#theme-switch').addEventListener('click', () => {
    setConfig({ app: { theme: S.config.app.theme === 'discord' ? 'auto' : 'discord' } }).then(() => applyAccent(S.lastArt));
  });

  $('#seek').addEventListener('click', (e) => {
    const c = S.state && S.state.current;
    if (!c || !c.duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    api.control('seek', ((e.clientX - r.left) / r.width) * c.duration);
  });

  // Discord
  const saveId = async () => {
    const v = $('#client-id').value.replace(/\D/g, '');
    if (v && !/^\d{17,20}$/.test(v)) return toast('That doesn\'t look like an Application ID (17–20 digits)');
    await setConfig({ discord: { clientId: v } });
    toast(v ? 'Saved — connecting to Discord…' : 'Using the built-in application');
  };
  $('#client-id-save').addEventListener('click', saveId);
  $('#client-id').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveId(); });
  $('#per-player').addEventListener('input', debounce(async (e) => {
    const el = e.target.closest('[data-per]');
    if (!el) return;
    const map = { ...S.config.discord.perPlayer };
    const v = el.value.replace(/\D/g, '');
    if (v) map[el.dataset.per] = v; else delete map[el.dataset.per];
    S.config = await api.replaceConfig('discord.perPlayer', map);
  }, 600));
  $('#dc-test').addEventListener('click', async () => {
    const r = await api.discordTest();
    toast(r.ok ? 'Test song is on your profile for 30 s — click your name in Discord' : r.reason);
  });
  $('#dc-reconnect').addEventListener('click', async () => { await api.discordReconnect(); toast('Reconnecting…'); });

  $('#remote-copy').addEventListener('click', async () => {
    const info = await api.remoteInfo();
    if (info.enabled) { await api.copy(info.url); toast('Link copied'); }
  });
  $('#remote-regen').addEventListener('click', async () => { await api.remoteRegen(); $('#remote-qr').dataset.url = ''; loadRemote(); toast('Old link no longer works'); });

  $('#stats-clear').addEventListener('click', async () => {
    if (!window.confirm('Reset all listening stats?')) return;
    await api.clearStats();
    loadStats();
  });

  $('#open-logs').addEventListener('click', () => api.openLogs());
  $('#go-mini').addEventListener('click', () => api.setCompact(true));
  $('#mini-expand').addEventListener('click', () => api.setCompact(false));

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
      e.preventDefault();
      api.control('playpause');
    }
  });
}

function appendLog(line) {
  const el = $('#log');
  el.textContent = (el.textContent ? el.textContent + '\n' : '') + line;
  const lines = el.textContent.split('\n');
  if (lines.length > 120) el.textContent = lines.slice(-120).join('\n');
  el.scrollTop = el.scrollHeight;
}

/* ---------------- boot ---------------- */

(async function boot() {
  const init = await api.init();
  S.info = init;
  S.config = init.config;
  S.state = init.state;
  S.receivedAt = Date.now();
  document.body.classList.toggle('mac', init.platform === 'darwin');
  $('#version').textContent = `TuneCord ${init.version} · ${init.platform}`;
  init.logs.forEach(appendLog);
  if (!init.builtinClientId && !init.config.discord.clientId) $('#howto').open = true;

  setupDesigner();
  setupHotkeys();
  setupEvents();
  renderConfig();
  renderState();
  const hash = new URLSearchParams(window.location.search).get('page') || (window.location.hash || '').slice(1);
  if (['presence', 'sources', 'stats', 'remote', 'settings'].includes(hash)) go(hash);

  api.onState((s) => {
    const hadActivity = S.state && S.state.activity;
    S.state = s;
    S.receivedAt = Date.now();
    if (!s.activity && (hadActivity || !S.sample)) refreshSample();
    renderState();
  });
  api.onConfig((c) => { S.config = c; renderConfig(); });
  api.onLog(appendLog);
  setInterval(tickProgress, 500);
  setInterval(() => { if (S.page === 'stats') loadStats(); }, 30_000);
})();
