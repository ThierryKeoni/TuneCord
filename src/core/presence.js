'use strict';
// Turns "what's playing" + settings into a Discord activity object.
const { render, discordText, shareLinks, SERVICE_LABEL } = require('./formatter');
const { ICON_BASE_URL } = require('./app-id');

const TYPE = { playing: 0, listening: 2 };
const STATUS_DISPLAY = { app: 0, artist: 1, title: 2 }; // 0 = app name, 1 = state, 2 = details

function httpsUrl(u, max = 256) {
  return typeof u === 'string' && /^https:\/\//.test(u) && u.length <= max ? u : undefined;
}

function buttonFor(kind, links, track) {
  if (!kind || kind === 'none') return null;
  let url; let label;
  if (kind === 'source') {
    url = links.source;
    label = `Open in ${links.sourceLabel || track.player || 'player'}`;
  } else {
    url = links[kind];
    label = `${kind === 'youtube' ? 'Watch' : 'Listen'} on ${SERVICE_LABEL[kind] || kind}`;
  }
  if (!httpsUrl(url, 512)) return null;
  return { label: Array.from(label).slice(0, 32).join(''), url };
}

/**
 * @param {object} o
 * @param {object} o.track      current track (normalized player object)
 * @param {number} o.position   current position in seconds
 * @param {object} o.cfg        full config
 * @param {number} o.now        ms timestamp
 * @param {string} [o.art]      https album-art URL for Discord
 * @param {boolean} [o.paused]  render as paused
 * @param {boolean} [o.hidden]  privacy filter hit
 * @param {number} [o.start]    stable start timestamp (ms) to avoid jitter
 */
function buildActivity({ track, position = 0, cfg, now, art, paused = false, hidden = false, start }) {
  const p = cfg.presence;
  const links = shareLinks(track);
  const activity = {
    type: TYPE[p.activityType] ?? 2,
    status_display_type: STATUS_DISPLAY[p.statusLine] ?? 1,
    instance: false
  };

  if (hidden) {
    activity.details = discordText(cfg.privacy.hiddenText || '🎵 Listening to music');
    activity.status_display_type = 0;
    activity.assets = { large_image: ICON_BASE_URL + 'logo.png', large_text: discordText('Something secret 🤫') };
    return activity;
  }

  activity.details = discordText(render(p.details, track, position));
  activity.state = discordText(render(p.state, track, position));
  if (!activity.details) activity.details = discordText(track.title) || 'Music';
  if (!activity.state) delete activity.state;
  if (activity.status_display_type === 1 && !activity.state) activity.status_display_type = 2;

  if (p.clickableText) {
    const d = httpsUrl(links.source, 256);
    const s = httpsUrl(links.artist, 256);
    if (d) activity.details_url = d;
    if (s && activity.state) activity.state_url = s;
  }

  const assets = {};
  assets.large_image = httpsUrl(art) || ICON_BASE_URL + 'logo.png';
  const lt = discordText(render(p.largeText, track, position));
  if (lt) assets.large_text = lt;
  if (httpsUrl(links.source)) assets.large_url = links.source;
  if (p.icon === 'state') {
    assets.small_image = ICON_BASE_URL + (paused ? 'paused.png' : 'playing.png');
    assets.small_text = discordText(`${paused ? 'Paused' : 'Playing'} on ${track.player || 'music'}`);
  }
  activity.assets = assets;

  if (!paused && track.status === 'playing' && p.timestamps !== 'none') {
    const s = start ?? Math.round(now - position * 1000);
    activity.timestamps = { start: s };
    if (p.timestamps === 'progress' && track.duration > 0) activity.timestamps.end = s + Math.round(track.duration * 1000);
  }

  const buttons = p.buttons.map((k) => buttonFor(k, links, track)).filter(Boolean);
  const seen = new Set();
  const unique = buttons.filter((b) => (seen.has(b.url) ? false : seen.add(b.url)));
  if (unique.length) activity.buttons = unique.slice(0, 2);

  return activity;
}

module.exports = { buildActivity, TYPE, STATUS_DISPLAY };
