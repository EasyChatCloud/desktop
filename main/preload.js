const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  switch: (sessionId, url) => ipcRenderer.invoke('switch', sessionId, url),

  rename: (oldName, newName) => ipcRenderer.invoke('setSession', oldName, newName),

  stop: (event, sessionId) => ipcRenderer.invoke('stop', event, sessionId),

  push: (event, callback) => {
    ipcRenderer.on(`push:${event}`, (_, data) => callback(data))
  }
})
