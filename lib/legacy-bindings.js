// 原档逻辑绑定仅存插件自己的 SQLite 表；不改作者 chat/links/index 或原生日志。
import { DatabaseSync } from 'node:sqlite'
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function legacyBindingsPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh-tavern')
  return path.join(home, 'profile-data', 'tavern', 'storages', 'tavern-sqlite-bindings.db')
}

function rowBinding(row) {
  return row ? { chatId: row.chat_id, sessionId: row.session_id, originalSessionId: row.original_session_id, artifactPath: row.artifact_path } : undefined
}

// 绑定是低频元数据（表很小，通常个位数行）但会被列表/状态/投影多次读取。
// 只缓存**整表快照**这唯一一条（有界），并按库文件指纹失效：外写、换文件、追加、截断、替换，
// 以及只落在 -wal/-journal 里的提交都能识别；本进程写入后立即置空。
// 不按 query 分条缓存、更不单独缓存"某 key 不存在"的结论 —— 避免 stale negative 挡住只读写闸。
const BINDING_CACHE_MS = 1000
// 有界等待：node:sqlite 是同步 API，会阻塞事件循环，绝不使用无界/长超时（含写路径）。
const BINDING_BUSY_TIMEOUT_MS = 2000
let bindingSnapshot = null   // { fingerprint, at, rows }

/**
 * 库文件身份。只用"能可靠反映提交"的信号：
 *   · 头 100 字节里的 file change counter(24) / version-valid-for(92) —— SQLite 每次提交都自增，
 *     不受文件系统 mtime 粒度影响（实测：原地 UPDATE 不改文件大小，某些卷上 mtime 也不动）；
 *   · 文件与 -wal/-journal 的 dev:ino:size:mtimeNs（覆盖换文件、WAL 提交、回滚日志）。
 */
function bindingFingerprint(file) {
  const stat = target => {
    try {
      const info = statSync(target, { bigint: true })
      return info.dev + ':' + info.ino + ':' + info.size + ':' + info.mtimeNs
    } catch { return '-' }
  }
  const counter = (() => {
    try {
      const fd = openSync(file, 'r')
      try {
        const buffer = Buffer.allocUnsafe(100)
        if (readSync(fd, buffer, 0, 100, 0) !== 100) return '-'
        return buffer.readUInt32BE(24) + ':' + buffer.readUInt32BE(92)
      } finally { closeSync(fd) }
    } catch { return '-' }
  })()
  return file + '|' + stat(file) + '|' + counter + '|' + stat(file + '-wal') + '|' + stat(file + '-journal')
}

/** 本进程写入后立即失效；外部写由指纹自动识别，不依赖调用方记得清缓存。 */
function invalidateBindingCache() { bindingSnapshot = null }

/** 读整表快照：缺库/缺表都返回空表（不建目录、不建表、不写文件、不抛底错）。 */
function readBindings() {
  const file = legacyBindingsPath()
  const fingerprint = bindingFingerprint(file)
  const now = Date.now()
  if (bindingSnapshot !== null && bindingSnapshot.fingerprint === fingerprint && now - bindingSnapshot.at < BINDING_CACHE_MS) return bindingSnapshot.rows
  if (!existsSync(file)) {
    bindingSnapshot = { fingerprint, at: now, rows: [] }
    return []
  }
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = ' + BINDING_BUSY_TIMEOUT_MS)
    // 老库/半建库可能没有该表：按"无绑定"返回空，不把底层 no such table 抛给只读视图与写闸。
    const table = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'legacy_bindings'").get()
    const rows = table === undefined ? [] : db.prepare('SELECT * FROM legacy_bindings ORDER BY chat_id').all().map(rowBinding)
    bindingSnapshot = { fingerprint, at: now, rows }
    return rows
  } finally { db.close() }
}

export function listLegacyBindings() {
  return readBindings().map(row => ({ ...row }))
}

export function legacyBindingForChat(chatId) {
  const id = String(chatId || '')
  const row = readBindings().find(binding => binding.chatId === id)
  return row ? { ...row } : undefined
}

export function legacyBindingForSession(sessionId) {
  const id = String(sessionId || '')
  const row = readBindings().find(binding => binding.sessionId === id || binding.originalSessionId === id)
  return row ? { ...row } : undefined
}

// 只供显式部署修复；只读查看没有配置写入或自动推断扫描。
export function setLegacyBinding({ chatId, sessionId, originalSessionId = '', artifactPath }) {
  if (!/^chat-[A-Za-z0-9_-]+$/.test(chatId) || !/^session-[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('原档绑定身份无效')
  if (!path.isAbsolute(artifactPath) || !existsSync(artifactPath)) throw new Error('原档绑定必须指向现存绝对路径')
  const file = legacyBindingsPath()
  mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA busy_timeout = ' + BINDING_BUSY_TIMEOUT_MS)
    db.exec('CREATE TABLE IF NOT EXISTS legacy_bindings (chat_id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, original_session_id TEXT NOT NULL, artifact_path TEXT NOT NULL)')
    db.prepare('INSERT INTO legacy_bindings VALUES (?, ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET session_id=excluded.session_id, original_session_id=excluded.original_session_id, artifact_path=excluded.artifact_path').run(chatId, sessionId, originalSessionId, artifactPath)
  } finally { db.close() }
  invalidateBindingCache()
  return legacyBindingForChat(chatId)
}

export function overlayLegacyLinks(links) {
  const result = { ...(links || {}) }
  for (const binding of listLegacyBindings()) {
    for (const [sessionId, chatId] of Object.entries(result)) if (chatId === binding.chatId) delete result[sessionId]
    result[binding.sessionId] = binding.chatId
  }
  return result
}

export function projectLegacyEnvelope(value) {
  if (!value || typeof value !== 'object') return value
  if (value.chat && typeof value.chat === 'object') {
    const chat = projectLegacyEnvelope(value.chat)
    return chat === value.chat ? value : { ...value, chat }
  }
  const binding = legacyBindingForChat(value.id)
  return binding && value.sessionId !== binding.sessionId ? { ...value, sessionId: binding.sessionId } : value
}
