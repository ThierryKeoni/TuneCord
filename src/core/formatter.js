'use strict';

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function tokenValues(track, position) {
  const dur = track.duration || 0;
  const pos = position ?? track.position ?? 0;
  return {
    title: track.title || '',
    artist: track.artist || '',
    album: track.album || '',
    player: track.player || '',
    emoji: track.status === 'paused' ? '⏸' : '🎵',
    status: track.status === 'paused' ? 'Paused' : 'Playing',
    position: dur ? fmtTime(pos) : '',
    duration: dur ? fmtTime(dur) : ''
  };
}

const TOKEN_RE = /\{(\w+)\}/g;

/**
 * Render a template.
 * "[ ... ]" sections disappear when any token inside them is empty,
 * so "{title}[ — {artist}]" never ends in a dangling dash.
 */
function render(template, track, position) {
  if (!template || !track) return '';
  const vals = tokenValues(track, position);
  const get = (k) => (k in vals ? String(vals[k]) : `{${k}}`);

  let out = template.replace(/\[([^[\]]*)\]/g, (_, inner) => {
    let ok = true;
    const r = inner.replace(TOKEN_RE, (_m, k) => {
      const v = get(k);
      if (!v) ok = false;
      return v;
    });
    return ok ? r : '';
  });
  out = out.replace(TOKEN_RE, (_m, k) => get(k));
  return out.replace(/\s+/g, ' ').trim();
}

/** Truncate by code points so emoji never get cut in half. */
function truncate(text, max) {
  const chars = Array.from(text || '');
  if (chars.length <= max) return chars.join('');
  return chars.slice(0, Math.max(1, max - 1)).join('').trimEnd() + '…';
}

/** Discord wants 2–128 characters for details/state/image text. */
function discordText(text, max = 128) {
  let t = truncate(String(text || '').trim(), max);
  if (!t) return undefined;
  // pad 1-character strings with an invisible character
  if (Array.from(t).length < 2) t += '⠀';
  // Discord counts UTF-16 units; stay safe with long emoji strings
  while (t.length > max) t = Array.from(t).slice(0, -2).join('') + '…';
  return t;
}

function isHidden(track, hideList) {
  if (!track || !hideList || !hideList.length) return false;
  const hay = `${track.title}\n${track.artist}\n${track.album}`.toLowerCase();
  return hideList.some((w) => w && hay.includes(String(w).toLowerCase().trim()));
}

/** Work out the streaming service from a track/page URL (Linux browsers report it). */
const SERVICES = [
  [/(^|\.)open\.spotify\.com$/, 'Spotify'],
  [/(^|\.)music\.apple\.com$/, 'Apple Music'],
  [/(^|\.)(listen\.)?tidal\.com$/, 'TIDAL'],
  [/(^|\.)soundcloud\.com$/, 'SoundCloud'],
  [/(^|\.)music\.youtube\.com$/, 'YouTube Music'],
  [/(^|\.)deezer\.com$/, 'Deezer'],
  [/(^|\.)music\.amazon\.[a-z.]+$/, 'Amazon Music'],
  [/(^|\.)bandcamp\.com$/, 'Bandcamp'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'YouTube']
];

function serviceFromUrl(url) {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const [re, name] of SERVICES) if (re.test(host)) return name;
  } catch (_) { /* not a URL */ }
  return null;
}

const SEARCH = {
  spotify: (q) => `https://open.spotify.com/search/${q}`,
  appleMusic: (q) => `https://music.apple.com/search?term=${q}`,
  youtubeMusic: (q) => `https://music.youtube.com/search?q=${q}`,
  tidal: (q) => `https://tidal.com/search?q=${q}`,
  soundcloud: (q) => `https://soundcloud.com/search?q=${q}`,
  deezer: (q) => `https://www.deezer.com/search/${q}`,
  youtube: (q) => `https://www.youtube.com/results?search_query=${q}`
};

const SERVICE_KEY = {
  Spotify: 'spotify',
  'Apple Music': 'appleMusic',
  'YouTube Music': 'youtubeMusic',
  TIDAL: 'tidal',
  SoundCloud: 'soundcloud',
  Deezer: 'deezer',
  YouTube: 'youtube'
};

const SERVICE_LABEL = {
  spotify: 'Spotify',
  appleMusic: 'Apple Music',
  youtubeMusic: 'YouTube Music',
  tidal: 'TIDAL',
  soundcloud: 'SoundCloud',
  deezer: 'Deezer',
  youtube: 'YouTube'
};

function shareLinks(track) {
  if (!track) return {};
  const q = encodeURIComponent([track.title, track.artist].filter(Boolean).join(' '));
  const links = {};
  for (const [k, fn] of Object.entries(SEARCH)) links[k] = fn(q);
  if (track.artist) links.artist = SEARCH[SERVICE_KEY[track.player] || 'spotify'](encodeURIComponent(track.artist));
  if (track.url && /^https:\/\//.test(track.url)) {
    links.direct = track.url;
    const k = SERVICE_KEY[serviceFromUrl(track.url)];
    if (k) links[k] = track.url;
  }
  // "source" = open it where you're actually listening
  const own = SERVICE_KEY[track.player];
  links.source = links.direct || (own ? links[own] : links.spotify);
  links.sourceLabel = own ? SERVICE_LABEL[own] : (links.direct ? track.player : 'Spotify');
  return links;
}

module.exports = {
  render, truncate, discordText, fmtTime, isHidden, shareLinks, tokenValues,
  serviceFromUrl, SERVICE_KEY, SERVICE_LABEL
};
