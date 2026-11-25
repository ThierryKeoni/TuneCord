'use strict';

/** Pick the media backend for this OS. Every backend emits 'players' with the same track shape. */
function createMediaSource(platform = process.platform) {
  if (platform === 'win32') return new (require('./windows-smtc').SmtcSource)();
  if (platform === 'darwin') return new (require('./macos').MacSource)();
  return new (require('./linux-mpris').MprisSource)();
}

module.exports = { createMediaSource };
