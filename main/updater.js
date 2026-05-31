const { autoUpdater } = require('electron-updater')
const { app } = require('electron')
const path = require('path')
const fs = require('fs')

let mainWindow = null
let updateCheckTimer = null
let enabled = true

// Read update URL from package.json config
function getUpdateConfig() {
  try {
    const pkgPath = path.join(app.getAppPath(), 'package.json')
    // In development, app.getAppPath() returns the project root
    // In production (packaged), returns the app.asar path
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    const updateURL = (pkg.config && pkg.config.updateURL) || ''
    return { updateURL }
  } catch (_) {
    return { updateURL: '' }
  }
}

function isDev() {
  return !app.isPackaged
}

// Configure autoUpdater
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true
autoUpdater.logger = {
  info: (...args) => console.log('[updater]', ...args),
  warn: (...args) => console.warn('[updater]', ...args),
  error: (...args) => console.error('[updater]', ...args),
  debug: () => {}
}

function setMainWindow(win) {
  mainWindow = win
}

function sendStatus(status, data = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:status', { status, ...data })
  }
}

function checkForUpdates() {
  if (!enabled) return
  autoUpdater.checkForUpdates().catch(err => {
    console.log('[updater] check failed:', err.message)
  })
}

function downloadUpdate() {
  autoUpdater.downloadUpdate().catch(err => {
    console.log('[updater] download failed:', err.message)
  })
}

function quitAndInstall() {
  autoUpdater.quitAndInstall()
}

function init() {
  const { updateURL } = getUpdateConfig()

  if (isDev()) {
    console.log('[updater] disabled in dev mode')
    enabled = false
    return
  }

  if (updateURL) {
    // Override publish provider with config URL (supports dynamic server)
    autoUpdater.setFeedURL({ provider: 'generic', url: updateURL })
    console.log('[updater] feed URL:', updateURL)
  }

  // Check for updates 5 seconds after app is ready
  updateCheckTimer = setTimeout(() => {
    checkForUpdates()
  }, 5000)

  // --- autoUpdater events ---

  autoUpdater.on('checking-for-update', () => {
    sendStatus('checking-for-update')
  })

  autoUpdater.on('update-available', (info) => {
    sendStatus('update-available', { version: info.version })
  })

  autoUpdater.on('update-not-available', () => {
    sendStatus('update-not-available')
  })

  autoUpdater.on('download-progress', (progress) => {
    sendStatus('download-progress', {
      percent: Math.round(progress.percent)
    })
  })

  autoUpdater.on('update-downloaded', () => {
    sendStatus('update-downloaded')
  })

  autoUpdater.on('error', (err) => {
    sendStatus('error', { message: err ? err.message : 'unknown error' })
  })
}

function destroy() {
  if (updateCheckTimer) {
    clearTimeout(updateCheckTimer)
    updateCheckTimer = null
  }
  autoUpdater.removeAllListeners()
}

module.exports = { init, setMainWindow, checkForUpdates, downloadUpdate, quitAndInstall, destroy }
