const { BrowserWindow, BrowserView, Menu, session } = require('electron')
const path = require('path')
const sessions = require('./sessions')

const HOME_TAB_ID = '__home__'
const TAB_BAR_HEIGHT = 40

const tabViews = new Map()
const cookieWatchers = new Map()
const sentSnapshots = new Map()
const popupWindows = new Map()  // parentSessionId -> BrowserWindow
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
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        mainWindow.webContents.send('shell:tab-title', { id: tabId, title: extractDomain(navUrl) || navUrl })
      }
    })
    view.webContents.on('page-title-updated', (_, title) => {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        mainWindow.webContents.send('shell:tab-title', { id: tabId, title })
      }
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
      title: data.type === 'home' ? '主页' : (data.title || data.sessionId || extractDomain(data.url)),
      type: data.type,
      sessionId: data.sessionId,
      locked: !!(data.sessionId && popupWindows.has(data.sessionId))
    }
  }).filter(Boolean)

  mainWindow.webContents.send('shell:tabs', { tabs, activeId: activeTabId })
}

function createHomeViewForTab(tabId) {
  const ses = session.defaultSession
  const webPreferences = getHomeWebPreferences(ses)
  const view = new BrowserView({ webPreferences })

  mainWindow.addBrowserView(view)
  setupViewEvents(view, tabId)
  view.webContents.loadURL(homeUrl)

  tabViews.set(tabId, { view, type: 'home', url: homeUrl, originalUrl: homeUrl })
  tabOrder.push(tabId)
  activeTabId = tabId
  showView(tabId)
  broadcastTabs()

  return view
}

async function createHomeView() {
  const view = createHomeViewForTab(HOME_TAB_ID)
  // Wire capture push target to the home BrowserView
  const capture = require('./capture')
  capture.setHomeWebContents(view.webContents)
  return view
}

async function createSessionView(sessionId, url, title) {
  const ses = sessionPartition(sessionId)
  const domain = extractDomain(url)
  const webPreferences = getWebPreferences(ses, domain)

  const view = new BrowserView({ webPreferences })

  mainWindow.addBrowserView(view)
  setupViewEvents(view, sessionId)
  setupSessionSpecific(view, sessionId, ses, domain)

  view.webContents.loadURL(url)

  tabViews.set(sessionId, { view, type: 'session', sessionId, url, originalUrl: url, title: title || sessionId })
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

  // Close associated popup first (cleanup deferred to closed event handler)
  if (data.sessionId && popupWindows.has(data.sessionId)) {
    const popupWin = popupWindows.get(data.sessionId)
    if (popupWin && !popupWin.isDestroyed()) {
      popupWin.close()
    }
  }

  // Destroy view contents before removing (stops audio/video, JS, network)
  try {
    data.view.webContents.stop()
    data.view.webContents.setAudioMuted(true)
    data.view.webContents.loadURL('about:blank')
  } catch (_) {}

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

// ---- Popup Window ----

function createPopupWindow(sessionId, url, title) {
  // If popup already exists for this session, focus it
  if (popupWindows.has(sessionId)) {
    const win = popupWindows.get(sessionId)
    if (win && !win.isDestroyed()) {
      win.focus()
      return { action: 'focused', sessionId }
    }
    // Window was destroyed, clean up tracking
    popupWindows.delete(sessionId)
  }

  const ses = sessionPartition(sessionId)
  const domain = extractDomain(url)
  const webPreferences = getWebPreferences(ses, domain)

  // Ensure electronAPI is available in popup for normal (non-anti-detection) sites
  if (!webPreferences.preload) {
    webPreferences.preload = path.join(__dirname, 'preload.js')
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
  }

  const popupTitle = title || sessionId
  const popupWin = new BrowserWindow({
    width: 1920,
    height: 1080,
    title: popupTitle,
    parent: mainWindow,
    webPreferences
  })

  popupWin.setMenuBarVisibility(false)
  popupWin.webContents.setAudioMuted(true)
  popupWin.maximize()

  // Set Chrome UA to match tab sessions
  ses.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  )

  popupWin.webContents.loadURL(url)

  // Track relationship
  popupWindows.set(sessionId, popupWin)

  // Setup cookie watching from popup's session
  watchCookies(sessionId)

  popupWin.webContents.on('did-finish-load', () => {
    pushCookies(sessionId)
  })

  // Force-stop media/JS when popup is closing
  popupWin.on('close', () => {
    try {
      popupWin.webContents.stop()
      popupWin.webContents.setAudioMuted(true)
    } catch (_) {}
  })

  // On popup closed, clean up tracking
  popupWin.on('closed', () => {
    popupWindows.delete(sessionId)
    broadcastTabs()
    // If the parent was active, re-show it
    if (activeTabId === sessionId && tabViews.has(sessionId)) {
      showView(sessionId)
    }
  })

  broadcastTabs()
  return { action: 'popup-created', sessionId }
}

// ---- IPC Handlers ----

async function handleSwitch(_, sessionId, url, opts = {}) {
  const method = opts.method || 'tab'
  const title = opts.title || null

  // --- Pop-up mode ---
  if (method === 'pop-up') {
    // Ensure session exists in metadata (for partition tracking)
    const existing = sessions.get(sessionId)
    if (!existing) {
      sessions.create(sessionId, url)
    }
    // Do NOT create a tab — the popup window IS the view for this session.
    // If a tab already exists for this session, it stays and gets locked.
    const popupUrl = url || (existing && existing.url)
    if (!popupUrl) {
      return { success: false, reason: 'url required for pop-up' }
    }
    return createPopupWindow(sessionId, popupUrl, title)
  }

  // --- Tab mode (default) ---
  const existing = sessions.get(sessionId)

  if (existing) {
    if (tabViews.has(sessionId)) {
      switchTab(sessionId)  // switchTab already calls setActive + pushCookies
    } else {
      await createSessionView(sessionId, url || existing.url, title)
      sessions.setActive(sessionId)
      pushCookies(sessionId)
    }
    return { action: 'switched', sessionId }
  }

  // sessions.create already sets activeSessionId
  sessions.create(sessionId, url)
  await createSessionView(sessionId, url, title)
  setTimeout(() => pushCookies(sessionId), 1000)
  return { action: 'created', sessionId }
}

async function handleClosePopup(_, sessionId) {
  const popupWin = popupWindows.get(sessionId)
  if (popupWin && !popupWin.isDestroyed()) {
    popupWin.close()
    return { success: true, sessionId }
  }
  return { success: false, reason: 'popup not found' }
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

  // If newName exists in metadata, remove it (remove() no-ops if absent)
  sessions.remove(newName)

  // Transfer popup relationship
  if (popupWindows.has(oldName)) {
    const popupWin = popupWindows.get(oldName)
    popupWindows.delete(oldName)
    popupWindows.set(newName, popupWin)
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
  // If tab is locked by a popup, focus the popup instead
  if (popupWindows.has(tabId)) {
    const popupWin = popupWindows.get(tabId)
    if (popupWin && !popupWin.isDestroyed()) {
      popupWin.focus()
    }
    return
  }
  switchTab(tabId)
}

function handleShellCloseTab(_, tabId) {
  if (tabId === HOME_TAB_ID) return
  closeTab(tabId)
}

function handleShellNewTab() {
  createHomeViewForTab(`tab-${Date.now()}`)
}

function handleShellFocusPopup(_, tabId) {
  const popupWin = popupWindows.get(tabId)
  if (popupWin && !popupWin.isDestroyed()) {
    popupWin.focus()
  }
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
  ipcMain.handle('closePopup', handleClosePopup)

  ipcMain.on('shell:switch-tab', handleShellSwitchTab)
  ipcMain.on('shell:close-tab', handleShellCloseTab)
  ipcMain.on('shell:new-tab', handleShellNewTab)
  ipcMain.on('shell:focus-popup', handleShellFocusPopup)
  ipcMain.on('shell:minimize', handleShellMinimize)
  ipcMain.on('shell:maximize', handleShellMaximize)
  ipcMain.on('shell:close', handleShellClose)
}

module.exports = { register, setMainWindow, createHomeView, pushCookies }
