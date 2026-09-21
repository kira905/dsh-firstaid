/**
 * lib/common.mjs —— 公共库（开源通用版）
 *
 * 设计约束：
 *   **零第三方依赖** —— 只用 node 内置模块；不 import 任何 npm 包（含宿主与插件 SDK）。
 *   理由：本工具的核心使用场景是「宿主服务起不来 / GUI 假死」，此刻宿主自己的包可能正是坏的。
 *   （单测含负向用例：把宿主包目录改名后本库与 firstaid/timeline 仍须能跑。）
 *
 * 只读原则：本库只做「读 + 判」，不提供任何写「被诊断对象」文件的函数。
 *   唯一的写操作（写报告/日志）落在配置好的日志目录。
 *   路径一律走解析层（lib/runtime-config.mjs）：FIRSTAID_HOME > DSH_HOME > ~/.dsh。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  envValue as cfgEnvValue, resolveHome, resolveWorkspace, resolveLogsDir, resolveChangelogDir,
  resolveArchiveRoot, resolveLandingDir, resolveGuardPattern, resolveGuardStateFile,
} from './runtime-config.mjs'

// ─────────────────────────── 路径口径（唯一来源：lib/runtime-config.mjs） ───────────────────────────
/** 本包根目录（lib/common.mjs 的上一级）—— 用于把「工具自身在哪」从配置里去掉。 */
export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 数据根：FIRSTAID_HOME > DSH_HOME > ~/.dsh（本工具的数据都落在这里）。 */
export const HOME = resolveHome()

/** 工作区根（可选）：FIRSTAID_WORKSPACE / DSH_WORKSPACE；未配置时为 null，调用方须自行处理。 */
export const WORKSPACE_ROOT = resolveWorkspace()

/** 兼容别名：历史调用方按「工作区根」使用它；未配置工作时为 null。 */
export const DSH_ROOT = WORKSPACE_ROOT

/** 工作区下的路径；未配置工作区根时返回 null（**绝不猜**）。 */
export function workspacePath(...segs) {
  return WORKSPACE_ROOT ? path.join(WORKSPACE_ROOT, ...segs) : null
}

/** 数据根下的路径。 */
export function homePath(...segs) {
  return path.join(HOME, ...segs)
}

/** 环境变量取值（空串 / 纯空白 = 未设置）；保留旧名以兼容既有调用方。 */
export function envOverride(name, fallback) {
  const v = cfgEnvValue(name)
  return v || fallback
}

/** 日志目录（报告 / 运行日志落这里）。 */
export const LOGS_DIR = resolveLogsDir()
/** 变更流水目录（改动时间轴的数据源）。 */
export const CHANGELOG_DIR = resolveChangelogDir()
/** 本包根目录（报告里用它指向"脚本自己"，不再写本机绝对路径）。 */
export const TOOLS_FIRSTAID = PKG_ROOT

/**
 * 回滚点根（改动前备份 + 恢复脚本的容器）。
 * 路径来自解析层（FIRSTAID_ARCHIVE_ROOT > <home>/_archive）。
 * 一律用 realpath 判定存在性：该目录常常是一个**符号链接/junction** 指向别的卷，
 * 用逻辑路径判断存在性会得到与物理路径不一致的结果。
 */
export function archiveRoot() {
  const raw = resolveArchiveRoot()
  const real = safeRealpath(raw)
  return { logical: raw, real: real || raw, exists: !!real && isDir(real || raw) }
}

/**
 * 落地目录（恢复脚本的家）。
 * 默认 = <home>/landing；要放桌面/别处请显式配置 FIRSTAID_LANDING。
 * ⚠️ 故意**不猜**桌面目录名：各平台（乃至各语言 Windows）桌面路径都不一样，
 *    猜错会让「恢复脚本明明生成了、用户却找不到」——那是比报错更坏的失败形态。
 */
export function landingDir() {
  const raw = resolveLandingDir()
  return { path: raw, exists: isDir(raw) }
}

/** 恢复脚本的候选目录（落地目录 → 回滚点根）。 */
export function restoreScriptCandidates() {
  const dirs = []
  const land = landingDir()
  if (land.exists) dirs.push(land.path)
  const arch = archiveRoot()
  if (arch.exists) dirs.push(arch.real)
  return dirs
}

// ─────────────────────────── 基础工具 ───────────────────────────
export function isDir(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}
export function isFile(p) {
  try { return fs.statSync(p).isFile() } catch { return false }
}
/** 存在即可（文件或目录） */
export function existsSafe(p) {
  try { fs.statSync(p); return true } catch { return false }
}
export function safeRealpath(p) {
  try { return fs.realpathSync(p) } catch { return null }
}
export function countFiles(dir) {
  let n = 0
  const walk = (d) => {
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (e.isDirectory()) walk(path.join(d, e.name))
      else n++
    }
  }
  walk(dir)
  return n
}

export function sha256File(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch { return null }
}

/** 文本读取：UTF-8，失败返回 null（急救台不许因读不到文件而崩） */
export function readTextSafe(file, maxBytes = 4 * 1024 * 1024) {
  try {
    const st = fs.statSync(file)
    if (st.size > maxBytes) {
      const buf = Buffer.alloc(maxBytes)
      const fd = fs.openSync(file, 'r')
      fs.readSync(fd, buf, 0, maxBytes, st.size - maxBytes)
      fs.closeSync(fd)
      return buf.toString('utf8')
    }
    return fs.readFileSync(file, 'utf8')
  } catch { return null }
}

export function readJsonSafe(file) {
  const t = readTextSafe(file, 1024 * 1024)
  if (t === null) return null
  try { return JSON.parse(t) } catch { return null }
}

/** 目录里最新（mtime 最大）的文件 */
export function newestFile(dir, filter = null) {
  let best = null
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return null }
  for (const e of ents) {
    if (!e.isFile()) continue
    if (filter && !filter(e.name)) continue
    const p = path.join(dir, e.name)
    let st
    try { st = fs.statSync(p) } catch { continue }
    if (!best || st.mtimeMs > best.mtimeMs) best = { path: p, name: e.name, mtimeMs: st.mtimeMs, size: st.size }
  }
  return best
}

export function tailLines(file, n = 20) {
  const t = readTextSafe(file)
  if (t === null) return null
  const lines = t.replace(/\r\n/g, '\n').split('\n')
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.slice(-n)
}

// ─────────────────────────── 时间 ───────────────────────────
const pad = (n, w = 2) => String(n).padStart(w, '0')
export function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}
export function humanTime(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
export function shortTime(d = new Date()) {
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export function hostName() {
  return process.env.COMPUTERNAME || os.hostname()
}

// ─────────────────────────── 进程 / 端口（Windows 原生命令，无 npm 依赖） ───────────────────────────
/**
 * 列出进程。返回 [{ pid, name, cmd }]（本机进程枚举，无第三方依赖）。
 *
 * **双后端 + 降级**（实测教训）：新版 Windows 已**移除 wmic**
 *   （`wmic: 术语 'wmic' 不会被识别`）→ 只靠 wmic 会把「守护进程在岗」误判成「守护进程 0 个」，
 *   同一工具在旧机/新机行为不一致。故：① 优先 PowerShell CIM（有 CommandLine，输出 JSON）；
 *   ② 回落 wmic（老机器）；③ 兜底 tasklist（无 CommandLine，只能按名匹配）。
 *   三级都失败 → { ok:false, reason }，由调用方如实标注「无法判定」，**绝不假装是 0**。
 */
export function listProcesses({ filter = null, needCmd = true } = {}) {
  const backends = [
    { name: 'pwsh-cim', run: listViaPwsh },
    needCmd ? { name: 'wmic', run: listViaWmic } : null,
    { name: 'tasklist', run: listViaTasklist },
  ].filter(Boolean)
  const errors = []
  for (const b of backends) {
    const r = b.run()
    if (r.ok && r.items.length) {
      const items = filter ? r.items.filter(filter) : r.items
      return { ok: true, backend: b.name, items, all: r.items.length }
    }
    if (!r.ok) errors.push(`${b.name}: ${r.reason}`)
  }
  return { ok: false, reason: `所有进程枚举后端均失败（${errors.join(' / ')}）`, items: [], backends: backends.map((b) => b.name) }
}

function listViaPwsh() {
  const cmd = "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 3"
  // PowerShell 7 的位置由环境变量给出（Windows）；拿不到就只靠 PATH 里的 pwsh / powershell
  const programFiles = cfgEnvValue('ProgramFiles') || cfgEnvValue('ProgramW6432')
  const exe = programFiles ? path.join(programFiles, 'PowerShell', '7', 'pwsh.exe') : null
  const runners = []
  if (exe && isFile(exe)) runners.push(exe)
  runners.push('pwsh', 'powershell')
  const errors = []
  for (const exePath of runners) {
    const r = spawnSync(exePath, ['-NoProfile', '-NonInteractive', '-Command', cmd], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    })
    if (r.error || r.status !== 0 || !r.stdout) { errors.push(`${path.basename(String(exePath))}: ${r.error ? r.error.code : `exit ${r.status}`}`); continue }
    let parsed
    try { parsed = JSON.parse(r.stdout) } catch (e) { errors.push(`${path.basename(String(exePath))}: JSON 解析失败 ${e.message}`); continue }
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    const items = arr
      .map((o) => ({ pid: Number(o.ProcessId), name: String(o.Name || ''), cmd: String(o.CommandLine || '') }))
      .filter((o) => Number.isFinite(o.pid) && o.pid > 0)
    if (items.length) return { ok: true, items }
    errors.push(`${path.basename(String(exePath))}: 空结果`)
  }
  return { ok: false, reason: errors.join(' / ') || '无可用 PowerShell' }
}

function listViaWmic() {
  const r = spawnSync('wmic', ['process', 'get', 'ProcessId,Name,CommandLine', '/format:csv'], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  })
  const out = r.stdout || ''
  if (r.error || r.status !== 0 || !out.trim()) return { ok: false, reason: 'wmic 不可用（Win11 25xxx 已移除 / 被 EDR 拦）' }
  const items = []
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('Node,')) continue
    const m = /^[^,]*,\s*(\d+)\s*,\s*([^,]*),?(.*)$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    const name = m[2]
    let cmd = (m[3] || '').trim()
    if (cmd.startsWith('"') && cmd.endsWith('"')) cmd = cmd.slice(1, -1)
    if (!pid) continue
    items.push({ pid, name, cmd })
  }
  return items.length ? { ok: true, items } : { ok: false, reason: 'wmic 输出为空' }
}

function listViaTasklist() {
  const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
  if (r.error || r.status !== 0 || !r.stdout) return { ok: false, reason: 'tasklist 不可用' }
  const items = []
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line.trim())
    if (!m) continue
    items.push({ pid: Number(m[2]), name: m[1], cmd: '' })   // tasklist 无 CommandLine
  }
  return items.length ? { ok: true, items } : { ok: false, reason: 'tasklist 输出为空' }
}

/**
 * 守护进程（supervisor / guard）进程列表；排除自己防误报；命令行不可得时按「状态文件 lastPid」交叉判。
 * 命令行特征与状态文件位置都由配置决定（FIRSTAID_GUARD_PATTERN / FIRSTAID_GUARD_STATE），不写死。
 */
export function guardProcesses() {
  const r = listProcesses()
  if (!r.ok) return { ok: false, reason: r.reason, items: [], backend: null }
  const pat = resolveGuardPattern()
  const withCmd = r.items.filter((p) => p.cmd && pat.test(p.cmd) && p.pid !== process.pid)
  if (withCmd.length) return { ok: true, items: withCmd, backend: r.backend, precise: true }
  // 命令行不可得（tasklist 兜底）→ 用状态文件里的 lastPid 交叉确认，绝不凭猜
  const st = readJsonSafe(resolveGuardStateFile())
  if (st && st.lastPid) {
    const hit = r.items.filter((p) => p.pid === Number(st.lastPid))
    if (hit.length) return { ok: true, items: hit, backend: r.backend, precise: false, note: '按状态文件 lastPid 匹配（该后端无命令行）' }
  }
  return { ok: true, items: [], backend: r.backend, precise: false, note: '进程枚举后端无命令行，且状态文件 lastPid 未命中' }
}

export function chromeProcesses() {
  const r = listProcesses({ filter: (p) => /^chrome\.exe$/i.test(p.name) })
  if (!r.ok) return { ok: false, items: [], reason: r.reason }
  return { ok: true, items: r.items, backend: r.backend }
}

/** 监听 3080 的进程 pid（TCP LISTENING），零外部依赖 */
export function portListeners(port) {
  const r = spawnSync(
    'netstat',
    ['-ano', '-p', 'TCP'],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  )
  if (r.status !== 0 || !r.stdout) return { ok: false, pids: [], established: 0, raw: '' }
  const pids = new Set()
  let established = 0
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+(\S+):(\d+)\s+(\S+)\s+(\d+)\s*$/.exec(line)
    if (!m) continue
    if (Number(m[2]) !== port) continue
    const state = m[5].toUpperCase()
    if (state === 'LISTENING') pids.add(Number(m[6]))
    if (state === 'ESTABLISHED') established++
  }
  return { ok: true, pids: [...pids], established, raw: r.stdout }
}

export function processAlive(pid) {
  if (!pid) return false
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024,
  })
  const out = (r.stdout || '').trim()
  return out.length > 0 && !/no tasks/i.test(out) && out.includes(String(pid))
}

/** 进程内存（KB），拿不到返回 null */
export function processMemoryKB(pid) {
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024,
  })
  const out = (r.stdout || '').trim()
  const m = /"([^"]+)","(\d+)","[^"]*","(\d+)/.exec(out)
  if (!m) return null
  return { name: m[1], pid: Number(m[2]), memKB: Number(m[3]) }
}

// ─────────────────────────── HTTP 探活（零依赖） ───────────────────────────
export function httpProbe(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    const done = (obj) => { if (!settled) { settled = true; resolve({ ...obj, ms: Date.now() - started }) } }
    let req
    try {
      const u = new URL(url)
      const mod = u.protocol === 'https:' ? https : http
      req = mod.request(
        { protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', timeout: timeoutMs },
        (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (c) => { if (body.length < 4096) body += c })
          res.on('end', () => done({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode, body: body.slice(0, 4096) }))
        },
      )
      req.on('timeout', () => { req.destroy(); done({ ok: false, reason: `超时 ${timeoutMs}ms` }) })
      req.on('error', (e) => done({ ok: false, reason: e.code || e.message }))
      req.end()
    } catch (e) {
      done({ ok: false, reason: e.message })
    }
  })
}
/** 裸 TCP 连接探测（端口是否可连） */
export function tcpProbe(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const started = Date.now()
    const sock = net.connect({ host, port })
    let settled = false
    const done = (ok, reason) => {
      if (settled) return
      settled = true
      try { sock.destroy() } catch { /* ignore */ }
      resolve({ ok, reason, ms: Date.now() - started })
    }
    sock.setTimeout(timeoutMs)
    sock.on('connect', () => done(true))
    sock.on('timeout', () => done(false, `超时 ${timeoutMs}ms`))
    sock.on('error', (e) => done(false, e.code || e.message))
  })
}

// ─────────────────────────── 报告渲染 ───────────────────────────
export const SEV = { OK: '🟢', WARN: '🟡', BAD: '🔴', INFO: '⚪' }

export function reportHeader({ title, subtitle, symptoms }) {
  const lines = [
    `# ${title}`,
    '',
    `- **时间**：${humanTime()}`,
    `- **设备**：${hostName()}`,
    `- **主机/OS**：${os.platform()} ${os.release()} · node ${process.version}`,
    `- **工具版本**：v0.1（只读诊断 · 零第三方依赖）`,
    `- **症状**：${symptoms}`,
    '',
  ]
  if (subtitle) lines.push(subtitle, '')
  return lines
}

export function renderSections(sections) {
  const out = []
  for (const s of sections) {
    out.push(`## ${s.title}`, '')
    if (s.lines && s.lines.length) out.push(...s.lines, '')
    if (s.table && s.table.length) {
      out.push(...s.table, '')
    }
    if (s.tail && s.tail.length) {
      out.push('```', ...s.tail, '```', '')
    }
  }
  return out
}

/** 结论行：既给人看，也给机器读（firstaid 退出码由 severity 汇总决定） */
export function verdictOf(checks) {
  const bad = checks.filter((c) => c.sev === SEV.BAD)
  const warn = checks.filter((c) => c.sev === SEV.WARN)
  if (bad.length) return { level: 'BAD', text: `发现 ${bad.length} 项异常（见下方 🔴）`, bad, warn }
  if (warn.length) return { level: 'WARN', text: `无致命异常，但有 ${warn.length} 项需留意（见下方 🟡）`, bad, warn }
  return { level: 'OK', text: '未发现异常', bad, warn }
}

// ─────────────────────────── 报告/日志落盘 ───────────────────────────
/**
 * 只写配置好的日志目录（默认 <home>/logs）。
 * 目录不可写时降级到系统临时目录，并如实标注（**绝不静默**）。
 */
export function writeArtifact(kind, ext, content) {
  const ts = stamp()
  const name = `${kind}-${ts}.${ext}`
  const attempts = [LOGS_DIR, path.join(os.tmpdir(), 'dsh-firstaid')]
  for (const dir of attempts) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, name)
      fs.writeFileSync(file, content, 'utf8')
      return { ok: true, path: file, dir, degraded: dir !== LOGS_DIR }
    } catch { /* try next */ }
  }
  return { ok: false, path: null, error: '报告与日志均无法写入（logs 目录与临时目录都失败）' }
}
