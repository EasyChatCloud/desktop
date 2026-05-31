const { app, BrowserWindow, Menu, ipcMain } = require('electron')
const path = require('path')
const handlers = require('./ipc-handlers')
const updater = require('./updater')
const capture = require('./capture')

app.commandLine.appendSwitch('disable-features', 'AutomationControlled')
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')

const isDev = process.argv.includes('--dev')
const homeURL = isDev
  ? process.env.npm_package_config_targetURL || 'http://localhost:15000/'
  : process.env.npm_package_config_prodURL || 'https://shangou.muchen.store'

let mainWindow = null

function createMainWindow() {
  mainWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'shell-preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false
    }
  })

  handlers.setMainWindow(mainWindow, homeURL)
  capture.setRefs({ mainWindow })
  mainWindow.maximize()
  mainWindow.loadFile(path.join(__dirname, 'shell.html'))

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.on('did-finish-load', () => {
    handlers.createHomeView()
  })
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  handlers.register(ipcMain)
  createMainWindow()

  // Auto-update
  updater.setMainWindow(mainWindow)
  updater.init()

  // Update IPC handlers
  ipcMain.handle('update:check', () => updater.checkForUpdates())
  ipcMain.handle('update:download', () => updater.downloadUpdate())
  ipcMain.handle('update:install', () => updater.quitAndInstall())

  // Capture (packet capture / 抓包) IPC handlers
  ipcMain.handle('capture:start', async (_, urls) => capture.startCapture(urls))
  ipcMain.handle('capture:stop', async () => capture.stopCapture())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('before-quit', () => {
  capture.destroy()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
