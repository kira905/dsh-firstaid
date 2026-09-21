#!/usr/bin/env node
/**
 * timeline.mjs —— 改动时间轴
 *
 * 一句话：把散落各处的改动压成一条时间线，每条给出「回滚入口 + 备份是否存在」，缺备份的标红且禁一键。
 *
 * 数据源：
 *   ① 变更流水 `<变更流水目录>/YYYY-MM.md` —— **行首 `- <时间>` 为条目起点，续行归上一块，字段用 `｜` 分隔**
 *   ② 回滚点根目录的时间戳目录名 —— **兜底**：有备份无流水 → 标「未登记改动」（既兜底、又暴露漏记）
 *   ③ 恢复脚本所在 = 落地目录（FIRSTAID_LANDING，默认 <home>/landing）
 *
 * 硬要求：
 *   · 逐项自检备份是否存在；缺备份 **标红且禁止「一键回滚」**（不许假装能回滚）；
 *   · 未过演练的恢复脚本一律标「未演练」，**不得**列为可一键执行项；
 *   · 载体口径：回滚点根为权威源、时间轴为视图（索引为入口）。
 *
 * 只读：本脚本不写、不改、不删任何生产文件；`--run` 默认只做**执行前预检与快照计划**，不真跑。
 *
 * 用法：
 *   node timeline.mjs [--days 7] [--json] [--all] [--limit 40] [--no-archive] [--run <序号>] [--help]
 *
 * 退出码（语义写死，供上层的急救台复用）：
 *   0 = 正常（无缺备份项）；1 = 有异常（存在标红项：备份缺失 / 应回滚却无入口）；2 = 用法错误；3 = 环境不可用
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import {
  CHANGELOG_DIR, archiveRoot, landingDir, restoreScriptCandidates,
  isDir, isFile, readTextSafe, readJsonSafe, shortTime, humanTime, hostName, safeRealpath, writeArtifact,
} from './lib/common.mjs'
import { resolveDeviceTags } from './lib/runtime-config.mjs'

const EXIT_OK = 0
const EXIT_BAD = 1
const EXIT_USAGE = 2
const EXIT_ENV = 3

// ─────────────────────────── ① 变更流水解析（F3 口径） ───────────────────────────
/**
 * 条目起点（F3 口径）：行首 `- <HH:MM>`。
 *   · 分隔符只允许显式白名单（空格/【/[/（，**bold** 等）——**绝不写 `[^\d]?`**：
 *     那会贪婪吞掉标题首字（2026-09-12 实测：`- 09:00 夹具条目…` 被解析成 `具条目…`）。
 *   · 冒号后只有恰好 2 位「数字或 x」才算时间（`13:5x` 归一为 13:50；`25:00` 视为无时间）。
 *   · `- HH:MM-HH:MM` 取起点时间。
 */
const RE_ITEM = /^-\s+(\d{1,2}):([0-9x]{2})(?::[0-9x]{2})?(?:\s*[-–~]\s*\d{1,2}:[0-9x]{2})?\s*[（(【\[]?\s*(?:\*+)?\s*(.*)$/
const RE_DATE_HEAD = /^##\s*(\d{1,2})-(\d{1,2})/
const RE_RESTORE = /restore-[A-Za-z0-9._-]+\.(?:cmd|mjs|ps1)/gi
const RE_ARCHIVE = /_archive[\\/]([^\s｜|，,、；;）)（(【】[\]<>"'`＊*+＋]+)/g
const RE_DATE_INLINE = /(\d{4})-(\d{2})-(\d{2})/
const RE_PLAIN_DATE = /(?:^|[^\d])(\d{2})-(\d{2})(?:\s+D|$|\s)/

function normalizeX(s) { return s ? s.replace(/x/gi, '0') : s }

/**
 * 解析一份流水文件 → { entries: [...], issues: [...] }
 * 条目：{ date(MM-DD|YYYY-MM-DD), time(HH:MM), text, fields[], line, source }
 */
export function parseChangelog(text, { source = 'changelog', year = new Date().getFullYear() } = {}) {
  const entries = []
  const issues = []
  let curHead = null // 由 `## MM-DD` 段头给出
  let cur = null
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')

  const flush = () => { if (cur) { entries.push(cur); cur = null } }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.replace(/\s+$/, '')
    const head = RE_DATE_HEAD.exec(line.trim())
    if (head) {
      flush()
      curHead = `${head[1].padStart(2, '0')}-${head[2].padStart(2, '0')}`
      continue
    }
    if (!line.startsWith('-')) {
      // 续行：归上一块（表格行/引用行则忽略）
      if (cur && !line.startsWith('|') && !line.startsWith('#') && line.trim() !== '' && !line.startsWith('>')) {
        cur.lines.push(line.replace(/^\s+/, ''))
        cur.text += ' ' + line.trim()
      }
      continue
    }
    const m = RE_ITEM.exec(line)
    if (!m) {
      // 行首是 `-` 但拿不到合法 HH:MM → 不算条目，但记为解析提示（不静默）
      const loose = /^-\s+([^\s]+)/.exec(line)
      if (loose && /\d{1,2}[:：]\d{2}/.test(loose[1])) {
        issues.push({ line: i + 1, reason: `时间戳无法解析为 HH:MM：${loose[1]}`, raw: line.slice(0, 120) })
      }
      continue
    }
    flush()
    let hh = Number(m[1])
    let mm = Number(normalizeX(m[2] ?? '00'))
    if (hh > 23 || mm > 59) {   // 非法时间：记提示，仍保留条目（时间置 null，按段序排）
      issues.push({ line: i + 1, reason: `时间越界：${m[1]}:${m[2]}`, raw: line.slice(0, 120) })
      hh = -1; mm = 0
    }
    cur = {
      date: curHead,                 // 段头日期（可能为 null → 由调用方补）
      time: hh < 0 ? null : `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
      text: (m[3] || '').trim(),
      lines: [line],
      source,
      lineNo: i + 1,
      year,
    }
  }
  flush()

  // 后处理：抽字段 / 抽日期 / 抽回滚入口候选
  for (const e of entries) {
    e.text = stripNoisePrefix(e.text)
    e.fields = e.text.split(/\s*｜\s*|\s*\|\s*/).map((s) => s.trim()).filter(Boolean)
    const d = RE_DATE_INLINE.exec(e.text)
    if (d) e.date = `${d[1]}-${d[2]}-${d[3]}`
    else if (!e.date) {
      const pd = RE_PLAIN_DATE.exec(e.text)
      if (pd) e.date = `${pd[1]}-${pd[2]}`
      else e.date = null
    }
    e.restoreNames = unique((e.text.match(RE_RESTORE) || []).map((s) => s.trim()))
    e.archiveRefs = extractBackupRefs(e.text)
    e.restoreNames = e.restoreNames.filter((n) => !/^restore-<|xxx/i.test(n))
    // 段头只给 MM-DD → 用条目自己的年份补全（跨年流水也不会错）
    if (e.date && /^\d{2}-\d{2}$/.test(e.date)) e.date = `${e.year || year}-${e.date}`
    else if (!e.date) {
      // 无段头日期时：先看条目内联日期（已处理），否则沿用上一条
      e.date = null
    }
  }
  // 兜底：仍无日期 → 沿用上一条（段内顺序）
  let last = null
  for (const e of entries) {
    if (!e.date) e.date = last
    last = e.date
  }
  return { entries, issues }
}
function unique(a) { return [...new Set(a)] }

/**
 * 剥掉条目开头的噪声前缀（不改语义，只让标题可读）：
 *   · 设备/主机标记：`[TAG]` `【设备：TAG】` `]TAG]`（前导 `[` 被时间分隔符吃掉后残留的形态）
 *   · 时间/日期补记：`00:06-00:30 ` `09-11 16:49 ` `2026-09-11 12:00 `
 *   这两类前缀在流水里很常见，留在标题里纯噪声。
 *   ⚠️ 具体设备短码**只能靠注入**（FIRSTAID_DEVICE_TAGS，多值），包里一个字都不写；
 *      未注入时仍会剥「通用方括号前缀」与「设备：xxx」形态（与具体环境无关的形态规则）。
 */
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export function stripNoisePrefix(text, depth = 0) {
  let t = String(text)
  if (depth > 6) return t.trim()
  const before = t
  t = t.replace(/^[\s*]*[\]】)]\s*/, '')                                   // 残留右括号
  t = t.replace(/^[\s*]*(?:\[[^\]]{0,24}\]|【[^】]{0,24}】)\s*/, '')          // [xx] / 【xx】
  t = t.replace(/^[\s*]*(?:设备|主机|机器)\s*[:：]\s*[^\s，,、｜|：:】\]]{1,12}[\s*]*(?:[\]】)]\s*)?/, '') // 设备：WS-01】 / 设备：工作 WS-01
  const tags = resolveDeviceTags()
  if (tags.length) {
    // 注入的设备短码（例如残留形态 `WS-01]` / 【设备：WS-01】）
    const re = new RegExp('^[\\s*]*(?:' + tags.map(escapeRe).join('|') + ')\\s*(?:\\]|】|\\))?\\s*', 'i')
    t = t.replace(re, '')
  }
  t = t.replace(/^\*+\s*/, '')
  t = t.replace(/^(?:20\d{2}-)?\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}\s*(?:[-–~]\s*\d{1,2}:\d{2})?\s+/, '') // 09-11 16:49 /
  t = t.replace(/^\d{1,2}:\d{2}\s*(?:[-–~]\s*\d{1,2}:\d{2})?\s+/, '')        // 00:06-00:30 /
  if (t === before) return t.trim()
  return stripNoisePrefix(t, depth + 1)
}

/**
 * 备份线索抽取（细粒度）：
 *   从条目文本里抓 `_archive\<第一段>` 作为**回滚点候选**，只保留「第一段看起来像回滚点名」的：
 *     有日期戳（xxx-20260912-0045）或以 `restore-` 开头（xxx/restore-x.cmd）。
 *   这样能挡掉 `_archive\_tmp\generated\...` 这类**路径列举噪声**——否则会把正常条目误判成「备份缺失」，
 *   而「备份缺失」是要标红禁一键的硬判据，宁可少判也不许误判（验收 2）。
 */
/** 条目里紧跟在路径后的「下个字段名」——遇到它就该判定路径结束（流水字段用 `｜`，但常有人写 `|恢复：` 紧贴） */const RE_FIELD_WORD = /(恢复|回滚|备份|文件|位置|说明|来源|验收|副|注)/
const RE_BACKUP_NAME = /(^|[-_])(?:20\d{6}|restore-)/i
export function extractBackupRefs(text) {
  const out = []
  for (const m of String(text).matchAll(RE_ARCHIVE)) {
    // 捕获组是「可能越过词边界的路径候选」——先在字段词/恢复词处截断，再补全尾部的 `\side` 这类子路径
    let rel = String(m[1] || '')
    const cut = RE_FIELD_WORD.exec(rel)
    if (cut) rel = rel.slice(0, cut.index)
    rel = rel.replace(/[\\/]+$/, '')
    if (!rel) continue
    const head = rel.split(/[\\/]/)[0]
    if (RE_BACKUP_NAME.test(head)) out.push(rel)
  }
  return unique(out)
}

/** 流水文件：docs\变更流水\YYYY-MM.md（按月文件，跨月取多份） */
export function listChangelogFiles(days, now = new Date()) {
  const out = []
  let names = []
  try { names = fs.readdirSync(CHANGELOG_DIR) } catch { return out }
  for (const n of names) {
    if (!/^\d{4}-\d{2}\.md$/.test(n)) continue
    const p = path.join(CHANGELOG_DIR, n)
    let st
    try { st = fs.statSync(p) } catch { continue }
    out.push({ path: p, name: n, mtimeMs: st.mtimeMs })
  }
  // 只取「可能覆盖窗口」的月文件：mtime 在窗口内、或月份等于当前/上个月
  const ym = new Set()
  for (let i = 0; i <= Math.ceil(days / 28) + 1; i++) {
    const d = new Date(now.getTime() - i * 28 * 86400000)
    ym.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  return out.filter((f) => ym.has(f.name.replace(/\.md$/, '')) || f.mtimeMs >= now.getTime() - days * 86400000)
}

// ─────────────────────────── ② 回滚点根兜底 ───────────────────────────
const RE_DIR_TS = /(20\d{2})(\d{2})(\d{2})[-_]?(\d{2})(\d{2})(\d{2})?/

/** 从目录名解析时间戳；失败返回 null（无时间戳的目录不进时间轴，另由统计口径暴露） */
export function parseDirStamp(name, year = new Date().getFullYear()) {
  const m = RE_DIR_TS.exec(name)
  if (m) {
    const [, y, mo, d, h, mi] = m
    return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}` }
  }
  // `xxx-MMDD-HHMM` / `xxx-MMDD`（先试带时间的，再试只带日期的）
  const m3 = /(?:^|[-_])(\d{2})(\d{2})[-_](\d{2})(\d{2})(?:$|[-_.])/.exec(name)
  if (m3) {
    const mo = Number(m3[1]); const d = Number(m3[2]); const h = Number(m3[3]); const mi = Number(m3[4])
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h <= 23 && mi <= 59) {
      return { date: `${year}-${m3[1]}-${m3[2]}`, time: `${m3[3]}:${m3[4]}` }
    }
  }
  const m2 = /(?:^|[-_])(\d{2})(\d{2})(?:$|[-_.])/.exec(name)
  if (m2) {
    const mo = Number(m2[1]); const d = Number(m2[2])
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return { date: `${year}-${m2[1]}-${m2[2]}`, time: null }
    }
  }
  return null
}

/** 扫描回滚点目录 → [{ name, path, date, time, mtimeMs, hasRestore, drill }] */
export function scanArchive({ year = new Date().getFullYear() } = {}) {
  const root = archiveRoot()
  if (!root.exists) return { ok: false, reason: `回滚点根不存在或不可达：${root.logical}`, points: [], root }
  let ents = []
  try { ents = fs.readdirSync(root.real, { withFileTypes: true }) } catch (e) {
    return { ok: false, reason: `回滚点根不可读：${e.message}`, points: [], root }
  }
  const points = []
  for (const e of ents) {
    if (!e.isDirectory()) continue
    const p = path.join(root.real, e.name)
    const ts = parseDirStamp(e.name, year)
    let st
    try { st = fs.statSync(p) } catch { continue }
    points.push({
      name: e.name,
      path: p,
      date: ts ? ts.date : null,
      time: ts ? ts.time : null,
      mtimeMs: st.mtimeMs,
      hasRestore: detectRestoreIn(p).length > 0,
      drill: readDrillRecord(p),
    })
  }
  return { ok: true, points, root }
}

/** 回滚点内的恢复脚本（只认 restore-*.{cmd,mjs,ps1}）；filesLower 传入时不再 readdir */
export function detectRestoreIn(dir, filesLower = null) {
  let names = []
  if (filesLower) names = [...filesLower]
  else { try { names = fs.readdirSync(dir) } catch { return [] } }
  const direct = names.filter((n) => /^restore-.*\.(?:cmd|mjs|ps1)$/i.test(n) && !/[\\/]/.test(n))
  if (direct.length) return direct.map((n) => path.join(dir, n))
  if (filesLower) return []          // 有索引时不重复列目录（子目录扫描到此为止，索引只到一层）
  // 子目录一层（有些点把脚本放在子目录里）
  const out = []
  for (const n of names) {
    const p = path.join(dir, n)
    if (!isDir(p)) continue
    let sub = []
    try { sub = fs.readdirSync(p) } catch { continue }
    for (const s of sub) {
      if (/^restore-.*\.(cmd|mjs|ps1)$/i.test(s)) out.push(path.join(p, s))
    }
  }
  return out
}

/** 演练记录：回滚点内 drill-record-*.json，取最新一份 */
export function readDrillRecord(pointDir) {
  const recs = []
  let names = []
  try { names = fs.readdirSync(pointDir) } catch { return { status: 'none' } }
  for (const n of names) {
    if (!/^drill-record-.*\.json$/i.test(n)) continue
    const j = readJsonSafe(path.join(pointDir, n))
    if (j && typeof j === 'object') recs.push({ file: n, mode: j.mode, level: j.level, verdict: j.verdict, time: j.time })
  }
  if (!recs.length) return { status: 'none' }
  const pass = recs.filter((r) => String(r.verdict).toUpperCase() === 'PASS')
  return {
    status: pass.length ? 'pass' : 'fail',
    levels: unique(recs.map((r) => r.level).filter(Boolean)),
    records: recs,
  }
}

// ─────────────────────────── ③ 回滚入口解析与校验 ───────────────────────────
/** 在候选目录里找恢复脚本（落地目录 → 回滚点根 → 回滚点一级子目录；有索引时不重复 readdir） */
export function findRestoreScript(name, extraDirs = [], pointIndex = null, archPoints = null) {
  if (!name) return null
  const dirs = [...restoreScriptCandidates(), ...extraDirs]
  for (const d of dirs) {
    const p = path.join(d, name)
    if (isFile(p)) return p
  }
  const arch = archiveRoot()
  if (arch.exists && pointIndex && archPoints) {
    const want = name.toLowerCase()
    for (const p of archPoints) {
      if (!pointIndex.get(p.name.toLowerCase()).has(want)) continue
      const abs = path.join(p.path, name)
      if (isFile(abs)) return abs
    }
    return null
  }
  if (arch.exists) {
    let ents = []
    try { ents = fs.readdirSync(arch.real, { withFileTypes: true }) } catch { ents = [] }
    for (const e of ents) {
      if (!e.isDirectory()) continue
      const p = path.join(arch.real, e.name, name)
      if (isFile(p)) return p
    }
  }
  return null
}

/** 扫 `_archive` 找条目文本里提到的脚本名（供跨机/别名场景找回滚入口；只读、浅层） */
export function findScriptsByNames(names) {
  const found = new Map()
  if (!names || !names.length) return found
  const arch = archiveRoot()
  if (!arch.exists) return found
  const want = new Set(names.map((n) => n.toLowerCase()))
  let ents = []
  try { ents = fs.readdirSync(arch.real, { withFileTypes: true }).filter((e) => e.isDirectory()) } catch { return found }
  for (const e of ents) {
    const dir = path.join(arch.real, e.name)
    let files = []
    try { files = fs.readdirSync(dir) } catch { continue }
    for (const f of files) {
      if (!want.has(f.toLowerCase())) continue
      if (!found.has(f.toLowerCase())) found.set(f.toLowerCase(), path.join(dir, f))
    }
  }
  return found
}

/**
 * 备份存在性（三态，判据可复核）：
 *   present  —— 条目声明的**每一个** `_archive\<点名>` 都实测存在且非空；
 *   partial  —— 部分声明存在、部分不存在（危险态：回滚会只回落一半）→ 禁一键；
 *   missing  —— 声明的备份线索**全都不在本机**（跨机同步来的条目常见：备份在对端机）；
 *   unknown  —— 条目里**没有任何**备份线索（那时问题是不知备份在哪，不是「备份没了」）。
 * 独立线索「恢复脚本真实存在」不改变 backup 状态，只决定 hasEntry（有无可执行入口）——
 *   因为脚本能跑 ≠ 备份在（脚本对空目录跑照样失败）。
 */
/** 回滚点内现存文件的缓存（点目录名小写 → 文件名小写集合）。
 *  一次 readdir 换掉「每条流水都去扫回滚点」的 O(条目 × 点数) 行为 ——
 *  实测：无缓存时时间轴一次要十几秒（未登记分支对每个回滚点重复 readdir，其中还有超大目录）；
 *  加缓存后降到秒级。只读、进程内有效。 */
export function buildPointIndex(points) {
  const index = new Map()
  for (const p of points || []) {
    let files = []
    try { files = fs.readdirSync(p.path) } catch { files = [] }
    index.set(p.name.toLowerCase(), new Set(files.map((f) => f.toLowerCase())))
  }
  return index
}

export function checkBackup(entry, { scriptPath, pointsByName, pointIndex, useCache = false } = {}) {
  const root = archiveRoot()
  const checked = []
  for (const ref of entry.archiveRefs || []) {
    const rel = String(ref).split(/[\\/]/).filter(Boolean)
    if (!rel.length) continue
    const abs = path.join(root.real, ...rel)
    const inIndex = !!(pointIndex && pointIndex.has(rel[0].toLowerCase()))
    let exists = false
    let detail = ''
    if (rel.length > 1 && !inIndex && !isDir(path.join(root.real, rel[0]))) {
      // 多段引用，但回滚点本身不存在 → 这是「路径列举噪声」（如 `_archive\_tmp\generated\...`），
      // 不参与备份存在性判定，否则会把正常条目误判成「备份缺失」（而它要标红禁一键，宁少不误）
      checked.push({ ref: rel.join('\\'), abs, exists: false, detail: '（非回滚点引用，已忽略）', ignored: true })
      continue
    }
    if (useCache && rel.length === 1 && inIndex) {
      const n = pointIndex.get(rel[0].toLowerCase()).size
      exists = n > 0
      detail = n > 0 ? `目录存在（${n} 项 · 缓存）` : '目录存在但为空'
    } else if (isFile(abs)) { exists = true; detail = '文件存在' } else if (isDir(abs)) {
      let n = 0
      try { n = fs.readdirSync(abs).length } catch { n = -1 }
      exists = n > 0
      detail = n > 0 ? `目录存在（${n} 项）` : '目录存在但为空'
    } else detail = '不存在'
    checked.push({ ref: rel.join('\\'), abs, exists, detail })
  }
  const effective = checked.filter((c) => !c.ignored)
  let scriptPoint = null
  if (scriptPath && root.exists) {
    const rel = path.relative(root.real, scriptPath)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      scriptPoint = rel.split(path.sep)[0]
      const abs = path.join(root.real, scriptPoint)
      if (!checked.some((c) => c.ref === scriptPoint)) {
        checked.push({ ref: scriptPoint, abs, exists: isDir(abs), detail: isDir(abs) ? '（脚本所在回滚点）' : '（脚本所在回滚点缺失）' })
      }
    }
  }
  if (!effective.length) return { status: 'unknown', items: checked, point: scriptPoint || null }
  const okN = effective.filter((c) => c.exists).length
  const status = okN === effective.length ? 'present' : (okN === 0 ? 'missing' : 'partial')
  return { status, items: checked, point: scriptPoint || (effective[0] ? String(effective[0].ref).split(/[\\/]/)[0] : null) }
}

// ─────────────────────────── ④ 组装时间轴 ───────────────────────────
const YMD = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export function buildTimeline({ days = 7, now = new Date(), includeArchive = true, includeUndated = true } = {}) {
  // 可选阶段计时（DSH_FIRSTAID_TIMING=1 时打到 stderr）——性能回归时不用猜
  const timing = !!process.env.DSH_FIRSTAID_TIMING
  const marks = []
  let tPrev = timing ? performance.now() : 0
  const mark = (label) => {
    if (!timing) return
    const t = performance.now()
    marks.push(`${label}=${(t - tPrev).toFixed(0)}ms`)
    tPrev = t
  }
  const files = listChangelogFiles(days, now)
  const entries = []
  const issues = []
  for (const f of files) {
    const text = readTextSafe(f.path)
    if (text === null) { issues.push({ file: f.path, reason: '读取失败' }); continue }
    const r = parseChangelog(text, { source: f.name, year: Number(f.name.slice(0, 4)) || now.getFullYear() })
    entries.push(...r.entries)
    for (const i of r.issues) issues.push({ file: f.name, ...i })
  }
  // 补日期：段头只给 MM-DD → 补上年份；无日期的条目按段内顺序沿用上一条
  const curYear = now.getFullYear()
  let lastDate = null
  for (const e of entries) {
    if (e.date && /^\d{2}-\d{2}$/.test(e.date)) e.date = `${curYear}-${e.date}`
    if (!e.date) e.date = lastDate || YMD(now)
    lastDate = e.date
  }

  const arch = includeArchive ? scanArchive({ year: now.getFullYear() }) : { ok: false, reason: '已用 --no-archive 跳过', points: [], root: archiveRoot() }
  mark('scanArchive')
  const pointsByName = new Map()
  for (const p of arch.points || []) pointsByName.set(p.name.toLowerCase(), p)

  // 窗口过滤（按日期）
  const from = new Date(now.getTime() - days * 86400000)
  const fromYmd = YMD(from)
  const norm = (d) => (d && d.length === 5 ? `${now.getFullYear()}-${d}` : d)
  const inWin = (d) => { const nd = norm(d); return !!nd && nd >= fromYmd }

  const items = []
  let scriptCache = null
  const pointIndex = arch.ok === false ? null : buildPointIndex(arch.points)
  for (const e of entries) {
    if (!inWin(e.date)) continue
    let scriptPath = null
    if (e.restoreNames.length) {
      // ① 先查落地目录（最常见）→ ② 再查一次批量扫出来的回滚点索引（O(1)，避免每条都列一遍回滚点目录）
      scriptPath = findRestoreScript(e.restoreNames[0], [], pointIndex, arch.points)
      if (!scriptPath) {
        if (!scriptCache) scriptCache = findScriptsByNames(entries.flatMap((x) => x.restoreNames || []))
        for (const n of e.restoreNames) {
          const hit = scriptCache.get(n.toLowerCase())
          if (hit) { scriptPath = hit; break }
        }
      }
    }
    const backup = checkBackup(e, { scriptPath, pointsByName, pointIndex, useCache: !!pointIndex })
    const point = backup.point ? pointsByName.get(String(backup.point).toLowerCase()) : null
    const drill = point ? point.drill : { status: 'unknown' }
    const entryStatus = !scriptPath
      ? (backup.status === 'present' || backup.status === 'partial' ? 'no-entry' : backup.status)
      : backup.status
    const blocker = entryStatus === 'missing'
      ? '备份不在本机 → 禁止一键回滚（跨机同步来的条目，备份多半在对端机）'
      : entryStatus === 'partial'
        ? '备份只找到一部分 → 禁止一键回滚（回滚会只回落一半）'
        : entryStatus === 'no-entry'
          ? '未登记回滚入口（流水里没有 restore-*，备份在但不知怎么回）'
          : entryStatus === 'unknown'
            ? '备份位置未知（流水没写备份在哪）→ 先人工核对'
            : (!drill || drill.status !== 'pass' ? '未过演练：不列为可一键执行项' : null)
    items.push({
      kind: 'entry',
      date: norm(e.date),
      time: e.time,
      title: titleOf(e),
      text: e.text,
      fields: e.fields,
      source: e.source,
      lineNo: e.lineNo,
      restoreName: e.restoreNames[0] || null,
      restoreScript: scriptPath,
      backup,
      drill,
      entryStatus,
      pointName: backup.point || null,
      runnable: !!scriptPath && backup.status === 'present' && !!(drill && drill.status === 'pass'),
      blocker,
      prereqOk: !!scriptPath && backup.status === 'present',
    })
  }

  // 兜底：有备份无流水
  mark('entriesLoop')
  const matchedPointNames = new Set()
  for (const it of items) if (it.pointName) matchedPointNames.add(String(it.pointName).toLowerCase())
  // 二次关联：目录 stub 出现在条目文本里也算已登记（流水常写备份目录名）
  for (const p of arch.points || []) {
    if (matchedPointNames.has(p.name.toLowerCase())) continue
    const stub = p.name.replace(RE_DIR_TS, '').replace(/^[-_]+|[-_]+$/g, '').toLowerCase()
    if (stub.length >= 6 && entries.some((e) => inWin(e.date) && e.text.toLowerCase().includes(stub))) {
      matchedPointNames.add(p.name.toLowerCase())
    }
  }
  const unregistered = []
  if (includeArchive && arch.ok !== false) {
    for (const p of arch.points) {
      if (!p.date) continue                     // 无时间戳 → 不进时间轴
      if (p.date < fromYmd) continue
      if (matchedPointNames.has(p.name.toLowerCase())) continue
      const recScripts = detectRestoreIn(p.path, pointIndex ? pointIndex.get(p.name.toLowerCase()) : null)
      const firstName = recScripts.length ? path.basename(recScripts[0]) : null
      unregistered.push({
        kind: 'unregistered',
        date: p.date,
        time: p.time,
        title: `未登记改动（有备份无流水）：${p.name}`,
        text: `回滚点 ${p.name} 存在但变更流水里查不到对应条目 —— 兜底命中，说明这次改动**漏记了流水**`,
        pointName: p.name,
        pointPath: p.path,
        restoreName: firstName,
        restoreScript: recScripts.length ? recScripts[0] : null,
        backup: { status: 'present', items: [{ ref: p.name, abs: p.path, exists: true, detail: '（兜底命中）' }], point: p.name },
        drill: p.drill,
        runnable: false,
        blocker: '未登记改动（有备份无流水）→ 不列为一键项；需人工核对该点恢复什么',
        warn: true,
      })
    }
  }

  const all = [...items, ...(includeUndated ? unregistered : [])]
    .sort((a, b) => {
      const ka = `${a.date} ${a.time || '00:00'}`
      const kb = `${b.date} ${b.time || '00:00'}`
      if (ka === kb) return (a.kind === 'unregistered' ? 0 : 1) - (b.kind === 'unregistered' ? 0 : 1)
      return kb.localeCompare(ka)   // 最新在最上
    })

  const bad = all.filter((x) => x.kind === 'entry' && (x.entryStatus === 'missing' || x.entryStatus === 'partial'))
  const noEntry = all.filter((x) => x.kind === 'entry' && !x.restoreScript)
  mark('stubUnregistered')
  if (timing) console.error(`[timing] ${marks.join(' ')}`)
  return {
    now, days, fromYmd, files: files.map((f) => f.name), items: all,
    issues, archive: { ok: arch.ok, reason: arch.reason, root: arch.root, points: (arch.points || []).length },
    stats: {
      entries: items.length,
      unregistered: unregistered.length,
      backupMissing: bad.length,
      noRestoreEntry: noEntry.length,
      notDrilled: all.filter((x) => x.pointName && x.drill && x.drill.status !== 'pass').length,
      runnable: all.filter((x) => x.runnable).length,
      prereqOk: all.filter((x) => x.prereqOk).length,
    },
  }
}

/** 条目标题：去掉 [标记]/粗体/【设备：xxx】 之类的噪声前缀，截到 84 字符
 *  （流水里常见 `- 22:06 [标记] 说明…` —— 段首方括号可能被前导分隔符吃掉，故此处允许残留 `]` 一起清掉） */
export function titleOf(e) {
  let t = String(e.fields[0] || e.text || '')
  t = t.replace(/^\*+\s*/, '')
  t = t.replace(/^\](?=\S)/, '')                                  // 前导分隔符剥掉 `[` 后残留的 `]`
  t = t.replace(/^(?:\[[^\]]{0,24}\]\s*)+/, '')     // 通用方括号前缀（含注入的设备短码）
  t = t.replace(/^【设备：[^】]*】\s*/, '')
  t = t.replace(/^\*+\s*/, '')
  t = t.replace(/\*+$/, '')
  t = t.trim()
  if (!t) t = String(e.text || '').slice(0, 84)
  return t.slice(0, 84)
}

/** 显式 --out：写到指定文件（急救台症状 3 用它落时间轴副本） */
function writeTo(file, content) {
  try {
    const p = path.isAbsolute(file) ? file : path.resolve(file)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content, 'utf8')
    return { ok: true, path: p, degraded: false }
  } catch (e) {
    return { ok: false, path: null, error: `写入 ${file} 失败：${e.message}` }
  }
}

// ─────────────────────────── ⑤ 渲染（人读） ───────────────────────────
export function renderTimeline(tl, { limit = 40 } = {}) {
  const L = []
  L.push('# 改动时间轴（最近 ' + tl.days + ' 天）')
  L.push('')
  L.push(`- 生成时间：${humanTime()} · 设备 ${hostName()}`)
  L.push(`- 数据源：${tl.files.join(', ') || '（无）'} + 回滚点根兜底`)
  L.push(`- 回滚入口目录：${landingDir().path}`)
  L.push('')
  L.push(`**统计**：流水条目 ${tl.stats.entries} · 未登记改动 ${tl.stats.unregistered} · 🔴备份不在本机 ${tl.stats.backupMissing} · 无一键入口 ${tl.stats.noRestoreEntry} · 前置齐(脚本+备份) ${tl.stats.prereqOk} · ✅可一键 ${tl.stats.runnable}`)
  L.push('')
  const shown = tl.items.slice(0, limit)
  for (const [i, it] of shown.entries()) {
    const seq = String(i + 1).padStart(2, '0')
    const when = `${String(it.date).slice(5)} ${it.time || '--:--'}`
    let flag
    if (it.kind === 'unregistered') flag = '⚠ 未登记改动'
    else if (it.entryStatus === 'missing') flag = '🔴 备份不在本机'
    else if (it.entryStatus === 'partial') flag = '🔴 备份只找到一部分'
    else if (it.entryStatus === 'no-entry') flag = '🟡 备份在·无一键入口'
    else if (it.entryStatus === 'unknown') flag = '🟡 备份位置未知'
    else flag = '🟢 备份在'
    const drillTxt = it.drill && it.drill.status === 'pass' ? ' · 已演练'
      : (it.drill && it.drill.status === 'fail' ? ' · ⚠演练 FAIL' : '')
    const entry = it.restoreName ? `restore: ${it.restoreName}` : '回滚: （无一键入口）'
    L.push(`${seq}. [${when}] ${it.title}`)
    L.push(`      → ${entry}  [${flag}${drillTxt}]${it.restoreScript ? '' : '  ⛔无入口'}`)
    if (it.blocker) L.push(`      ⛔ ${it.blocker}`)
  }
  if (tl.items.length > shown.length) L.push(`… 另有 ${tl.items.length - shown.length} 条（用 --limit 调整）`)
  L.push('')
  L.push('## 怎么用')
  L.push('')
  L.push('- 想撤销某次改动 → 找到对应序号，先看 🟢/🔴/⚠：**🔴 备份缺失与 ⚠ 未登记改动都不可一键回滚**。')
  L.push('- `--run <序号>` 默认**只做执行前预检与写前快照计划**，不真跑；真执行需在同一次命令上加 `--yes`。')
  L.push('- 没有一键入口、或看不懂该选哪条 → **把本报告交给 agent**（急救台症状 5 会一并打包）。')
  L.push('')
  if (tl.issues.length) {
    L.push('## 解析提示（非故障）')
    L.push('')
    for (const i of tl.issues.slice(0, 20)) L.push(`- ${i.file || ''}${i.line ? ` 第 ${i.line} 行` : ''}：${i.reason}`)
    L.push('')
  }
  return L.join('\n')
}

// ─────────────────────────── ⑥ 执行前预检（写前快照） ───────────────────────────
/**
 * 只做预检 + 快照计划，**不动手**。真执行要在同一条命令上加 --yes（二次确认）。
 * 三道门：① 恢复脚本存在 ② 备份存在 ③ 演练记录 PASS（未演练不得列为一键执行项）。
 */
export function preflightRun(tl, seq) {
  const it = tl.items[Number(seq) - 1]
  if (!it) return { ok: false, reason: `序号 ${seq} 不存在（共 ${tl.items.length} 条）` }
  const gates = []
  gates.push({ name: '可执行入口存在', ok: !!it.restoreScript, detail: it.restoreScript || (it.restoreName ? `流水提到 ${it.restoreName}，但本机找不到` : '流水里没有 restore-* 入口') })
  gates.push({
    name: '备份在本机且完整',
    ok: it.backup.status === 'present',
    detail: it.backup.items.map((c) => `${c.ref}:${c.detail}`).join(' / ') || '无备份线索（流水没写备份在哪）',
  })
  gates.push({
    name: '已过演练（凭 drill-record 记录）',
    ok: !!(it.drill && it.drill.status === 'pass'),
    detail: it.drill && it.drill.status === 'pass'
      ? `记录 ${it.drill.records.map((r) => r.file).join(', ')}`
      : '回滚点内无 PASS 演练记录 → 未演练，不得一键',
  })
  const pass = gates.every((g) => g.ok)
  return { ok: pass, item: it, gates, blockedBy: it.blocker || null }
}

// ─────────────────────────── ⑦ CLI ───────────────────────────
function usage() {
  return [
    'timeline.mjs —— 改动时间轴（只读）',
    '',
    '用法：node timeline.mjs [选项]',
    '  --days <N>       窗口天数（默认 7）',
    '  --limit <N>      打印条数（默认 40）',
    '  --json           额外输出机器可读 JSON',
    '  --no-archive     不读回滚点根兜底',
    '  --run <序号>     对某条做**执行前预检**（不真跑；加 --yes 才真执行 → 本版本一律拒绝真执行）',
    '  --save           把时间轴存一份到日志目录（timeline-<ts>.md，症状 3 用）',
    '  --out <file>     指定输出文件（配合 --save）',
    '  --help',
    '',
    '退出码：0 正常 · 1 有异常（备份缺失等）· 2 用法 · 3 环境不可用',
  ].join('\n')
}

function parseArgv(argv) {
  const o = { days: 7, limit: 40, json: false, archive: true, run: null, yes: false, save: false, out: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => { const v = argv[++i]; if (v === undefined) { console.error(`✗ 参数 ${a} 缺值`); process.exit(EXIT_USAGE) } return v }
    switch (a) {
      case '--days': o.days = Number(next()); break
      case '--limit': o.limit = Number(next()); break
      case '--json': o.json = true; break
      case '--no-archive': o.archive = false; break
      case '--run': o.run = next(); break
      case '--yes': o.yes = true; break
      case '--save': o.save = true; break
      case '--out': o.out = next(); break
      case '--help': case '-h': o.help = true; break
      default:
        console.error(`✗ 未知参数 ${a}`)
        console.error(usage())
        process.exit(EXIT_USAGE)
    }
  }
  if (!Number.isFinite(o.days) || o.days <= 0) { console.error('✗ --days 必须是正数'); process.exit(EXIT_USAGE) }
  return o
}

async function main() {
  const o = parseArgv(process.argv.slice(2))
  if (o.help) { console.log(usage()); return EXIT_OK }

  const tl = buildTimeline({ days: o.days, includeArchive: o.archive })
  const md = renderTimeline(tl, { limit: o.limit })
  console.log(md)

  if (o.run) {
    const pf = preflightRun(tl, o.run)
    console.log('')
    console.log(`=== --run ${o.run} 执行前预检（写前快照） ===`)
    if (!pf.ok && pf.reason) { console.log(`✗ ${pf.reason}`); return EXIT_USAGE }
    for (const [i, g] of pf.gates.entries()) console.log(`  ${g.ok ? '✓' : '✗'} ${i + 1}. ${g.name}：${g.detail}`)
    console.log(`  预检结论：${pf.ok ? '通过（真执行需人工确认 + 写前快照）' : '未通过 → 禁止一键回滚'}`)
    if (o.yes) {
      console.log('')
      console.log('✗ 本版本**不执行**任何回滚动作（红线：本工具只读诊断；写动作须人工逐步确认）。')
      console.log('  要真回滚：由 agent 按上方预检结果 + 写前快照（_archive\\pre-restore-<ts>\\）后执行。')
      return EXIT_BAD
    }
    return pf.ok ? EXIT_OK : EXIT_BAD
  }

  if (o.save || o.out) {
    const r = o.out ? writeTo(o.out, md) : writeArtifact('timeline', 'md', md)
    if (r.ok) console.log(`\n报告已存：${r.path}${r.degraded ? '（⚠ logs 不可写，已降级到临时目录）' : ''}`)
    else { console.error(`\n✗ ${r.error}`); return EXIT_BAD }
  }

  if (o.json) {
    console.log('')
    console.log(JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      host: hostName(),
      days: tl.days,
      from: tl.fromYmd,
      files: tl.files,
      stats: tl.stats,
      archive: tl.archive,
      items: tl.items.map((it) => ({
        kind: it.kind, date: it.date, time: it.time, title: it.title,
        restoreName: it.restoreName, restoreScript: it.restoreScript,
        backup: { status: it.backup.status, items: it.backup.items },
        drill: { status: it.drill.status, levels: it.drill.levels || [] },
        entryStatus: it.entryStatus,
        prereqOk: it.prereqOk,
        runnable: it.runnable, blocker: it.blocker,
      })),
      issues: tl.issues,
    }, null, 2))
  }

  const bad = tl.stats.backupMissing > 0
  return bad ? EXIT_BAD : EXIT_OK
}

/**
 * CLI 入口守卫：
 *   当工作目录经由符号链接 / junction 进入时，`import.meta.url` 会解析为**物理路径**，
 *   而 `process.argv[1]` 是**用户输入的逻辑路径** → 直接字符串比较永不相等、脚本会**静默退出 0**。
 *   必须双方 realpath 后再比。
 */
function isMainEntry() {
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url))
    const argv1 = process.argv[1] ? fs.realpathSync(process.argv[1]) : ''
    return self.toLowerCase() === argv1.toLowerCase()
  } catch { return false }
}

if (isMainEntry()) {
  main().then((code) => { process.exitCode = code }).catch((e) => {
    console.error(`✗ timeline.mjs 异常：${e && e.message}`)
    console.error(e && e.stack)
    process.exitCode = EXIT_BAD
  })
}

export { EXIT_OK, EXIT_BAD, EXIT_USAGE, EXIT_ENV }
