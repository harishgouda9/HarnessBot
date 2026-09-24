const { contextBridge, ipcRenderer } = require('electron');

/**
 * The entire renderer-to-main surface. Deliberately tiny: no fs, no child_process,
 * and no credential surface at all. The renderer renders untrusted model output,
 * so anything exposed here is exposed to that output too.
 */
contextBridge.exposeInMainWorld('hb', {
  setBadge: (count) => ipcRenderer.invoke('hb:setBadge', count),
});
