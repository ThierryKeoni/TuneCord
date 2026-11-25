'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, ...args) => ipcRenderer.invoke(ch, ...args);
const on = (ch) => (fn) => {
  const handler = (_e, payload) => fn(payload);
  ipcRenderer.on(ch, handler);
  return () => ipcRenderer.removeListener(ch, handler);
};

contextBridge.exposeInMainWorld('tunecord', {
  init: () => invoke('init'),
  onState: on('state'),
  onConfig: on('config'),
  onLog: on('log'),
  setConfig: (patch) => invoke('config:set', patch),
  replaceConfig: (path, value) => invoke('config:replace', path, value),
  control: (action, arg) => invoke('control', action, arg),
  selectPlayer: (name) => invoke('player:select', name),
  toggleStatus: (force) => invoke('status:toggle', force),
  preview: (templates) => invoke('preview', templates),
  stats: () => invoke('stats:get'),
  clearStats: () => invoke('stats:clear'),
  qr: (text) => invoke('qr:make', text),
  discordTest: () => invoke('discord:test'),
  discordReconnect: () => invoke('discord:reconnect'),
  remoteInfo: () => invoke('remote:info'),
  remoteRegen: () => invoke('remote:regen'),
  openUrl: (url) => invoke('open:url', url),
  copy: (text) => invoke('copy', text),
  setCompact: (on) => invoke('window:compact', on),
  openLogs: () => invoke('logs:open'),
  quit: () => invoke('app:quit')
});
