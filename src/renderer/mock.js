'use strict';
// Design-time mock: open index.html in a normal browser to work on the UI.
// Inside the app the real preload API exists, so this does nothing.
(function () {
  if (window.tunecord) return;
  const q = new URLSearchParams(location.search);
  const listeners = { state: [], config: [], log: [] };
  const emit = (ch, v) => listeners[ch].forEach((f) => f(v));
  const config = {
    statusEnabled: true,
    presence: { activityType: 'listening', statusLine: 'artist', details: '{title}', state: '{artist}', largeText: '{album}', timestamps: 'progress', icon: 'state', buttons: ['source', 'youtubeMusic'], clickableText: true },
    paused: { behavior: 'show', graceSec: 0, clearAfterMin: 15 },
    sources: { mode: 'auto', pinned: null, blocked: ['Edge'], rename: { Chrome: 'SoundCloud' } },
    privacy: { hideList: ['Nickelback'], hiddenText: '🎵 Listening to music' },
    discord: { clientId: q.has('noid') ? '' : '1311223344556677889', appName: 'Music', perPlayer: {} },
    remote: { enabled: true, port: 47778, token: 'demo' },
    hotkeys: { toggleStatus: 'CommandOrControl+Alt+D', playPause: '', next: '', previous: '' },
    history: { enabled: true },
    app: { autostart: true, startHidden: false, closeToTray: true, compact: q.has('mini'), theme: 'auto' }
  };
  const art = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff5f6d"/><stop offset=".55" stop-color="#7b2ff7"/><stop offset="1" stop-color="#1a1446"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/><circle cx="68" cy="34" r="16" fill="#ffd166" opacity=".9"/><path d="M0 78 L28 52 L48 70 L70 46 L100 74 V100 H0Z" fill="#120d30" opacity=".85"/></svg>');
  const playing = !q.has('idle');
  const track = { id: 'smtc#0', player: 'TIDAL', app: 'TIDAL', title: 'Midnight City', artist: 'M83', album: "Hurry Up, We're Dreaming", status: 'playing', position: 95, duration: 243, artUrl: art, key: 'm83|midnight city', links: { spotify: '#', appleMusic: '#', tidal: '#', soundcloud: '#', youtubeMusic: '#' } };
  const dstatus = q.get('discord') || (config.discord.clientId ? 'ready' : 'no-client-id');
  const fill = (tpl) => tpl.replace(/\[([^[\]]*)\]/g, '$1').replace(/\{title\}/g, track.title).replace(/\{artist\}/g, track.artist).replace(/\{album\}/g, track.album).replace(/\{player\}/g, track.player).replace(/\{emoji\}/g, '🎵').replace(/\{status\}/g, 'Playing').replace(/\{position\}/g, '1:35').replace(/\{duration\}/g, '4:03');
  const activity = () => {
    const p = config.presence;
    const now = Date.now();
    const paused = track.status === 'paused';
    const labels = { source: `Open in ${track.player}`, spotify: 'Listen on Spotify', appleMusic: 'Listen on Apple Music', youtubeMusic: 'Listen on YouTube Music', tidal: 'Listen on TIDAL', soundcloud: 'Listen on SoundCloud', deezer: 'Listen on Deezer', youtube: 'Watch on YouTube' };
    return {
      type: p.activityType === 'playing' ? 0 : 2,
      status_display_type: { app: 0, artist: 1, title: 2 }[p.statusLine],
      details: fill(p.details), state: fill(p.state) || undefined,
      details_url: p.clickableText ? 'https://x' : undefined, state_url: p.clickableText ? 'https://x' : undefined,
      assets: { large_image: art, large_text: fill(p.largeText), small_image: p.icon === 'state' ? (paused ? 'paused.png' : 'playing.png') : undefined, small_text: `Playing on ${track.player}` },
      timestamps: !paused && p.timestamps !== 'none' ? { start: now - 95_000, end: p.timestamps === 'progress' ? now + 148_000 : undefined } : undefined,
      buttons: p.buttons.filter((b) => b !== 'none').map((b) => ({ label: labels[b], url: 'https://x' }))
    };
  };
  const state = () => ({
    enabled: config.statusEnabled,
    live: config.statusEnabled && dstatus === 'ready' && playing,
    activity: config.statusEnabled && playing ? activity() : null,
    testing: false, hidden: false,
    current: playing ? track : null,
    players: playing ? [{ id: 'smtc#0', player: 'TIDAL', app: 'TIDAL', title: track.title, artist: track.artist, status: track.status }, { id: 'smtc#1', player: 'SoundCloud', app: 'Chrome', title: 'Lo-fi beats to relax to', artist: 'Lofi Girl', status: 'paused' }] : [],
    pinned: config.sources.pinned,
    discord: dstatus === 'ready' ? { status: 'ready', user: { id: '1', name: 'Thijs', username: 'thierrykeoni', avatar: null } } : { status: dstatus, user: null },
    hasClientId: !!config.discord.clientId,
    media: { backend: 'Windows Media Session', error: null }
  });
  const stats = {
    todayMinutes: 74, totalMinutes: 3920, totalPlays: 812, streakDays: 9,
    last7: [32, 61, 18, 95, 44, 120, 74].map((m, i) => ({ day: new Date(Date.now() - (6 - i) * 864e5).toISOString().slice(0, 10), minutes: m })),
    topArtists: [['M83', 412], ['Daft Punk', 300], ['Tame Impala', 220], ['Kensington', 180], ['Fred again..', 150]].map(([name, minutes]) => ({ name, minutes })),
    topTracks: [['Midnight City', 'M83', 42], ['The Less I Know the Better', 'Tame Impala', 30], ['Lose Yourself to Dance', 'Daft Punk', 27]].map(([title, artist, plays]) => ({ title, artist, plays })),
    recent: [{ t: Date.now() - 2e5, title: 'Midnight City', artist: 'M83' }, { t: Date.now() - 6e5, title: 'Let It Happen', artist: 'Tame Impala' }]
  };
  const merge = (a, b) => { for (const k in b) { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k]) merge(a[k], b[k]); else a[k] = b[k]; } };
  const on = (ch) => (f) => listeners[ch].push(f);
  window.tunecord = {
    init: async () => ({ state: state(), config, logs: ['11:48:02  Connected to Discord as Thijs', '11:48:05  Discord → Midnight City · M83'], platform: 'win32', version: '1.0.0', builtinClientId: false }),
    onState: on('state'), onConfig: on('config'), onLog: on('log'),
    setConfig: async (p) => { merge(config, p); setTimeout(() => emit('state', state())); return config; },
    replaceConfig: async (path, v) => { const ks = path.split('.'); let o = config; ks.slice(0, -1).forEach((k) => { o = o[k]; }); o[ks.at(-1)] = v; setTimeout(() => emit('state', state())); return config; },
    control: async () => { track.status = track.status === 'playing' ? 'paused' : 'playing'; emit('state', state()); },
    selectPlayer: async (n) => { config.sources.pinned = n; config.sources.mode = n ? 'pinned' : 'auto'; emit('state', state()); },
    toggleStatus: async () => { config.statusEnabled = !config.statusEnabled; emit('state', state()); return config.statusEnabled; },
    preview: async (t) => { const out = {}; for (const k in t) out[k] = fill(t[k]); return { ...out, sample: true }; },
    stats: async () => stats, clearStats: async () => stats,
    qr: async () => 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21"><rect width="21" height="21" fill="#fff"/><path d="M1 1h7v7H1zM13 1h7v7h-7zM1 13h7v7H1z" fill="#111214"/><path d="M10 2h2v2h-2zM10 10h3v2h-3zM15 13h2v5h-2zM12 15h2v4h-2z" fill="#111214"/></svg>'),
    discordTest: async () => ({ ok: true }), discordReconnect: async () => ({}),
    remoteInfo: async () => ({ enabled: config.remote.enabled, running: true, url: 'http://192.168.1.23:47778/?t=demo' }),
    remoteRegen: async () => ({}),
    openUrl: async () => {}, copy: async () => {}, setCompact: async (v) => { config.app.compact = v; emit('config', config); }, openLogs: async () => {}, quit: async () => {}
  };
})();
