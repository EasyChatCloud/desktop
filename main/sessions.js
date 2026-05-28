const fs = require('fs')
const path = require('path')
const { app } = require('electron')

let _dataPath = null

function dataPath() {
  if (!_dataPath) {
    _dataPath = path.join(app.getPath('userData'), 'sessions.json')
  }
  return _dataPath
}

function load() {
  try {
    if (fs.existsSync(dataPath())) {
      return JSON.parse(fs.readFileSync(dataPath(), 'utf-8'))
    }
  } catch (_) {}
  return { sessions: {}, activeSessionId: null, sessionOrder: [] }
}

function save(data) {
  fs.writeFileSync(dataPath(), JSON.stringify(data, null, 2), 'utf-8')
}

function generatePartitionId() {
  return `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function get(sessionId) {
  const data = load()
  return data.sessions[sessionId] || null
}

function getAll() {
  const data = load()
  return data.sessionOrder.map(id => data.sessions[id]).filter(Boolean)
}

function getPartitionId(sessionId) {
  const s = get(sessionId)
  return s ? s.partitionId : sessionId
}

function create(sessionId, url) {
  const data = load()
  if (!data.sessions[sessionId]) {
    data.sessions[sessionId] = {
      sessionId,
      partitionId: generatePartitionId(),
      url,
      createdAt: Date.now()
    }
    data.sessionOrder.unshift(sessionId)
  } else {
    data.sessions[sessionId].url = url
  }
  data.activeSessionId = sessionId
  save(data)
  return data.sessions[sessionId]
}

function setActive(sessionId) {
  const data = load()
  data.activeSessionId = sessionId
  save(data)
}

function getActive() {
  const data = load()
  return data.activeSessionId
}

function remove(sessionId) {
  const data = load()
  if (!data.sessions[sessionId]) return false
  delete data.sessions[sessionId]
  data.sessionOrder = data.sessionOrder.filter(id => id !== sessionId)
  if (data.activeSessionId === sessionId) data.activeSessionId = null
  save(data)
  return true
}

function rename(oldName, newName) {
  const data = load()
  if (!data.sessions[oldName] || oldName === newName) return false
  // Preserve partitionId — only change the display name
  data.sessions[newName] = { ...data.sessions[oldName], sessionId: newName }
  delete data.sessions[oldName]
  data.sessionOrder = data.sessionOrder.map(id => id === oldName ? newName : id)
  if (data.activeSessionId === oldName) {
    data.activeSessionId = newName
  }
  save(data)
  return true
}

module.exports = { get, getAll, getPartitionId, create, setActive, getActive, rename, remove }
