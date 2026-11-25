'use strict';
// Finds an https album-art URL for players that don't give one (Discord can only
// show images from the web). Uses the public iTunes Search API, no key needed.

const cache = new Map();
const MAX = 300;

/** Returns { art, duration } from iTunes (either may be null). */
async function lookupTrack(track) {
  if (!track || !track.title) return null;
  const key = `${track.artist}|${track.title}`.toLowerCase();
  if (cache.has(key)) return cache.get(key);
  cache.set(key, null); // prevent duplicate in-flight lookups
  if (cache.size > MAX) cache.delete(cache.keys().next().value);

  try {
    const term = encodeURIComponent([track.artist, track.title].filter(Boolean).join(' '));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`https://itunes.apple.com/search?term=${term}&entity=song&limit=1`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    const hit = json.results && json.results[0];
    if (!hit) return null;
    const out = {
      art: hit.artworkUrl100 ? hit.artworkUrl100.replace('100x100bb', '600x600bb') : null,
      duration: hit.trackTimeMillis ? hit.trackTimeMillis / 1000 : null,
      album: hit.collectionName || null
    };
    cache.set(key, out);
    return out;
  } catch (_) {
    return null;
  }
}

async function lookupArtwork(track) {
  const r = await lookupTrack(track);
  return r ? r.art : null;
}

module.exports = { lookupArtwork, lookupTrack };
