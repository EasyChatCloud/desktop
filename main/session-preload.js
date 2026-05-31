// Anti-detection preload — runs before any page script
// contextIsolation: false, nodeIntegration: false

const { ipcRenderer } = require('electron')

// Expose electronAPI for popup windows on anti-detection domains
// (contextIsolation: false allows direct window assignment)
window.electronAPI = {
  switch: (sessionId, url, opts) =>
    ipcRenderer.invoke('switch', sessionId, url, opts || {}),
  rename: (oldName, newName) =>
    ipcRenderer.invoke('setSession', oldName, newName),
  stop: (event, sessionId) =>
    ipcRenderer.invoke('stop', event, sessionId),
  closePopup: (sessionId) =>
    ipcRenderer.invoke('closePopup', sessionId),
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
}

function patch() {
  // Strategy 1: Try to override prototype
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: () => undefined,
      configurable: true
    })
  } catch (_) {}

  // Strategy 2: Try to override instance
  try {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true
    })
  } catch (_) {}

  // Strategy 3: __defineGetter__ fallback
  try {
    Navigator.prototype.__defineGetter__('webdriver', () => undefined)
  } catch (_) {}
  try {
    navigator.__defineGetter__('webdriver', () => undefined)
  } catch (_) {}

  // Strategy 4: Proxy navigator via window override
  try {
    const realNav = navigator
    const proxy = new Proxy(realNav, {
      get(target, prop) {
        if (prop === 'webdriver') return undefined
        return target[prop]
      }
    })
    Object.defineProperty(window, 'navigator', {
      get: () => proxy,
      configurable: true
    })
  } catch (_) {}

  // Plugins
  try {
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = [1, 2, 3, 4, 5]
        arr.item = () => null
        arr.namedItem = () => null
        arr.refresh = () => {}
        return arr
      },
      configurable: true
    })
  } catch (_) {}

  // Languages
  try {
    Object.defineProperty(navigator, 'languages', {
      get: () => ['zh-CN', 'zh', 'en'],
      configurable: true
    })
  } catch (_) {}

  // Chrome object
  try { window.chrome = { runtime: {} } } catch (_) {}

  // Clean automation globals
  const trash = ['__nightmare', '__phantom', 'callPhantom', '_phantom',
    '__selenium_unwrapped', '__webdriver_evaluate', '__driver_evaluate',
    '__webdriver_script_function', '__driver_unwrapped', '__webdriver_unwrapped',
    '__selenium_evaluate', 'domAutomation', 'domAutomationController']
  for (const k of trash) {
    try { delete window[k] } catch (_) {}
  }
}

patch()
