# Multi-Profile Browser

基于 Electron 的多会话浏览器，标签页形式管理，Session 级别 Cookie 隔离 + 实时推送。

## 功能

- **标签页管理**：类似 Chrome 的标签栏，点击切换、关闭按钮关闭（主页不可关闭）
- **指令创建标签**：通过 `window.electronAPI.switch()` 创建新标签，非手动新建
- **Cookie 完全隔离**：每个 Session 独立的 `session.fromPartition()`，Cookie 互相隔离
- **Cookie 实时推送**：变化时自动推送全量 Cookie，快照去重
- **稳定分区**：内部使用 `partitionId` 对照表，`rename` 只改别名，Cookie 数据不迁移、不丢失
- **域名反检测**：`koubei.com` / `ele.me` 自动启用反检测模式（`contextIsolation: false` + 多策略 patch）
- **右键菜单**：主页 / 刷新
- **F12 调试**：所有环境均可用，不自动打开

## 快速开始

```bash
npm install
npm start        # 生产环境
npm run dev      # 测试环境 (--dev)
```

## 项目结构

```
├── package.json
├── launch.js              # 启动脚本，处理 ELECTRON_RUN_AS_NODE 兼容
├── main/
│   ├── index.js           # Electron 主进程入口
│   ├── shell.html         # 标签栏 UI
│   ├── shell-preload.js   # 标签栏 ↔ 主进程 IPC
│   ├── preload.js         # 注入 window.electronAPI（contextBridge）
│   ├── sessions.js        # Session 元数据 + partitionId 对照表
│   ├── session-preload.js # 反检测预加载脚本
│   └── ipc-handlers.js    # IPC 通信 + BrowserView 管理
└── README.md
```

## 架构

```
┌──────────────────────────────────────────────────┐
│  原生标题栏                                       │
├──────────────────────────────────────────────────┤
│  [主页] [session-1] [session-2] ×    ← shell.html│
├──────────────────────────────────────────────────┤
│                                                  │
│  当前激活的 BrowserView                           │
│  (Vue 网站 或 外部站点)                            │
│                                                  │
└──────────────────────────────────────────────────┘

Electron Main Process
  ├── Session Manager         ← session.fromPartition() Cookie 隔离
  ├── PartitionId 对照表       ← 外部别名 ↔ 内部分区，rename 零成本
  ├── Cookie Watcher          ← 监听变更，快照去重，实时推送
  ├── BrowserView Manager     ← 标签页增删切换
  └── IPC Handlers            ← 主进程 ↔ shell / Vue 网站通信
```

## Cookie 隔离原理

`session.fromPartition('persist:{partitionId}')` 为每个 Session 创建独立的持久化存储：

| 特性 | 说明 |
|------|------|
| **隔离范围** | Cookie、LocalStorage、SessionStorage、缓存、IndexedDB |
| **持久化** | `persist:` 前缀确保数据写入磁盘，应用重启后保留 |
| **稳定分区** | `partitionId` 在 Session 创建时生成，`rename` 不改它 |

## API 参考

### 1. switch(sessionId, url)

创建新标签或切换到已有标签：

- **sessionId 不存在** → 自动创建，独立分区，全新 Cookie
- **sessionId 已存在** → 切换到已有标签

```js
await window.electronAPI.switch('user-1', 'https://example.com')
```

### 2. rename(oldName, newName)

重命名 Session，只改外部别名，分区不变，无需迁移 Cookie：

```js
const result = await window.electronAPI.rename('user-1', 'user-renamed')
// result.success → true/false
```

### 3. stop(event, sessionId)

停止某个 Session 的 Cookie 监听：

```js
await window.electronAPI.stop('cookie', 'user-1')
```

### 4. push('cookie', callback)

订阅 Cookie 推送（快照去重，有变化才推，数据始终全量）：

```js
window.electronAPI.push('cookie', (data) => {
  // data.sessionId  — 哪个 Session
  // data.cookies    — 全量 Cookie 数组
  console.log(data.sessionId, data.cookies)
})
```

### 5. push('url', callback)

订阅 URL 变化推送：

```js
window.electronAPI.push('url', (data) => {
  // data.sessionId
  // data.url        — 完整 URL
  // data.domain     — 解析后的域名
})
```

## 配置

`package.json` 的 `config` 中配置目标 URL：

```json
{
  "config": {
    "targetURL": "http://localhost:15000/",
    "prodURL": "https://shangou.muchen.store"
  }
}
```

## 反检测域名

在 `main/ipc-handlers.js` 中配置：

```js
const antiDetectionDomains = ['koubei.com', 'e.koubei.com', 'ele.me']
```

匹配到的域名使用 `contextIsolation: false` + `session-preload.js` 多策略 patch，其他域名使用标准纯净模式。
