'use strict';
/**
 * The Discord application TuneCord shows up as ("Listening to <name>").
 *
 * Developer: create one at https://discord.com/developers/applications
 * (New Application → name it e.g. "Music"), copy the Application ID and paste
 * it below before building a release. Then nobody who downloads TuneCord has
 * to make their own. Users can still override it in Settings.
 */
const BUILTIN_CLIENT_ID = '1575102298840109157';

/** Where the small play/pause icons in the presence are loaded from (raw files in your GitHub repo). */
const ICON_BASE_URL = 'https://raw.githubusercontent.com/ThierryKeoni/TuneCord/main/assets/presence/';

module.exports = { BUILTIN_CLIENT_ID, ICON_BASE_URL };
