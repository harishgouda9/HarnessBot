const { contextBridge, ipcRenderer } = require('electron');

/**
 * The entire renderer-to-main surface. Deliberately tiny: no fs, no child_process,
 * and no credential surface at all. The renderer renders untrusted model output,
 * so anything exposed here is exposed to that output too.
 */
contextBridge.exposeInMainWorld('hb', {
  platform: process.platform,
  setBadge: (count) => ipcRenderer.invoke('hb:setBadge', count),
  notify: (notice) => ipcRenderer.invoke('hb:notify', notice),
  onOpenThread: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('hb:open-thread', listener);
    return () => ipcRenderer.removeListener('hb:open-thread', listener);
  },
  getPresence: () => ipcRenderer.invoke('hb:presence-get'),
  setPresence: (patch) => ipcRenderer.invoke('hb:presence-set', patch),
});
