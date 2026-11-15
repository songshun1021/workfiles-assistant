'use strict';
// Sandboxed preload: Electron's small built-in require is sufficient. No file,
// shell, URL, auth, arbitrary IPC or Electron objects cross this bridge.
const { contextBridge, ipcRenderer } = require('electron');
const prefix = 'workfiles-voice:';
contextBridge.exposeInMainWorld('workfilesVoice', Object.freeze({
  onState(callback) {
    if (typeof callback !== 'function') throw new TypeError('onState requires a callback');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on(`${prefix}state`, listener);
    let listening = true;
    return () => { if (listening) { listening = false; ipcRenderer.removeListener(`${prefix}state`, listener); } };
  },
  ready: () => ipcRenderer.invoke(`${prefix}ready`),
  audio: payload => ipcRenderer.invoke(`${prefix}audio`, payload),
  text: payload => ipcRenderer.invoke(`${prefix}text`, payload),
  action: payload => ipcRenderer.invoke(`${prefix}action`, payload),
  capture: payload => ipcRenderer.invoke(`${prefix}capture`, payload),
  // Writes one bounded, already-displayed string. There is no read side and no path access.
  clipboard: payload => ipcRenderer.invoke(`${prefix}clipboard`, payload),
}));
