const { app, BrowserWindow, Menu, ipcMain } = require('electron')
const path = require('path')
const handlers = require('./ipc-handlers')

app.commandLine.appendSwitch('disable-features', 'AutomationControlled')
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')

const isDev = process.argv.includes('--dev')
const homeURL = isDev
  ? process.env.npm_package_config_targetURL || 'http://localhost:15000/'
  : process.env.npm_package_config_prodURL || 'https://shangou.muchen.store'

let mainWindow = null

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'shell-preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false
    }
  })

  handlers.setMainWindow(mainWindow, homeURL)
  mainWindow.loadFile(path.join(__dirname, 'shell.html'))

  mainWindow.webContents.on('did-finish-load', () => {
    handlers.createHomeView()
  })
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  handlers.register(ipcMain)
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
