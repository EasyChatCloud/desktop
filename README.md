# ZhiDuoDesktop

基于 Electron 的多会话浏览器，标签页管理，Session 级别 Cookie 隔离 + 实时推送 + 抓包。

## 快速开始

```bash
npm install
npm start        # 生产环境
npm run dev      # 开发环境 (--dev)
npm run build:win    # 打包 Windows NSIS
npm run build:mac    # 打包 macOS DMG
npm run build:dir    # 打包未压缩目录（调试用）
```

## 项目结构

```
├── package.json
├── launch.js              # 启动脚本，处理 ELECTRON_RUN_AS_NODE
├── main/
│   ├── index.js           # 主进程入口
│   ├── ipc-handlers.js    # IPC + BrowserView 生命周期 + Cookie + Popup
│   ├── sessions.js        # Session 元数据 + partitionId 对照表
│   ├── preload.js         # contextBridge → window.electronAPI
│   ├── shell-preload.js   # window.shellAPI（标签栏）
│   ├── session-preload.js # 反检测预加载 + electronAPI
│   ├── shell.html         # 标签栏 UI
│   ├── capture.js         # 抓包核心（whistle 代理 + 系统代理 + 证书）
│   ├── capture-popup.html # 抓包启动状态弹窗
│   └── updater.js         # 自动更新
└── README.md
```

## 架构

```
Electron Main Process
  ├── BrowserWindow (shell.html — 标签栏 40px)
  │     shell:tabs, shell:switch-tab, shell:close-tab, shell:new-tab,
  │     shell:focus-popup, shell:minimize, shell:maximize, shell:close
  │
  ├── N × BrowserView (每 session 独立视图)
  │     switch, setSession, stop, closePopup
  │     push:cookie, shell:tab-title
  │
  ├── M × BrowserWindow (Popup 弹窗，parent = mainWindow)
  │     同 session partition，父标签锁定(🔒)，关闭弹窗解锁
  │
  └── 抓包模块 (capture.js)
        whistle 代理 + 系统代理 + 证书自动安装 + 数据回调
```

### Cookie 隔离

`session.fromPartition('persist:{partitionId}')` 为每个 Session 创建独立持久化存储（Cookie、LocalStorage、SessionStorage、缓存、IndexedDB）。`partitionId` 创建时生成，`rename` 只改别名不改分区，Cookie 数据零迁移。

### 反检测

匹配域名（`koubei.com`, `e.koubei.com`, `ele.me`）使用 `contextIsolation: false` + `session-preload.js` 多策略 patch：
- `navigator.webdriver` 四层覆盖、`navigator.plugins`/`languages` 伪造
- `window.chrome.runtime` 注入、自动化框架全局变量清理

---

# API 参考

## 1. 基础 API

### switch(sessionId, url, opts?)

```js
const result = await window.electronAPI.switch('session-1', 'https://example.com', {
  method: 'tab',       // 'tab' | 'pop-up'
  title: '我的标签'
})
```

| opts.method | 行为 |
|-------------|------|
| `tab`（默认）| 创建/切换到 BrowserView 标签页 |
| `pop-up` | 创建独立 BrowserWindow，父标签锁定 |

### rename(oldName, newName)

```js
const result = await window.electronAPI.rename('old', 'new')
// { success: true, sessionId: 'new' }
```

### closePopup(sessionId)

```js
await window.electronAPI.closePopup('session-1')
```

### push(event, callback)

```js
// Cookie 推送
window.electronAPI.push('cookie', (data) => {
  // data.sessionId, data.cookies
})

// URL 变化推送
window.electronAPI.push('url', (data) => {
  // data.sessionId, data.url, data.domain
})
```

---

## 2. 弹窗机制

同一 session 最多一个弹窗。弹窗期间父标签半透明 + 🔒，点击聚焦弹窗。关闭弹窗自动解锁。

```js
// 打开弹窗
await window.electronAPI.switch('s1', url, { method: 'pop-up', title: '修改商品' })

// 关闭弹窗（页面内调用）
await window.electronAPI.closePopup('s1')
```

---

## 3. 抓包 API

通过 `window.electronAPI.capture` 控制 whistle 代理抓包，系统级代理 + HTTPS 解密 + 实时数据回调。

### capture.start(urls?)

```js
// 抓全部流量
await window.electronAPI.capture.start()

// 只抓匹配域名
await window.electronAPI.capture.start(['api.weixin.qq.com', 'meituan.com'])
// → { success: true, port: 8000, certInstalled: true }
```

### capture.stop()

```js
await window.electronAPI.capture.stop()
```

### capture.push(type, callback)

**必须在 `start()` 之前注册。**

```js
// 进度消息
window.electronAPI.capture.push('message', (msg) => {
  // "正在启动抓包..." / "正在安装证书..." / "证书安装成功"
})

// 结果通知
window.electronAPI.capture.push('status', ({ message, success, port }) => {
  // { message: "抓包已启动，监听端口 8000", success: true, port: 8000 }
})

// 抓包数据
window.electronAPI.capture.push('data', (entry) => {
  // entry: { id, url, hostname, path, method, statusCode, duration,
  //          reqHeaders, reqSize, reqBody, resHeaders, resSize, resBody }
})
```

### data 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 请求唯一 ID |
| `url` | `string` | 完整 URL |
| `hostname` | `string` | 域名 |
| `method` | `string` | 请求方法 |
| `statusCode` | `number` | 响应状态码 |
| `duration` | `number` | 耗时（ms） |
| `reqHeaders` | `object` | 请求头 |
| `reqSize` | `number` | 请求体大小 |
| `reqBody` | `string` | 请求体（截断 4KB） |
| `resHeaders` | `object` | 响应头 |
| `resSize` | `number` | 响应体大小 |
| `resBody` | `string` | 响应体（截断 4KB） |

### 完整示例

```js
window.electronAPI.capture.push('message', (msg) => updateStatus(msg))

window.electronAPI.capture.push('status', ({ message, success, port }) => {
  success ? showToast(`✅ ${message}`) : showToast(`❌ ${message}`)
})

window.electronAPI.capture.push('data', (entry) => {
  console.log(`[${entry.method}] ${entry.statusCode} ${entry.url}`)
})

const result = await window.electronAPI.capture.start(['wx-shangou.meituan.com'])
await window.electronAPI.capture.stop()
```

### 端口与证书

- 端口：`8000` ~ `8020`，依次尝试
- 证书：`certutil` 静默安装到受信任根证书颁发机构，失败回退手动向导
- 路径：`%USERPROFILE%\.WhistleAppData\.whistle\certs\root.crt`

### 系统代理

| 平台 | 方式 |
|------|------|
| Windows | PowerShell `Set-ItemProperty`（注册表 `Internet Settings`） |
| macOS | `networksetup -setwebproxy` / `-setsecurewebproxy` |

停止自动恢复，闪退后下次启动自动恢复。

---

## 自动更新

应用启动后自动检查 `https://shangou.muchen.store/downloads/ZhiDuoDesktop/latest.yml`：

```yaml
version: 1.0.1
files:
  - url: 智朵 Setup 1.0.1.exe
    sha512: abcd1234...
    size: 87654321
```

服务器对比版本号，有新版本时推送 `update:status` → `update-available`。

---

## 配置

`package.json` 的 `config`：

```json
{
  "config": {
    "targetURL": "http://localhost:15000/",
    "prodURL": "https://shangou.muchen.store",
    "updateURL": "https://shangou.muchen.store/downloads/EasyChatDesktop/"
  }
}
```

## IPC 通道

| 通道 | 方向 | 类型 | 用途 |
|------|------|------|------|
| `switch` | renderer → main | `handle` | 创建/切换会话视图 |
| `setSession` | renderer → main | `handle` | 重命名会话 |
| `stop` | renderer → main | `handle` | 停止 Cookie 监听 |
| `closePopup` | renderer → main | `handle` | 关闭弹窗 |
| `capture:start` | renderer → main | `handle` | 启动抓包 |
| `capture:stop` | renderer → main | `handle` | 停止抓包 |
| `capture:push:message` | main → renderer | `send` | 抓包进度 |
| `capture:push:status` | main → renderer | `send` | 抓包结果 |
| `capture:push:data` | main → renderer | `send` | 抓包数据 |
| `push:cookie` | main → renderer | `send` | Cookie 推送 |
| `shell:tabs` | main → renderer | `send` | 标签列表 + 激活 + 锁定 |
| `shell:switch-tab` | renderer → main | `on` | 点击标签切换 |
| `shell:close-tab` | renderer → main | `on` | 关闭标签 |
| `shell:new-tab` | renderer → main | `on` | 新建标签 |
| `shell:focus-popup` | renderer → main | `on` | 聚焦弹窗 |
| `shell:minimize/maximize/close` | renderer → main | `on` | 窗口控制 |

## CI/CD

GitHub Actions (`.github/workflows/build.yml`)：
- push 到 main/master / `v*` 标签 / PR / 手动触发
- Windows: `electron-builder --win --x64` → `.exe` artifact
- macOS: `electron-builder --mac --universal` → `.dmg` artifact
