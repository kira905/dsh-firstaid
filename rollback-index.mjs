#!/usr/bin/env node
/**
 * rollback-index.mjs — 回滚脚本索引生成器
 *
 * 为什么需要它：出事时人只想知道「跑哪个」，而恢复脚本一多就只能靠翻文件名 ⇒ 最后还是去问 AI。
 *   本索引把「脚本名 → 症状 / 影响面 / 前置条件 / 是否演练过」摊平，并接进急救台（症状 3/5 直接给出
 *   本索引路径与未演练计数）。
 *
 * 载体口径：回滚点根为权威源 · 时间轴为视图 · **本索引为入口**。
 * 数据源（全部只读）：
 *   ① 变更流水 → 时间轴（复用 timeline.mjs 的 buildTimeline，含条目↔回滚脚本↔备份三态↔演练记录）
 *   ② 落地目录（landingDir）现存 restore-*.{cmd,mjs,ps1} —— 兜住「有脚本但流水里没写」
 *   ③ 各回滚点内 drill-record-*.json —— **是否演练过**机读推出（不靠人记）
 *   ④ 归档批次目录（<回滚点根>/desktop-restore-archive-*）—— 历史入口按批列出（不逐条膨胀）
 *
 * 命名规范：`restore-<日期>-<一句话>.cmd`，禁止内部代号（形如 `p8-11a` / `b0-decoupling` 这类
 *   只有内部人看得懂的短码）——代号只出现在索引的「内部编号」列里。**本工具只登记与建议，不改名**
 *   （改名会断掉文档/卡片里的引用，必须先全量扫引用再改）。
 *
 * 用法：
 *   node rollback-index.mjs [--days 30] [--limit 200] [--json]
 *   node rollback-index.mjs --write            # 写 <落地目录>/README-回滚索引.md
 *   node rollback-index.mjs --check            # 与现有索引比对（落盘前巡检/收尾用）：一致 0 / 不一致 3
 *   node rollback-index.mjs --out <path>       # 自定义输出路径（默认 = 落地目录/README-回滚索引.md）
 *
 * 退出码：0 正常 / 1 发现异常（备份缺失或索引过期）/ 2 用法错 / 3 环境不可用（--check 不一致）
 * 只读约束：除 `--write` 外**零写入**；不改任何回滚点、不改任何脚本。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { landingDir, archiveRoot, humanTime, hostName, readTextSafe, isDir } from './lib/common.mjs'
import { resolveImpactRules, resolveStopPatterns, resolveRestartPatterns, resolveWorkspace, resolveHome } from './lib/runtime-config.mjs'
import { buildTimeline, readDrillRecord } from './timeline.mjs'

const EXIT_OK = 0
const EXIT_BAD = 1
const EXIT_USAGE = 2
const EXIT_ENV = 3

// ─────────────────────────── 归类与推导规则（纯函数，可单测） ───────────────────────────
/**
 * 影响面分类：先匹配流水文本，再退到脚本内容；都不中 → 未分类。
 * 规则表来自 FIRSTAID_IMPACT_RULES（JSON 数组 `[{"name":"...","pattern":"..."}]`，顺序即优先级）；
 * 未注入时用内置**中性**默认表（只含与具体项目无关的类别），包里不写任何具体组件名。
 */
let _rulesCache = null
let _rulesKey = null
function impactRules() {
  const key = process.env.FIRSTAID_IMPACT_RULES || ''
  if (!_rulesCache || _rulesKey !== key) { _rulesCache = resolveImpactRules(); _rulesKey = key }
  return _rulesCache
}
export function impactOf(...texts) {
  const rules = impactRules()
  for (const t of texts) {
    const s = String(t || '')
    if (!s) continue
    for (const r of rules) if (r.re.test(s)) return r.name
  }
  return '未分类'
}

/**
 * 前置条件：从脚本内容判断要不要停机（这是使用者最关心的第二列）。
 * 停机/重启特征由配置给出（FIRSTAID_STOP_PATTERNS / FIRSTAID_RESTART_PATTERNS，多值正则）；
 * 未注入时用内置中性默认（含 `stop` 的守护/服务停止命令、含 restart/taskkill 的重启命令）。
 */
export function prereqOf(scriptText) {
  const t = String(scriptText || '')
  if (!t) return '（未读到脚本内容）'
  const stop = resolveStopPatterns().some((re) => re.test(t))
  const restart = resolveRestartPatterns().some((re) => re.test(t))
  const admin = /RunAs|管理员|administrator|UAC/i.test(t)
  const parts = []
  if (stop) parts.push('停守护进程')
  if (restart) parts.push('重启服务')
  if (admin) parts.push('需管理员')
  return parts.length ? `需 ${parts.join(' + ')}` : '无需停机（文件级回滚）'
}

/** 内部代号判定（形如 `p8-11a` / `ch1-superset` 这类只有内部人看得懂的短码） */
const CODE_NAME_RE = /^(?:ch|vh|[pbmqhtvasgedlf])\d+(?:[-._]|$)/i
export function isCodeName(fileName) {
  const core = String(fileName || '').replace(/^restore-/i, '').replace(/\.(?:cmd|mjs|ps1)$/i, '')
  return CODE_NAME_RE.test(core)
}

/** 建议命名（只建议不执行）：restore-<日期>-<一句话>.cmd */
export function suggestName(fileName, when) {
  const ext = (String(fileName || '').match(/\.(?:cmd|mjs|ps1)$/i) || ['.cmd'])[0]
  const d = String(when || '').match(/^\d{4}-\d{2}-\d{2}$/) ? when : ''
  const core = String(fileName || '').replace(/^restore-/i, '').replace(/\.(?:cmd|mjs|ps1)$/i, '')
  return `restore-${d ? d.replace(/-/g, '') + '-' : ''}<一句话>.${ext.slice(1)}（现名 core=${core}）`
}

/** 演练状态 → 人类可读（机读来自 drill-record-*.json 的 verdict/level） */
export function drillText(drill) {
  if (!drill || drill.status === 'none') return '❌ 未演练'
  if (drill.status === 'unknown') return '—（无回滚点）'
  const levels = (drill.levels || []).map((l) => String(l).match(/L[123]/)?.[0]).filter(Boolean)
  const uniq = [...new Set(levels)].join('+')
  return drill.status === 'pass' ? `✅ 已演练${uniq ? `（${uniq} PASS）` : ''}` : `🔴 演练 FAIL`
}

function esc(s, max = 0) {
  let t = String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n+/g, ' ')
  if (max && t.length > max) t = t.slice(0, max) + '…'
  return t
}

// ─────────────────────────── 采集 ───────────────────────────
function scriptCache() {
  const cache = new Map()
  return (p) => {
    if (!p) return ''
    if (!cache.has(p)) cache.set(p, readTextSafe(p, 64 * 1024) || '')
    return cache.get(p)
  }
}

/** 回滚点目录名（从脚本绝对路径反推：_archive\<点>\... → 点名） */
function pointOf(scriptPath, root) {
  if (!scriptPath || !root || !root.real) return null
  const rel = path.relative(root.real, scriptPath)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep)[0]
}

function landingScripts() {
  const dir = landingDir()
  if (!dir.exists) return []
  let names = []
  try { names = fs.readdirSync(dir.path) } catch { return [] }
  return names.filter((n) => /^restore-.*\.(?:cmd|mjs|ps1)$/i.test(n)).map((n) => path.join(dir.path, n))
}

function archiveBatches() {
  const root = archiveRoot()
  if (!root || !root.exists) return []
  let ents = []
  try { ents = fs.readdirSync(root.real, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const e of ents) {
    if (!e.isDirectory() || !/^desktop-restore-archive-/i.test(e.name)) continue
    const dir = path.join(root.real, e.name)
    let files = []
    try { files = fs.readdirSync(dir) } catch { continue }
    const scripts = files.filter((n) => /^restore-.*\.(?:cmd|mjs|ps1)$/i.test(n))
    out.push({
      name: e.name, path: dir, count: scripts.length,
      index: files.includes('INDEX.md') ? path.join(dir, 'INDEX.md') : null,
      mover: files.find((n) => /^restore-desktop-scripts\.(cmd|mjs)$/i.test(n)) || null,
      scripts,
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** 从脚本文本里提取 `_archive\<点名>` 引用 → 存在的回滚点目录名（落地目录脚本关联回滚点的唯一线索） */
function pointRefs(text, archReal) {
  const out = new Set()
  const re = /_archive[\\/]([A-Za-z0-9._-]+)/gi
  let m
  while ((m = re.exec(String(text || '')))) out.add(m[1])
  return [...out].filter((n) => isDir(path.join(archReal, n)))
}

// ─────────────────────────── 组装模型 ───────────────────────────
export function buildIndexModel({ days = 30, now = new Date() } = {}) {
  const read = scriptCache()
  const arch = archiveRoot()
  const tl = buildTimeline({ days, now })
  const shown = new Set()

  const rows = []
  for (const it of tl.items || []) {
    const name = it.restoreName || (it.restoreScript ? path.basename(it.restoreScript) : null)
    if (!name) continue
    if (it.restoreScript) shown.add(it.restoreScript.toLowerCase())
    const text = it.restoreScript ? read(it.restoreScript) : ''
    rows.push({
      group: it.kind === 'unregistered' ? 'unregistered' : (it.runnable ? 'runnable' : 'blocked'),
      name,
      namePath: it.restoreScript || null,
      symptom: it.title,
      date: it.date,
      time: it.time || '',
      impact: impactOf(it.text, text),
      prereq: it.restoreScript ? prereqOf(text) : '（未找到脚本本体）',
      drill: drillText(it.drill),
      drilled: it.drill && it.drill.status,
      backup: it.backup ? it.backup.status : 'unknown',
      codeName: isCodeName(name),
      point: it.pointName || null,
      note: it.blocker || '',
    })
  }

  // ② 落地目录里现存但未进时间轴的脚本（有脚本无流水/超窗口）——兜底可发现性
  //    实测发现：落地目录的 `restore-*.cmd` 常与流水条目里的脚本名不一致，
  //    但脚本正文里写着 `<回滚点根名>\<点名>` → 用它把「脚本 → 回滚点 → 演练记录 → 症状」接起来，
  //    否则这批最该被看见的入口会永远停在「未登记」。
  const byPoint = new Map()
  for (const r of rows) if (r.point) byPoint.set(String(r.point).toLowerCase(), r)
  const extra = []
  for (const p of landingScripts()) {
    if (shown.has(p.toLowerCase())) continue
    const name = path.basename(p)
    const text = read(p)
    const refs = pointRefs(text, arch.real)
    const point = refs[0] || pointOf(p, arch)
    const links = refs.length ? refs : (point ? [point] : [])
    const linked = links.map((n) => byPoint.get(String(n).toLowerCase())).filter(Boolean)
    const dRec = point ? readDrillRecord(path.join(arch.real, point)) : { status: 'none' }
    const drillTxt = drillText(dRec)
    extra.push({
      group: point && dRec.status === 'pass' ? 'runnable' : 'flat',
      name,
      namePath: p,
      symptom: linked.length ? linked[0].symptom : (point ? `（流水条目未写脚本名；关联回滚点 ${point}）` : '（流水里未登记 / 超出窗口）'),
      date: linked.length ? linked[0].date : null,
      time: linked.length ? linked[0].time : '',
      impact: impactOf(...linked.map((x) => x.symptom), text),
      prereq: prereqOf(text),
      drill: drillTxt,
      drilled: dRec.status,
      backup: point ? 'present' : 'unknown',
      codeName: isCodeName(name),
      point,
      note: point ? `关联回滚点 ${point}${linked.length ? '（症状取自流水条目）' : ''}` : '',
    })
  }

  const count = (g) => rows.filter((r) => r.group === g).length
  const extraCount = (g) => extra.filter((r) => r.group === g).length
  const unDrilled = rows.filter((r) => r.drilled !== 'pass').length + extra.filter((r) => r.drilled !== 'pass').length
  const missing = rows.filter((r) => r.backup === 'missing' || r.backup === 'partial').length
  return {
    generatedAt: humanTime(now), host: hostName(), days,
    tlStats: tl.stats,
    rows, extra,
    archiveBatches: archiveBatches(),
    stats: {
      total: rows.length + extra.length,
      runnable: count('runnable') + extraCount('runnable'),
      blocked: count('blocked'),
      unregistered: count('unregistered'),
      flat: extraCount('flat'),
      notDrilled: unDrilled,
      backupBad: missing,
      codeNames: rows.filter((r) => r.codeName).length + extra.filter((r) => r.codeName).length,
    },
  }
}

// ─────────────────────────── 渲染 ───────────────────────────
const COLS = ['症状（那次改了什么）', '回滚脚本', '影响面', '前置条件', '是否演练过']

/** 渲染表格；symptomMax > 0 时截断症状列（大表紧凑化，避免索引膨胀成几十万字） */
function table(rows, { symptomMax = 0 } = {}) {
  const head = `| ${COLS.join(' | ')} |\n| --- | --- | --- | --- | --- |`
  const body = rows.map((r) => `| ${esc(r.symptom, symptomMax)}${r.alsoCount ? `（另有 ${r.alsoCount} 条相关流水）` : ''} | \`${esc(r.name)}\`${r.codeName ? ' ⚠代号' : ''} | ${esc(r.impact)} | ${esc(r.prereq)} | ${esc(r.drill)} |`)
  return [head, ...body].join('\n')
}

/** 同一脚本名多次出现时只留最新一条（使用者要的是「跑哪个脚本」，同脚本不重复占行） */
function dedupeByName(rows) {
  const seen = new Map()
  for (const r of rows) {
    const k = r.name.toLowerCase()
    if (!seen.has(k)) seen.set(k, { ...r })
    else {
      const cur = seen.get(k)
      cur.alsoCount = (cur.alsoCount || 0) + 1
    }
  }
  return [...seen.values()]
}

const BATCH_TABLE = (batches) => ['| 批次目录 | 脚本数 | 索引 | 一键搬回 |', '| --- | --- | --- | --- |',
  ...batches.map((b) => `| \`${esc(b.name)}\` | ${b.count} | ${b.index ? `\`${esc(path.basename(b.index))}\`` : '—'} | ${b.mover ? `\`${esc(b.mover)}\`` : '—'} |`)].join('\n')

export function renderIndex(model) {
  const { stats, rows, extra } = model
  const runnable = [...rows.filter((r) => r.group === 'runnable'), ...extra.filter((r) => r.group === 'runnable')]
  const blocked = rows.filter((r) => r.group === 'blocked')
  const unreg = rows.filter((r) => r.group === 'unregistered')
  const flat = extra.filter((r) => r.group === 'flat')
  const codeRows = [...rows, ...extra].filter((r) => r.codeName)
  const L = []
  L.push('# 回滚索引（README-回滚索引）')
  L.push('')
  L.push('> **本文件由 `rollback-index.mjs` 自动生成，请勿手改**（改完下次生成即被覆盖）。')
  L.push(`> 生成时间：${model.generatedAt} · 设备 ${model.host} · 数据窗口：最近 ${model.days} 天`)
  L.push('')
  L.push('## 0. 出事怎么用（先看这里）')
  L.push('')
  L.push('1. **第一入口永远是急救台**（只诊断、不擅自动手）：`node firstaid.mjs --symptom <1-5>`（Windows 可用附带的 firstaid-launch.ps1 起交互菜单）。')
  L.push('2. 急救台报出「哪次改动」后，回到**本索引**找那一行 → 看**前置条件**（要不要停机）与**是否演练过**。')
  L.push('3. 「是否演练过」列机读自各回滚点内的 `drill-record-*.json`——**未演练的不许一键执行**，只能交给 AI/同事复核后再动。')
  L.push('4. 口径：回滚点根为权威源 · 时间轴（`timeline.mjs`）为视图 · **本索引为入口**。')
  L.push('')
  L.push('## 1. 统计')
  L.push('')
  L.push(`- 索引条目 **${stats.total}** 项（窗口内 ${rows.length} · 落地目录未登记 ${stats.flat}）`)
  L.push(`- **可一键回滚 ${stats.runnable}** 项（备份在 + 演练 PASS）；有入口但**受阻 ${stats.blocked}** 项；有备份无流水 ${stats.unregistered} 项`)
  L.push(`- **未过演练 ${stats.notDrilled}** 项（急救台不列为可一键执行项）；备份缺失/部分 ${stats.backupBad} 项`)
  L.push(`- 命中**内部代号命名** ${stats.codeNames} 项 → 见第 5 节（只建议改名，不自动改）`)
  L.push('')
  const runnableU = dedupeByName(runnable)
  L.push('## 2. 可一键回滚（备份在 + 演练 PASS）')
  L.push('')
  L.push(runnableU.length ? table(runnableU) : '_（窗口内暂无「备份在 + 演练 PASS」的条目）_')
  L.push('')
  L.push('## 3. 有回滚入口但受阻（备份异常 / 未演练）')
  L.push('')
  L.push(blocked.length ? table(blocked, { symptomMax: 46 }) : '_（无）_')
  L.push('')
  L.push('## 4. 有备份无流水（兜底命中：说明这次改动漏记了流水）')
  L.push('')
  L.push(unreg.length ? table(unreg, { symptomMax: 46 }) : '_（无）_')
  L.push('')
  if (flat.length) {
    L.push('## 4.1 落地目录现存但未进流水/超窗口的脚本（兜底可发现性）')
    L.push('')
    L.push(table(flat.slice(0, 200), { symptomMax: 46 }))
    if (flat.length > 200) L.push(`\n_（仅列前 200 项，共 ${flat.length} 项；完整清单见 \`--json\` 输出）_`)
    L.push('')
  }
  L.push('## 5. 命名规范与内部代号')
  L.push('')
  L.push('- 规范：`restore-<日期>-<一句话>.cmd`（日期形如 `20260915`），**禁止内部代号**做文件名。')
  L.push('- 内部代号（`p8-11a` / `b0-decoupling` 这类）只允许出现在**本索引**的条目里，不允许霸占脚本文件名。')
  L.push('- ⚠️ **本工具只登记、只建议，不自动改名**：脚本名常被文档 / 任务卡 / 笔记大量引用，改名必须先全量扫引用并同步改指向，否则会出现「照着做却扑空」。')
  L.push('- 扫引用：`node rollback-index.mjs --refs <脚本名>`')
  L.push('')
  if (codeRows.length) {
    L.push(`**命中内部代号 ${codeRows.length} 项（建议改名清单）**`)
    L.push('')
    L.push('| 现名 | 建议形如 | 症状 |')
    L.push('| --- | --- | --- |')
    for (const r of codeRows) L.push(`| \`${esc(r.name)}\` | ${esc(suggestName(r.name, r.date))} | ${esc(r.symptom)} |`)
    L.push('')
  } else L.push('_（无命中）_\n')
  L.push('## 6. 归档入口批次（已搬走，需要时一键搬回）')
  L.push('')
  L.push(model.archiveBatches.length ? BATCH_TABLE(model.archiveBatches) : '_（无归档批次）_')
  L.push('')
  L.push('## 7. 未演练怎么办')
  L.push('')
  L.push('```')
  L.push('node drill.mjs --point <回滚点> --target <目标=备份相对路径> [--live --yes]')
  L.push('```')
  L.push('')
  L.push('- L1 沙箱级 = 底线档（任何恢复点必过）；工具/文档/非运行时路径 → 至少 L2；核心启动链/服务控制/运行时依赖 → L3（需停机，挑空闲窗口做）。')
  L.push('- 演练记录落**回滚点目录内** `drill-record-<ts>.md/.json` —— 生成的记录会被本索引自动读到，「是否演练过」列随下次生成更新。')
  L.push('- 免演练：只读 / 纯文档改动（须在交付说明里写明「免演练」与理由）。')
  L.push('')
  L.push('---')
  L.push('')
  L.push('*索引生成器：\`rollback-index.mjs\`（生成口径见 README「四、怎么用」）*')
  L.push('')
  return L.join('\n')
}

// ─────────────────────────── 扫引用 ───────────────────────────
/** 默认扫描根：工作区的 docs/tools（配置了工作区时）+ 数据根。 */
function defaultScanRoots() {
  const out = []
  const ws = resolveWorkspace()
  if (ws) out.push(path.join(ws, 'docs'), path.join(ws, 'tools'))
  out.push(resolveHome())
  return out
}
function refScan(name, { roots = null } = {}) {
  roots = roots || defaultScanRoots()
  const hits = []
  const lower = name.toLowerCase()
  const walk = (dir, depth = 0) => {
    if (depth > 6 || hits.length > 200) return
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (/node_modules|^\.git$|_archive/i.test(e.name)) continue
        walk(p, depth + 1)
        continue
      }
      if (!/\.(?:md|mjs|js|json|ps1|cmd|yml|yaml)$/i.test(e.name)) continue
      const t = readTextSafe(p, 512 * 1024)
      if (t && t.toLowerCase().includes(lower)) hits.push(p)
    }
  }
  for (const r of roots) walk(r)
  return hits
}

// ─────────────────────────── CLI ───────────────────────────
function usage() {
  console.log([
    '用法：node rollback-index.mjs [--days 30] [--limit 200] [--json]',
    '     node rollback-index.mjs --write [--out <path>]   # 生成 <落地目录>/README-回滚索引.md',
    '     node rollback-index.mjs --check [--out <path>]   # 比对现有索引：一致 0 / 不一致 3',
    '     node rollback-index.mjs --refs <脚本名>          # 归档/改名前的全量引用扫描',
    '',
    '退出码：0 正常 / 1 发现异常（备份缺失或未演练项） / 2 用法错 / 3 --check 不一致或环境不可用',
  ].join('\n'))
}

function parseArgv(argv) {
  const o = { days: 30, limit: 200, json: false, write: false, check: false, out: null, refs: null, help: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case '--days': o.days = Number(next()); break
      case '--limit': o.limit = Number(next()); break
      case '--out': o.out = next(); break
      case '--refs': o.refs = next(); break
      case '--json': o.json = true; break
      case '--write': o.write = true; break
      case '--check': o.check = true; break
      case '--help': case '-h': o.help = true; break
      default:
        if (a.startsWith('-')) { console.error(`✗ 未知参数 ${a}`); o.bad = true }
    }
  }
  if (!Number.isFinite(o.days) || o.days <= 0) { console.error('✗ --days 需为正数'); o.bad = true }
  return o
}

function defaultOut() {
  const dir = landingDir()
  return path.join(dir.path, 'README-回滚索引.md')
}

function normalizeForCompare(s) {
  // 生成时间/设备行每跑必变 → 比对时剔除，只比「索引内容是否过期」
  return String(s).split('\n').filter((l) => !/^> 生成时间：/.test(l)).join('\n')
}

async function main() {
  const o = parseArgv(process.argv)
  if (o.help) { usage(); process.exitCode = EXIT_OK; return }
  if (o.bad) { usage(); process.exitCode = EXIT_USAGE; return }

  if (o.refs) {
    const hits = refScan(o.refs)
    console.log(`引用扫描：${o.refs} → ${hits.length} 处命中`)
    for (const h of hits) console.log('  ' + h)
    if (!hits.length) console.log('  （无引用：可安全归档/改名）')
    process.exitCode = hits.length ? EXIT_BAD : EXIT_OK
    return
  }

  const root = archiveRoot()
  if (!root || !root.exists) {
    console.error(`✗ 回滚点根不可达：${root && root.logical}（索引需要 _archive）`)
    process.exitCode = EXIT_ENV
    return
  }

  const model = buildIndexModel({ days: o.days })
  const md = renderIndex(model)
  const out = o.out || defaultOut()

  if (o.json) {
    console.log(JSON.stringify({ ...model, out }, null, 2))
  }

  if (o.check) {
    const cur = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null
    if (cur === null) {
      console.error(`✗ 索引不存在：${out}`)
      process.exitCode = EXIT_ENV
      return
    }
    const same = normalizeForCompare(cur) === normalizeForCompare(md)
    console.log(same ? `✅ 索引是最新的：${out}` : `🔴 索引已过期（与实况不一致）：${out}`)
    if (!same) console.log('   → 重新生成：node rollback-index.mjs --write')
    process.exitCode = same ? EXIT_OK : EXIT_ENV
    return
  }

  if (o.write) {
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, md, 'utf8')
    console.log(`✅ 已生成回滚索引：${out}`)
  } else {
    console.log(`（dry-run，未写文件；加 --write 落盘到 ${out}）`)
  }

  const s = model.stats
  console.log(`条目 ${s.total}（可一键 ${s.runnable} / 受阻 ${s.blocked} / 有备份无流水 ${s.unregistered} / 落地目录未登记 ${s.flat}）`)
  console.log(`未演练 ${s.notDrilled} · 备份异常 ${s.backupBad} · 内部代号命名 ${s.codeNames}`)
  if (s.backupBad > 0) {
    console.log('⚠ 存在备份缺失/部分缺失项 —— 见索引第 3 节，不列为可一键执行项')
    process.exitCode = EXIT_BAD
  }
}

const isMain = (() => {
  try {
    const a = fs.realpathSync(process.argv[1] || '')
    const b = fs.realpathSync(fileURLToPath(import.meta.url))
    return a.toLowerCase() === b.toLowerCase()
  } catch { return false }
})()

if (isMain) {
  try {
    await main()
  } catch (e) {
    console.error(`✗ 回滚索引生成失败：${e && e.stack || e}`)
    process.exitCode = EXIT_ENV
  }
}

export { usage, parseArgv, refScan, EXIT_OK, EXIT_BAD, EXIT_USAGE, EXIT_ENV }
