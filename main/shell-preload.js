const { ipcRenderer } = require('electron')

window.shellAPI = {
  onTabsUpdate: (cb) => {
    ipcRenderer.on('shell:tabs', (_, data) => cb(data))
  },

  switchTab: (id) => ipcRenderer.send('shell:switch-tab', id),
  closeTab: (id) => ipcRenderer.send('shell:close-tab', id),
  newTab: () => ipcRenderer.send('shell:new-tab'),
  focusPopup: (id) => ipcRenderer.send('shell:focus-popup', id),
  minimize: () => ipcRenderer.send('shell:minimize'),
  maximize: () => ipcRenderer.send('shell:maximize'),
  close: () => ipcRenderer.send('shell:close')
}
