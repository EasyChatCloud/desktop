const { BrowserWindow, BrowserView, Menu, session } = require('electron')
const path = require('path')
const sessions = require('./sessions')

const HOME_TAB_ID = '__home__'
const TAB_BAR_HEIGHT = 38

const tabViews = new Map()
const cookieWatchers = new Map()
const sentSnapshots = new Map()
const tabOrder = []
let activeTabId = null
let mainWindow = null
let homeUrl = ''

// Map user-facing sessionId → stable internal partitionId
function sessionPartition(sessionId) {
  return session.fromPartition(`persist:${sessions.getPartitionId(sessionId)}`)
}

function setMainWindow(win, url) {
  mainWindow = win
  homeUrl = url

  mainWindow.on('resize', () => {
    resizeActiveView()
  })

  mainWindow.webContents.on('before-input-event', (_, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      if (activeTabId) {
        const data = tabViews.get(activeTabId)
        if (data) data.view.webContents.toggleDevTools()
      }
    }
  })
}

function buildSnapshot(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`).sort().join('|')
}

function extractDomain(url) {
  try { return new URL(url).hostname } catch (_) { return '' }
}

// ---- Cookie helpers ----

async function pushCookies(sessionId) {
  const ses = sessionPartition(sessionId)
  try {
    const cookies = await ses.cookies.get({})
    const snapshot = buildSnapshot(cookies)
    if (sentSnapshots.get(sessionId) === snapshot) return
    sentSnapshots.set(sessionId, snapshot)
    const homeData = tabViews.get(HOME_TAB_ID)
    if (homeData && homeData.view) {
      homeData.view.webContents.send('push:cookie', { sessionId, cookies })
    }
  } catch (_) {}
}

function watchCookies(sessionId) {
  if (cookieWatchers.has(sessionId)) return
  const handler = () => pushCookies(sessionId)
  cookieWatchers.set(sessionId, handler)
  const ses = sessionPartition(sessionId)
  ses.cookies.on('changed', handler)
}

function stopWatching(sessionId) {
  const handler = cookieWatchers.get(sessionId)
  if (!handler) return
  const ses = sessionPartition(sessionId)
  ses.cookies.removeListener('changed', handler)
  cookieWatchers.delete(sessionId)
  sentSnapshots.delete(sessionId)
}

// ---- WebPreferences ----

function getWebPreferences(ses, domain) {
  const base = { session: ses, nodeIntegration: false }
  const antiDetectionDomains = ['koubei.com', 'e.koubei.com', 'ele.me']
  const needsAntiDetection = antiDetectionDomains.some(d => domain.includes(d))

  if (needsAntiDetection) {
    return {
      ...base,
      preload: path.join(__dirname, 'session-preload.js'),
      contextIsolation: false,
      sandbox: false
    }
  }

  return { ...base, contextIsolation: true, sandbox: true }
}

function getHomeWebPreferences(ses) {
  return {
    session: ses,
    preload: path.join(__dirname, 'preload.js'),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true
  }
}

// ---- View management ----

function updateViewBounds(view) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const [width, height] = mainWindow.getContentSize()
  view.setBounds({ x: 0, y: TAB_BAR_HEIGHT, width, height: Math.max(0, height - TAB_BAR_HEIGHT) })
}

function resizeActiveView() {
  const data = activeTabId ? tabViews.get(activeTabId) : null
  if (data) updateViewBounds(data.view)
}

function showView(tabId) {
  for (const [id, data] of tabViews) {
    if (id === tabId) {
      updateViewBounds(data.view)
    } else {
      data.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    }
  }
}

function setupViewEvents(view, tabId) {
  view.webContents.on('context-menu', () => {
    const data = tabViews.get(tabId)
    if (!data) return
    const menu = Menu.buildFromTemplate([
      {
        label: '主页',
        click: () => view.webContents.loadURL(data.originalUrl)
      },
      { label: '刷新', click: () => view.webContents.reload() }
    ])
    menu.popup()
  })

  view.webContents.on('before-input-event', (_, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      view.webContents.toggleDevTools()
    }
  })

  if (tabId !== HOME_TAB_ID) {
    view.webContents.on('did-navigate', (_, navUrl) => {
      mainWindow.webContents.send('shell:tab-title', { id: tabId, title: extractDomain(navUrl) || navUrl })
    })
    view.webContents.on('page-title-updated', (_, title) => {
      mainWindow.webContents.send('shell:tab-title', { id: tabId, title })
    })
  }
}

function setupSessionSpecific(view, sessionId, ses, domain) {
  ses.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  )

  view.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      parent: null,
      webPreferences: getWebPreferences(ses, domain)
    }
  }))

  watchCookies(sessionId)

  view.webContents.on('did-finish-load', () => {
    pushCookies(sessionId)
  })
}

// ---- Tab operations ----

function broadcastTabs() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const tabs = tabOrder.map(id => {
    const data = tabViews.get(id)
    if (!data) return null
    return {
      id,
      title: data.type === 'home' ? '主页' : (data.sessionId || extractDomain(data.url)),
      type: data.type,
      sessionId: data.sessionId
    }
  }).filter(Boolean)

  mainWindow.webContents.send('shell:tabs', { tabs, activeId: activeTabId })
}

async function createHomeView() {
  const ses = session.defaultSession
  const webPreferences = getHomeWebPreferences(ses)
  const view = new BrowserView({ webPreferences })

  mainWindow.addBrowserView(view)
  setupViewEvents(view, HOME_TAB_ID)

  view.webContents.loadURL(homeUrl)

  tabViews.set(HOME_TAB_ID, { view, type: 'home', url: homeUrl, originalUrl: homeUrl })
  tabOrder.push(HOME_TAB_ID)
  activeTabId = HOME_TAB_ID
  updateViewBounds(view)
  broadcastTabs()

  return view
}

async function createSessionView(sessionId, url) {
  const ses = sessionPartition(sessionId)
  const domain = extractDomain(url)
  const webPreferences = getWebPreferences(ses, domain)

  const view = new BrowserView({ webPreferences })

  mainWindow.addBrowserView(view)
  setupViewEvents(view, sessionId)
  setupSessionSpecific(view, sessionId, ses, domain)

  view.webContents.loadURL(url)

  tabViews.set(sessionId, { view, type: 'session', sessionId, url, originalUrl: url })
  tabOrder.push(sessionId)
  activeTabId = sessionId
  showView(sessionId)
  broadcastTabs()

  return view
}

function closeTab(tabId) {
  if (tabId === HOME_TAB_ID) return

  const data = tabViews.get(tabId)
  if (!data) return

  try { mainWindow.removeBrowserView(data.view) } catch (_) {}

  if (data.sessionId) {
    stopWatching(data.sessionId)
  }

  tabViews.delete(tabId)
  const idx = tabOrder.indexOf(tabId)
  if (idx !== -1) tabOrder.splice(idx, 1)

  if (activeTabId === tabId) {
    const newActive = tabOrder[Math.min(idx, tabOrder.length - 1)]
    if (newActive) {
      activeTabId = newActive
      showView(newActive)
    }
  }

  broadcastTabs()
}

function switchTab(tabId) {
  if (!tabViews.has(tabId)) return
  activeTabId = tabId

  if (tabId !== HOME_TAB_ID) {
    sessions.setActive(tabId)
    pushCookies(tabId)
  }

  showView(tabId)
  broadcastTabs()
}

// ---- IPC Handlers ----

async function handleSwitch(_, sessionId, url) {
  const existing = sessions.get(sessionId)

  if (existing) {
    if (tabViews.has(sessionId)) {
      switchTab(sessionId)
    } else {
      await createSessionView(sessionId, url || existing.url)
    }
    sessions.setActive(sessionId)
    pushCookies(sessionId)
    return { action: 'switched', sessionId }
  }

  sessions.create(sessionId, url)
  await createSessionView(sessionId, url)
  sessions.setActive(sessionId)
  setTimeout(() => pushCookies(sessionId), 1000)
  return { action: 'created', sessionId }
}

async function handleSetSession(_, oldName, newName) {
  if (!oldName || !newName || oldName === newName) {
    return { success: false, reason: 'invalid names' }
  }

  if (!sessions.get(oldName)) {
    return { success: false, reason: 'old session not found' }
  }

  // If newName has an open tab, close it
  const existingTab = tabViews.get(newName)
  if (existingTab) {
    closeTab(newName)
  }

  // If newName exists in metadata, remove it
  if (sessions.get(newName)) {
    sessions.remove(newName)
  }

  // Just remap: oldName's partition → newName
  sessions.rename(oldName, newName)

  const data = tabViews.get(oldName)
  if (data) {
    stopWatching(oldName)
    tabViews.delete(oldName)
    data.sessionId = newName
    tabViews.set(newName, data)

    const idx = tabOrder.indexOf(oldName)
    if (idx !== -1) tabOrder[idx] = newName
    if (activeTabId === oldName) activeTabId = newName

    watchCookies(newName)
    pushCookies(newName)
  }

  broadcastTabs()
  return { success: true, sessionId: newName }
}

async function handleStop(_, eventType, sessionId) {
  if (eventType === 'cookie') {
    stopWatching(sessionId)
    return { success: true, sessionId }
  }
  return { success: false, reason: 'unknown event type' }
}

// ---- Shell IPC Handlers ----

function handleShellSwitchTab(_, tabId) {
  switchTab(tabId)
}

function handleShellCloseTab(_, tabId) {
  if (tabId === HOME_TAB_ID) return
  closeTab(tabId)
}

function handleShellNewTab() {
  const id = `tab-${Date.now()}`
  const ses = session.defaultSession
  const webPreferences = getHomeWebPreferences(ses)
  const view = new BrowserView({ webPreferences })

  mainWindow.addBrowserView(view)
  setupViewEvents(view, id)

  view.webContents.loadURL(homeUrl)

  tabViews.set(id, { view, type: 'home', url: homeUrl, originalUrl: homeUrl })
  tabOrder.push(id)
  activeTabId = id
  showView(id)
  broadcastTabs()
}

function handleShellMinimize() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.minimize()
  }
}

function handleShellMaximize() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow.maximize()
    }
  }
}

function handleShellClose() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close()
  }
}

// ---- Registration ----

function register(ipcMain) {
  ipcMain.handle('switch', handleSwitch)
  ipcMain.handle('setSession', handleSetSession)
  ipcMain.handle('stop', handleStop)

  ipcMain.on('shell:switch-tab', handleShellSwitchTab)
  ipcMain.on('shell:close-tab', handleShellCloseTab)
  ipcMain.on('shell:new-tab', handleShellNewTab)
  ipcMain.on('shell:minimize', handleShellMinimize)
  ipcMain.on('shell:maximize', handleShellMaximize)
  ipcMain.on('shell:close', handleShellClose)
}

module.exports = { register, setMainWindow, createHomeView, pushCookies }
