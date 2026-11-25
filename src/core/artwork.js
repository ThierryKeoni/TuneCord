'use strict';
// Finds an https album cover for Discord (it can only show images from the web).
// Windows players hand over the cover as raw image data, so we look the song up
// on Deezer and iTunes (both free, no key) and only accept a result that really
// matches: same artist, same title, and the same album/length when we know them.

const cache = new Map();
const MAX = 400;
const MIN_SCORE = 6;

const VERSION_WORDS = /\b(karaoke|tribute|instrumental|cover|made famous|in the style of|originally performed|8[- ]?bit|lullaby|piano version|acapella|a cappella|sped up|slowed|nightcore)\b/i;

/** Lowercase, no accents, no "(feat. …)", "[Remastered]", "- 2011 Remaster" etc. */
function norm(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s*[([{][^)\]}]*[)\]}]/g, ' ')                  // (feat. x) [Live] {…}
    .replace(/\s+-\s+.*\b(remaster(ed)?|version|edit|mix|live|mono|stereo|deluxe)\b.*$/, ' ')
    .replace(/\b(feat|ft|featuring)\.?\s.*$/, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** "A, B & C feat. D" → ["a", "b", "c", "d"] */
function artistsOf(s) {
  return String(s || '')
    .split(/\s*(?:,|&|\band\b|\bx\b|\bfeat\.?|\bft\.?|\bfeaturing|\bwith\b|;|\/)\s*/i)
    .map(norm)
    .filter(Boolean);
}

function textScore(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 3;
  if (a.startsWith(b) || b.startsWith(a)) return 2;
  if (a.includes(b) || b.includes(a)) return 1;
  return 0;
}

/** How well does a search result match the song that's playing? 0 = reject. */
function scoreCandidate(track, c) {
  const wantTitle = norm(track.title);
  const wantArtists = artistsOf(track.artist);
  const title = textScore(norm(c.title), wantTitle);
  if (!title) return 0;

  let artist = 0;
  if (wantArtists.length) {
    const have = artistsOf(c.artist);
    const full = norm(c.artist) === norm(track.artist);
    const overlap = wantArtists.filter((w) => have.some((h) => h === w || h.includes(w) || w.includes(h))).length;
    artist = full ? 4 : overlap === wantArtists.length ? 3 : overlap ? 2 : 0;
    if (!artist) return 0;
  }

  let score = title + artist;
  if (track.album && c.album) {
    const a = textScore(norm(c.album), norm(track.album));
    score += a === 3 ? 3 : a ? 1 : -1;
  }
  if (track.duration > 0 && c.duration > 0) {
    const d = Math.abs(track.duration - c.duration);
    score += d <= 3 ? 2 : d <= 10 ? 1 : d > 30 ? -3 : 0;
  }
  const rawText = `${c.title} ${c.album || ''} ${c.artist}`;
  if (VERSION_WORDS.test(rawText) && !VERSION_WORDS.test(`${track.title} ${track.album || ''}`)) score -= 5;
  if (/\b(live|remix)\b/i.test(c.title) && !/\b(live|remix)\b/i.test(track.title)) score -= 2;
  return score;
}

async function getJson(url, ms = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    return res.ok ? await res.json() : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function searchDeezer(track) {
  const clean = (s) => String(s || '').replace(/"/g, '');
  const firstArtist = String(track.artist || '').split(/\s*(?:,|&|feat\.?|ft\.?)\s*/i)[0];
  const q = track.artist
    ? `artist:"${clean(firstArtist)}" track:"${clean(track.title)}"`
    : clean(track.title);
  const json = await getJson(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=15`);
  return ((json && json.data) || []).map((r) => ({
    source: 'deezer',
    title: r.title,
    artist: r.artist && r.artist.name,
    album: r.album && r.album.title,
    duration: r.duration || 0,
    art: (r.album && (r.album.cover_xl || r.album.cover_big)) || null
  }));
}

async function searchItunes(track) {
  const term = encodeURIComponent([track.artist, track.title].filter(Boolean).join(' '));
  const json = await getJson(`https://itunes.apple.com/search?term=${term}&entity=song&limit=20`);
  return ((json && json.results) || []).map((r) => ({
    source: 'itunes',
    title: r.trackName,
    artist: r.artistName,
    album: r.collectionName,
    duration: r.trackTimeMillis ? r.trackTimeMillis / 1000 : 0,
    art: r.artworkUrl100 ? r.artworkUrl100.replace('100x100bb', '600x600bb') : null
  }));
}

/** Pick the best matching result, or null when nothing is a convincing match. */
function pickBest(track, candidates) {
  let best = null;
  for (const c of candidates) {
    if (!c.art) continue;
    const s = scoreCandidate(track, c) + (c.source === 'deezer' ? 0.1 : 0); // tie → Deezer (bigger covers)
    if (s >= MIN_SCORE && (!best || s > best.score)) best = { ...c, score: s };
  }
  return best;
}

/** Returns { art, duration, album } or null. Never guesses: no good match = no cover. */
async function lookupTrack(track, { search = [searchDeezer, searchItunes] } = {}) {
  if (!track || !track.title) return null;
  const key = `${track.artist}|${track.title}|${track.album || ''}`.toLowerCase();
  if (cache.has(key)) return cache.get(key);
  const pending = (async () => {
    let best = null;
    for (const fn of search) {
      const found = pickBest(track, await fn(track));
      if (found && (!best || found.score > best.score)) best = found;
      if (best && best.score >= 10) break; // artist+title+album/length all match, good enough
    }
    const out = best ? { art: best.art, duration: best.duration || null, album: best.album || null, source: best.source } : null;
    cache.set(key, out);
    if (cache.size > MAX) cache.delete(cache.keys().next().value);
    return out;
  })();
  cache.set(key, pending);
  return pending;
}

async function lookupArtwork(track) {
  const r = await lookupTrack(track);
  return r ? r.art : null;
}

module.exports = { lookupArtwork, lookupTrack, scoreCandidate, pickBest, norm, artistsOf };
