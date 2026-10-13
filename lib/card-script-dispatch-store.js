// 卡脚本分派标记存储（proposal-card-runtime-full.md A.6.2 自愈）
// 独立运行时元数据缓存：不进存档（卡级属性非对话级）、不写卡文件（玩家资产不可篡改）、
// 不只放内存（重启丢失会让玩家每次重启后 UI 晚一个自愈周期）。
// key 绑脚本内容 hash → 卡更新自动失效重测；文件可丢弃 → 删了系统照常工作（重测即回）。
//
// 2026-10-13 读取加固：旧 :16 `data = JSON.parse(readFileSync(...))` 对**合法但不是对象**的 JSON
//   完全放行 —— `null` / `123` / `"x"` / `true` / `[1,2]` 会各自产生 data=null / 数字 / 字符串 /
//   布尔 / 数组，随后 mark* 里的 `data[...] = {}` 要么抛（null/原始值严格模式赋值）要么写出
//   非对象条目；数组还会被 `typeof` 判成 object 混过读取。本文件是**可丢弃缓存**（文件注释第一条），
//   因此：非 plain object（含 array）一律**丢弃并回落空对象**，不改权威、不做类型转换、不碰 SQLite。
//   `Object.create(null)` 作为容器 + `Object.hasOwn` 只认自有键，同时去掉 `__proto__`/`constructor`
//   这类卡路径的污染面：若容器是 `JSON.parse` 产物（原型 `Object.prototype`），`data['__proto__']`
//   会读到祖先 `Object.prototype`（祖先被误认成卡 entry），`markCard('__proto__')` 更会把标记写到
//   `Object.prototype` 上；故解析结果必须**拷进 null 原型容器**再使用。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'

function text(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

/** 仅接受 plain object（拒 array / null / 数字 / 字符串 / 布尔）—— 其余按"缓存不可用"处理。 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** 可丢弃缓存空容器：无原型 ⇒ 卡路径为 `__proto__`/`constructor` 时也不会污染/串档。 */
function emptyCache() {
  return Object.create(null)
}

/**
 * `JSON.parse` 产物 → **null 原型容器**（只取 own enumerable 字符串键）。
 *
 * 为什么要拷：`JSON.parse('{}')` 的原型是 `Object.prototype` ⇒ 直接当容器用时，卡路径 `"__proto__"`
 * 命中的是 `Object.prototype`（`data['__proto__']` 读祖先 ⇒ 祖先被误认成卡 entry；写
 * `data['__proto__'].__card__ = …` 直接污染 `Object.prototype`）。
 * `Object.entries` 只遍历**自有**可枚举键、`Object.fromEntries` 走 `CreateDataProperty`（不触发
 * `__proto__` setter）⇒ 形状忠实且原型干净的副本，再 `setPrototypeOf(..., null)` 彻底切断祖先。
 */
function toNullProtoCache(source) {
  const own = Object.fromEntries(Object.entries(source))
  Object.setPrototypeOf(own, null)
  return own
}

/** JSON 文本 → null 原型容器；非法 JSON、合法但非 plain object 一律回落空缓存。 */
function decodeCache(raw) {
  let parsed
  try { parsed = JSON.parse(raw) } catch { return emptyCache() }
  return isPlainObject(parsed) ? toNullProtoCache(parsed) : emptyCache()
}

/** 容器内某卡路径的条目：只认**自有**的 plain object；否则就地重建**自有**条目。 */
function cardEntry(container, cardKey) {
  const entry = Object.hasOwn(container, cardKey) ? container[cardKey] : undefined
  if (isPlainObject(entry)) return entry
  const fresh = emptyCache()
  container[cardKey] = fresh
  return fresh
}

/** @deprecated V2现役分派标记存储由 lib/server-dependencies.js 提供；保留公开旧API兼容。 */
export function createCardScriptDispatchStore({ filePath, logger = console }) {
  let data = emptyCache()
  try { data = decodeCache(readFileSync(filePath, 'utf8')) } catch { data = emptyCache() }
  let saveTimer = null

  function persist() {
    if (saveTimer !== null) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      try {
        mkdirSync(dirname(filePath), { recursive: true })
        const payload = JSON.stringify(data, null, 2)
        writeFileSync(filePath + '.tmp', payload)
        writeFileSync(filePath, payload)
      } catch (error) { logger?.warn?.('[card-script-dispatch] 标记落盘失败:', String(error && error.message || error)) }
    }, 50)
  }

  function scriptKey(scriptId, content) {
    return text(scriptId) + ':' + createHash('sha256').update(text(content)).digest('hex').slice(0, 16)
  }

  return {
    scriptHash(content) {
      return createHash('sha256').update(text(content)).digest('hex').slice(0, 16)
    },
    /** 卡级标记（探针在事件钩子期触发、无法定位脚本时的粗粒度兜底） */
    lookupCard(cardPath) {
      const key = text(cardPath)
      const card = Object.hasOwn(data, key) ? data[key] : undefined
      return isPlainObject(card) && isPlainObject(card.__card__) && card.__card__.class === 'browser-ui' ? card.__card__ : null
    },
    markCard(cardPath, reason) {
      const card = cardEntry(data, text(cardPath))
      card.__card__ = { class: 'browser-ui', reason: text(reason), markedAt: Date.now() }
      persist()
    },
    /** 脚本级标记（加载期探针触发，可精确定位脚本） */
    lookupScript(cardPath, scriptId, content) {
      const key = text(cardPath)
      const card = Object.hasOwn(data, key) ? data[key] : undefined
      if (!isPlainObject(card)) return null
      const entryKey = scriptKey(scriptId, content)
      const entry = Object.hasOwn(card, entryKey) ? card[entryKey] : undefined
      return isPlainObject(entry) && entry.class === 'browser-ui' ? entry : null
    },
    markScript(cardPath, scriptId, content, reason) {
      const card = cardEntry(data, text(cardPath))
      card[scriptKey(scriptId, content)] = { class: 'browser-ui', reason: text(reason), markedAt: Date.now() }
      persist()
    }
  }
}
