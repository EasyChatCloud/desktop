const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  switch: (sessionId, url, opts = {}) =>
    ipcRenderer.invoke('switch', sessionId, url, opts),

  rename: (oldName, newName) => ipcRenderer.invoke('setSession', oldName, newName),

  stop: (event, sessionId) => ipcRenderer.invoke('stop', event, sessionId),

  closePopup: (sessionId) => ipcRenderer.invoke('closePopup', sessionId),

  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),

  onUpdateStatus: (callback) => {
    ipcRenderer.on('update:status', (_, data) => callback(data))
  },

  capture: {
    start: (urls) => ipcRenderer.invoke('capture:start', urls || []),
    stop: () => ipcRenderer.invoke('capture:stop'),
    push: (type, callback) => {
      ipcRenderer.on(`capture:push:${type}`, (_, data) => callback(data))
    }
  },

  push: (event, callback) => {
    ipcRenderer.on(`push:${event}`, (_, data) => callback(data))
  }
})
