const { app, shell } = require('electron')
const { execSync } = require('child_process')
const zlib = require('zlib')
const path = require('path')
const fs = require('fs')
const http = require('http')

let mainWindow = null
let homeWebContents = null
let whistleServer = null
let whistleWebPath = ''     // whistle's random WEBUI_PATH for API calls
let pollTimer = null
let statsWs = null
let originalProxy = null
let captureActive = false
let capturePort = 0
let urlFilter = []
let activeNetworkService = ''

const isWin = process.platform === 'win32'

// ====== Crash Recovery ======
// If the app crashed while proxy was set, restore on next startup

const STATE_FILE = path.join(app.getPath('userData'), '.capture-state')

function writeStateFile() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      port: capturePort,
      proxy: originalProxy,
      isWin,
      time: Date.now()
    }))
  } catch (_) {}
}

function clearStateFile() {
  try { if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE) } catch (_) {}
}

function recoverFromCrash() {
  // 1. Kill any zombie processes holding our port range (8000-8020)
  safeExec(() => {
    try {
      // Check each port individually to catch all processes in our range
      for (let port = 8000; port <= 8020; port++) {
        try {
          const out = execSync(`netstat -ano | findstr "127.0.0.1:${port}"`, { encoding: 'utf8', timeout: 3000 })
          const pids = new Set()
          out.split('\n').forEach(line => {
            const m = line.match(/LISTENING\s+(\d+)/)
            if (m) pids.add(m[1])
          })
          pids.forEach(pid => {
            // Kill ANY process holding our ports (not just electron.exe)
            // Whistle children from previous runs may not have electron.exe as the name
            console.log('[capture] killing zombie process on port', port, 'PID:', pid)
            execSync(`taskkill /F /PID ${pid}`, { encoding: 'utf8', timeout: 5000 })
          })
        } catch (_) {}
      }
    } catch (_) {}
  })

  // 2. Restore system proxy if we left it dirty from a crash
  try {
    if (!fs.existsSync(STATE_FILE)) return
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'))
    console.log('[capture] found stale state file, restoring proxy...')
    if (state.isWin && state.proxy) {
      safeExec(() => restoreWinProxyDirect(state.proxy))
    }
    fs.unlinkSync(STATE_FILE)
    console.log('[capture] crash recovery complete')
  } catch (_) {}
}

// ====== Safe Exec Wrapper ======

function safeExec(fn, fallback) {
  try { return fn() } catch (e) {
    console.error('[capture] exec error:', e.message)
    return fallback
  }
}

// ====== System Proxy (Windows) ======

function saveWinProxy() {
  return safeExec(() => {
    const ps = `Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' | Select-Object ProxyEnable,ProxyServer,ProxyOverride | ConvertTo-Json`
    const json = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8', timeout: 5000 }).trim()
    return JSON.parse(json)
  }, { ProxyEnable: 0, ProxyServer: '', ProxyOverride: '' })
}

function setWinProxy(port) {
  safeExec(() => {
    const ps = `$path='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';Set-ItemProperty -Path $path -Name ProxyServer -Value '127.0.0.1:${port}';Set-ItemProperty -Path $path -Name ProxyEnable -Value 1`
    execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8', timeout: 5000 })
  })
}

function restoreWinProxyDirect(proxy) {
  if (!proxy) return
  safeExec(() => {
    const enable = (proxy.ProxyEnable === 1 || proxy.ProxyEnable === '1') ? 1 : 0
    const server = (proxy.ProxyServer || '').replace(/'/g, "''")
    const override = (proxy.ProxyOverride || '').replace(/'/g, "''")
    const ps = `$path='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';Set-ItemProperty -Path $path -Name ProxyEnable -Value ${enable};Set-ItemProperty -Path $path -Name ProxyServer -Value '${server}';Set-ItemProperty -Path $path -Name ProxyOverride -Value '${override}'`
    execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8', timeout: 5000 })
  })
}

function restoreWinProxy(proxy) {
  restoreWinProxyDirect(proxy)
  console.log('[capture] win proxy restored')
}

// ====== System Proxy (macOS) ======

function getMacNetworkService() {
  return safeExec(() => {
    const out = execSync(
      `networksetup -listnetworkserviceorder | grep -B1 "$(route get default 2>/dev/null | grep interface | awk '{print $2}')" | head -1 | sed 's/.*: //'`,
      { encoding: 'utf8', timeout: 5000, shell: '/bin/bash' }
    ).trim()
    return out || 'Wi-Fi'
  }, 'Wi-Fi')
}

function saveMacProxy() {
  const svc = activeNetworkService
  return safeExec(() => {
    const web = execSync(`networksetup -getwebproxy "${svc}"`, { encoding: 'utf8', timeout: 5000 }).trim()
    const secure = execSync(`networksetup -getsecurewebproxy "${svc}"`, { encoding: 'utf8', timeout: 5000 }).trim()
    return { service: svc, webProxy: web, secureProxy: secure }
  }, { service: svc, webProxy: '', secureProxy: '' })
}

function setMacProxy(port) {
  const svc = activeNetworkService
  safeExec(() => {
    execSync(`networksetup -setwebproxy "${svc}" 127.0.0.1 ${port}`, { encoding: 'utf8', timeout: 5000 })
    execSync(`networksetup -setsecurewebproxy "${svc}" 127.0.0.1 ${port}`, { encoding: 'utf8', timeout: 5000 })
  })
}

function restoreMacProxy(proxy) {
  if (!proxy) return
  const svc = proxy.service || activeNetworkService
  const webEnabled = (proxy.webProxy || '').includes('Enabled: Yes')
  const secureEnabled = (proxy.secureProxy || '').includes('Enabled: Yes')
  safeExec(() => {
    execSync(`networksetup -setwebproxystate "${svc}" ${webEnabled ? 'on' : 'off'}`, { encoding: 'utf8', timeout: 5000 })
    execSync(`networksetup -setsecurewebproxystate "${svc}" ${secureEnabled ? 'on' : 'off'}`, { encoding: 'utf8', timeout: 5000 })
  })
}

// ====== Unified Proxy Interface ======

function saveOriginalProxy() {
  if (isWin) return saveWinProxy()
  return saveMacProxy()
}

function setSystemProxy(port) {
  if (isWin) setWinProxy(port)
  else setMacProxy(port)
}

function restoreSystemProxy() {
  if (!originalProxy) return
  if (isWin) restoreWinProxy(originalProxy)
  else restoreMacProxy(originalProxy)
  console.log('[capture] system proxy restored')
}

// ====== Certificate ======

function installCert(certPath) {
  if (!certPath || !fs.existsSync(certPath)) return false

  if (isWin) {
    // Auto-install to user's Trusted Root store (no UI)
    const ok = safeExec(() => {
      execSync(`certutil -addstore -user Root "${certPath}"`, { encoding: 'utf8', timeout: 10000 })
      return true
    }, false)
    if (ok) {
      console.log('[capture] cert auto-installed')
      return true
    }
  }
  // Fallback: manual via OS wizard
  shell.openPath(certPath)
  console.log('[capture] cert manual install opened')
  return true
}

// ====== Data Push (to page BrowserView via IPC) ======

function pushMessage(message) {
  safeExec(() => {
    const wc = homeWebContents || (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents)
    if (wc && !wc.isDestroyed()) {
      wc.send('capture:push:message', message)
    }
  })
}

function pushStatus(message, success) {
  safeExec(() => {
    const wc = homeWebContents || (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents)
    if (wc && !wc.isDestroyed()) {
      wc.send('capture:push:status', { message, success, port: capturePort || null })
    }
  })
}

function pushData(entry) {
  safeExec(() => {
    const wc = homeWebContents || (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents)
    if (wc && !wc.isDestroyed()) {
      wc.send('capture:push:data', entry)
    }
  })
}

// ====== URL Filtering ======

function matchesFilter(hostname, pathname) {
  if (!urlFilter || urlFilter.length === 0) return true
  return urlFilter.some(f => hostname.includes(f) || (pathname && pathname.includes(f)))
}

// ====== Data Polling (use whistle /cgi-bin/get-data) ======

let seenIds = new Set()

function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')) })
  })
}

function connectPolling() {
  seenIds = new Set()

  async function doPoll() {
    if (!captureActive) return
    try {
      // Use bulk get-data — includes all request data with bodies
      const summary = await httpGetJSON(`http://127.0.0.1:${capturePort}/cgi-bin/get-data`)
      const allData = (summary.data && summary.data.data) || {}

      for (const id of Object.keys(allData)) {
        if (!captureActive) return
        if (seenIds.has(id)) continue

        const reqData = allData[id]
        if (!reqData) continue

        const resStatus = (reqData.res || {}).statusCode || 0
        if (!resStatus) continue
        seenIds.add(id)

        const url = reqData.url || ''
        let hostname = ''
        let pathname = ''
        try {
          const u = new URL(url)
          hostname = u.hostname
          pathname = u.pathname
        } catch (_) {}

        if (!matchesFilter(hostname, pathname)) continue

        const reqBody = decodeBody(reqData.req)
        const resBody = decodeBody(reqData.res)

        pushData({
          id: reqData.id || id,
          url,
          hostname,
          path: pathname,
          method: (reqData.req || {}).method || 'GET',
          statusCode: resStatus,
          duration: reqData.ttfb || 0,
          reqHeaders: (reqData.req || {}).headers || {},
          reqSize: (reqData.req || {}).size || 0,
          reqBody: truncateBody(reqBody),
          resHeaders: (reqData.res || {}).headers || {},
          resSize: (reqData.res || {}).size || 0,
          resBody: truncateBody(resBody)
        })
      }
    } catch (_) {}
  }

  function decodeBody(r) {
    // Whistle stores body in base64 field as uncompressed base64
    const raw = (r || {}).base64
    if (!raw) return (r || {}).body || ''
    try {
      return Buffer.from(String(raw).replace(/\s/g, ''), 'base64').toString('utf8')
    } catch (_) {
      return String(raw).slice(0, 4096)
    }
  }

  doPoll()
  pollTimer = setInterval(doPoll, 2000)
  return { stop: () => { clearInterval(pollTimer); pollTimer = null; seenIds.clear() } }
}

function truncateBody(body, maxLen) {
  maxLen = maxLen || 4096
  if (!body) return ''
  const str = typeof body === 'string' ? body : JSON.stringify(body)
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen) + `... [TRUNCATED ${str.length - maxLen} bytes]`
}

// ====== Core API ======

function setRefs(refs) {
  mainWindow = refs.mainWindow
}

// Called after home BrowserView is created to wire up push target
function setHomeWebContents(wc) {
  homeWebContents = wc
}


async function startCapture(urls) {
  if (captureActive) {
    pushStatus('抓包已在运行中', false)
    return { success: false, message: '抓包已在运行中' }
  }

  urlFilter = Array.isArray(urls) ? urls : []

  // 1. Notify page: starting
  pushMessage('正在启动抓包...')

  // 2. Save original proxy
  pushMessage('正在保存代理设置...')
  if (isWin) {
    originalProxy = saveWinProxy()
  } else {
    activeNetworkService = getMacNetworkService()
    originalProxy = saveMacProxy()
  }
  console.log('[capture] original proxy saved:', JSON.stringify(originalProxy))

  // Write state file for crash recovery
  writeStateFile()

  // 4. Check certificate — whistle uses its own default dir, not our certDir option
  const whistleHome = path.join(require('os').homedir(), '.WhistleAppData', '.whistle', 'certs')
  const certPath = path.join(whistleHome, 'root.crt')
  const certExists = fs.existsSync(certPath)

  // 5. Start whistle on first available port in 8000-8020
  pushMessage('正在启动代理服务...')
  let port = 0
  let whistleResult = null

  try {
    const whistle = require('whistle')
    for (let tryPort = 8000; tryPort <= 8020; tryPort++) {
      try {
        const result = await new Promise((resolve, reject) => {
          let settled = false
          let errorListener = null
          const srv = whistle({
            port: tryPort,
            baseDir: path.join(app.getPath('userData'), 'whistle-data'),
            copy: true,
            debug: false
          }, (cbResult) => {
            if (settled) return
            settled = true
            if (errorListener) srv.server.removeListener('error', errorListener)
            if (cbResult && cbResult.server) {
              resolve(cbResult)
            } else if (cbResult instanceof Error) {
              reject(cbResult)
            } else {
              resolve(cbResult || srv)
            }
          })
          // Listen for errors on BOTH srv (EventEmitter) AND srv.server (HTTP server)
          errorListener = (err) => {
            if (settled) return
            settled = true
            reject(err)
          }
          srv.on('error', errorListener)
          // Also listen on the HTTP server directly (whistle's callback only fires on success)
          if (srv.server) {
            srv.server.on('error', errorListener)
          }
          setTimeout(() => {
            if (settled) return
            // Timeout — server didn't start (port likely occupied)
            settled = true
            reject(new Error('EADDRINUSE port ' + tryPort))
          }, 8000)
        })
        // Success — verify server is actually listening
        const serverObj = (result && result.server) ? result.server : result
        const addr = (serverObj && serverObj.address && serverObj.address()) || null
        if (!addr || !addr.port) {
          throw new Error('server started but address unavailable on port ' + tryPort)
        }
        port = addr.port
        capturePort = port
        whistleServer = result
        // Save whistle's random web UI path for API polling
        whistleWebPath = (result && result.config && result.config.WEBUI_PATH) || ''
        console.log('[capture] whistle started on port', port, 'web path:', whistleWebPath)

        // 8.5 Enable HTTPS interception (auto)
        safeExec(() => {
          if (whistleServer && whistleServer.rulesUtil) {
            whistleServer.rulesUtil.addRules('* enableHttps', false)
            console.log('[capture] HTTPS interception enabled via rules')
          }
        })

        break
      } catch (e) {
        const code = (e && (e.code || e.message)) ? (e.code || e.message) : String(e)
        console.log('[capture] port', tryPort, 'failed:', code)
        if (tryPort === 8020) throw e  // last port, propagate
      }
    }
    if (!port) throw new Error('no port available in 8000-8020')
  } catch (err) {
    const msg = err && err.message ? err.message : (typeof err === 'string' ? err : JSON.stringify(err))
    console.error('[capture] whistle failed:', msg)
    restoreSystemProxy()
    clearStateFile()
    pushStatus('代理启动失败: ' + msg, false)
    return { success: false, message: 'whistle: ' + msg }
  }

  // 6. Set system proxy
  pushMessage('正在设置系统代理...')
  if (isWin) setWinProxy(port)
  else setMacProxy(port)
  console.log('[capture] system proxy set to 127.0.0.1:' + port)

  // 7. Certificate — auto-install via certutil if needed
  let certOk = certExists
  if (!certExists) {
    pushMessage('正在生成证书...')
    await new Promise(r => setTimeout(r, 1500))
    if (fs.existsSync(certPath)) {
      pushMessage('正在安装证书...')
      certOk = installCert(certPath)
      pushMessage(certOk ? '证书安装成功' : '证书安装失败，请手动安装')
    } else {
      pushMessage('证书生成失败')
    }
  }

  // 8. Start polling (wrapped — won't crash the flow)
  try {
    const p = connectPolling()
    statsWs = p  // reuse the same field for cleanup
  } catch (e) {
    console.error('[capture] polling start failed:', e.message)
  }

  // 9. Done
  captureActive = true
  const certMsg = certOk ? '' : ' | ⚠ 证书安装失败，HTTPS无法解密，请手动安装'
  pushStatus(`抓包已启动，监听端口 ${port}${certMsg}`, true)
  return { success: true, port, certInstalled: certOk }
}


async function stopCapture() {
  if (!captureActive) {
    return { success: false, message: '未在抓包' }
  }

  captureActive = false

  pushMessage('正在停止抓包...')

  // Stop polling first
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  if (statsWs) { try { statsWs.stop() } catch (_) {}; statsWs = null }

  // Restore system proxy — CRITICAL, must succeed
  pushMessage('正在恢复系统代理...')
  restoreSystemProxy()

  // Stop whistle — close actual HTTP/HTTPS servers, not the EventEmitter wrapper
  if (whistleServer) {
    const servers = []
    if (whistleServer.server) servers.push(whistleServer.server)
    if (whistleServer.httpsServer) servers.push(whistleServer.httpsServer)
    servers.forEach(srv => {
      safeExec(() => {
        srv.close()
        console.log('[capture] server closed')
      })
    })
    whistleServer = null
  }

  clearStateFile()

  urlFilter = []
  originalProxy = null
  capturePort = 0
  whistleWebPath = ''

  pushStatus('抓包已停止', true)
  return { success: true }
}

function getStatus() {
  return { active: captureActive, port: capturePort || null }
}

function destroy() {
  if (captureActive) {
    captureActive = false
    restoreSystemProxy()  // MUST restore before exit
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    if (statsWs) { try { statsWs.stop() } catch (_) {}; statsWs = null }
    if (whistleServer && whistleServer.server) {
      safeExec(() => { whistleServer.server.close(); console.log('[capture] server closed (destroy)') })
      if (whistleServer.httpsServer) {
        safeExec(() => whistleServer.httpsServer.close())
      }
      whistleServer = null
    }
    clearStateFile()
  }
}

// Run crash recovery on module load
recoverFromCrash()

// Also register before-quit to ensure proxy restore
app.on('before-quit', () => {
  if (captureActive) {
    console.log('[capture] before-quit: restoring proxy')
    restoreSystemProxy()
    clearStateFile()
  }
})

module.exports = { setRefs, setHomeWebContents, startCapture, stopCapture, getStatus, destroy }
