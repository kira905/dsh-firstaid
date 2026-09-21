#!/usr/bin/env node
/**
 * firstaid.mjs —— 急救台 v0.1
 *
 * 一句话：出事时你只想知道「跑哪个」——这里把 5 个症状变成 1 个入口，产出**现场体检报告**。
 *
 * 设计原则（逐条可验）：
 *   1. **默认只诊断、不擅自动手**；任何写动作都要人确认 —— 本脚本除「写报告/日志」外，
 *      不写任何被诊断对象的文件（单测有「目标零改动」hash 断言）。
 *   2. 每个动作前先备份；失败**冻结现场**（不无限重试）—— 在报告里给出「冷却」提示而非自动重试。
 *   3. 第一产出永远是**现场体检报告**（可整段丢给 AI/同事看）—— 判断由人来做。
 *   4. **写前快照**：本脚本不做写动作；`--run` 类动作一律先快照（本版不执行，只给计划）。
 *   5. **零第三方依赖**：只用系统 node + 本目录下的脚本，不 import 任何 npm 包。
 *      （验收含负向用例：把宿主包目录临时改名后本脚本仍能跑。）
 *
 * 症状菜单与两个出口见 usage()。
 *
 * 用法：
 *   node firstaid.mjs --symptom <1|2|3|4|5> [--json] [--quiet] [--no-archive] [--days 7]
 *   node firstaid.mjs --list
 *
 * 退出码（语义写死；.cmd 靠它决定是否停窗）：
 *   0 = 未发现异常（可能有 🟡 提示）
 *   1 = 发现异常（🔴）：症状诊断命中故障，或时间轴存在备份缺失项
 *   2 = 用法错误
 *   3 = 急救台自身跑不动（环境不可用，如报告无法落盘）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LOGS_DIR, archiveRoot, landingDir, restoreScriptCandidates,
  isDir, isFile, existsSafe, readTextSafe, readJsonSafe, newestFile, tailLines,
  guardProcesses, chromeProcesses, portListeners, processAlive, processMemoryKB,
  httpProbe, tcpProbe, humanTime, shortTime, stamp, hostName, writeArtifact,
  reportHeader, verdictOf, SEV, HOME, PKG_ROOT, workspacePath,
} from './lib/common.mjs'
import { buildTimeline, renderTimeline, preflightRun } from './timeline.mjs'
// 路径与特征一律走本包解析层（lib/runtime-config.mjs），**不依赖包外任何工具**：
//   数据根 = FIRSTAID_HOME > DSH_HOME > ~/.dsh；端口/守护进程特征/冷盘落点都可注入。
import {
  resolvePort, resolveOtherPorts, resolveGuardStateFile, resolveGuardLogFile, resolveKnowledgeDir,
  resolveColdRoots, resolveMirrorRoots, resolveBackupSources, resolveLogPattern,
  describeResolution, formatResolution,
} from './lib/runtime-config.mjs'

const EXIT_OK = 0
const EXIT_BAD = 1
const EXIT_USAGE = 2
const EXIT_ENV = 3

const PORT = resolvePort()
const DSH_URL = `http://127.0.0.1:${PORT}/`
const GUARD_STATE = resolveGuardStateFile()
const GUARD_LOG = resolveGuardLogFile()
const KNOWLEDGE_DIR = resolveKnowledgeDir()

// ─────────────────────────── 冷盘/备份落点解析（禁写死任何盘符，全部配置驱动） ───────────────────────────
export function hostTag(h = hostName()) { return String(h || '').toLowerCase() }

/**
 * 冷盘（离线备份介质）落点表：来自 FIRSTAID_COLD_ROOTS（`名称=路径` 多值，或 JSON 数组）。
 * 未配置 → 空表，报告里如实标「未配置」（**绝不假装有备份**）。
 * 每项字段：known 是否配置过、drive 卷根、reachable 目录是否真在、drivePresent 卷是否在线。
 */
export function coldRoots() {
  const out = []
  for (const c of resolveColdRoots()) {
    const root = c.root || null
    const drive = root ? path.parse(root).root : null
    out.push({
      name: c.name, envVar: c.envVar || 'FIRSTAID_COLD_ROOTS', drive, root,
      known: !!root,
      reachable: root ? isDir(root) : false,
      drivePresent: drive ? isDir(drive) : false,
    })
  }
  return out
}

/** 镜像/历史备份落点：来自 FIRSTAID_MIRROR_ROOTS；未配置时给出由 home/工作区推出的通用两项。 */
export function mirrorLocations() {
  return resolveMirrorRoots().map((c) => ({ name: c.name, p: c.root, exists: isDir(c.root) || isFile(c.root) }))
}

// ─────────────────────────── 症状 1：DSH 打不开 / 起不来 ───────────────────────────
export async function symptom1(opts = {}) {
  const checks = []
  const details = []

  const guard = guardProcesses()
  const gp = guard.items || []
  checks.push({
    sev: !guard.ok ? SEV.WARN : (gp.length === 1 ? SEV.OK : (gp.length === 0 ? SEV.BAD : SEV.WARN)),
    name: '守护进程数',
    value: !guard.ok ? '无法判定' : gp.length,
    detail: !guard.ok
      ? `进程枚举全部后端失败（${guard.reason}）——不假装是 0，请人工核对：tasklist | findstr node`
      : (gp.length === 0
        ? '没有守护进程 → 服务挂了没人拉起它 → 按你的部署方式启动（守护特征可配 FIRSTAID_GUARD_PATTERN）'
        : (gp.length > 1
          ? `有 ${gp.length} 个守护进程（多个守护会互相抢拉起，属异常）`
          : `pid ${gp.map((x) => x.pid).join(',')}${guard.precise === false ? '（按状态文件 lastPid 匹配）' : ''}`)),
  })

  const st = readJsonSafe(GUARD_STATE)
  if (st === null) {
    checks.push({ sev: SEV.WARN, name: '守护进程状态文件', value: '缺失/损坏', detail: `${GUARD_STATE}（0 字节或非法 JSON 都算毁；守护会反复 check）` })
  } else {
    const downOk = !st.downSince
    checks.push({
      sev: st.phase === 'WATCH' && downOk ? SEV.OK : SEV.WARN,
      name: '守护进程状态',
      value: `${st.phase}${st.downSince ? ' · DOWN' : ''}`,
      detail: `crashCount=${st.crashCount ?? '?'} repairAttempts=${st.repairAttempts ?? '?'} frozenAt=${st.frozenAt || 'null'} lastPid=${st.lastPid ?? '?'} updatedAt=${st.updatedAt || '?'}`,
    })
    if (st.frozenAt) {
      checks.push({ sev: SEV.WARN, name: '冻结标记', value: st.frozenAt, detail: '守护曾判定冻结（防无限重启）；先看自愈报告再动手' })
    }
  }

  const port = portListeners(PORT)
  if (!port.ok) {
    checks.push({ sev: SEV.WARN, name: `端口 ${PORT}`, value: 'netstat 不可用', detail: '无法判定监听状态' })
  } else {
    checks.push({
      sev: port.pids.length === 1 ? SEV.OK : (port.pids.length === 0 ? SEV.BAD : SEV.WARN),
      name: `端口 ${PORT} 监听`,
      value: port.pids.length ? `pid ${port.pids.join(',')}` : '无人监听',
      detail: port.pids.length === 0 ? '服务没在跑 → 先确认守护进程在岗，再按部署方式启动' : `已建立连接 ${port.established} 条`,
    })
    if (port.pids.length > 1) {
      checks.push({ sev: SEV.BAD, name: '同端口多监听者', value: port.pids.join(','), detail: '异常：可能有僵尸/双实例，勿手杀，先看日志' })
    }
  }

  let dshAlive = false
  if (port.ok && port.pids.length) {
    const pid = port.pids[0]
    dshAlive = processAlive(pid)
    const mem = processMemoryKB(pid)
    checks.push({
      sev: dshAlive ? SEV.OK : SEV.BAD,
      name: '主进程',
      value: dshAlive ? `pid ${pid} 存活` : `pid ${pid} 不存在`,
      detail: mem ? `内存 ${(mem.memKB / 1024).toFixed(0)} MB` : '内存读取失败',
    })
  } else {
    checks.push({ sev: SEV.BAD, name: '主进程', value: '无（端口无人监听）', detail: '服务没起来' })
  }

  const http = await httpProbe(DSH_URL, opts.probeTimeoutMs ?? 5000)
  checks.push({
    sev: http.ok ? SEV.OK : SEV.BAD,
    name: 'HTTP 探活',
    value: http.ok ? `HTTP ${http.status} · ${http.ms}ms` : `失败（${http.reason}）`,
    detail: http.ok ? '页面可达' : '服务不可达',
  })

  // dsh-web 日志尾部（每次启动一个文件）
  const logPattern = resolveLogPattern()
  const webLog = newestFile(LOGS_DIR, (n) => logPattern.test(n))
  if (!webLog) {
    checks.push({ sev: SEV.WARN, name: '启动日志', value: '无', detail: `${LOGS_DIR} 下没有匹配 ${logPattern} 的日志（可用 FIRSTAID_LOG_PATTERN 指定）` })
  } else {
    const tail = tailLines(webLog.path, 12) || []
    const errish = tail.filter((l) => /error|exception|failed|EADDRINUSE|Cannot|throw/i.test(l))
    checks.push({
      sev: errish.length ? SEV.WARN : SEV.OK,
      name: '最近启动日志',
      value: `${webLog.name}（${webLog.size}B · ${shortTime(new Date(webLog.mtimeMs))}）`,
      detail: errish.length ? `尾部含 ${errish.length} 行疑似错误` : '尾部无错误特征',
    })
    details.push({ title: '启动日志尾部（最近一次）', tail: tail.slice(-12) })
  }

  // 守护进程日志：区分「预期内重启」与「真崩溃」
  //   预期内重启长这样：`CRASH: intentional-restart marker present; skipping crash count` /
  //                    `CRASH: manual-start marker present; treating as intentional boot`
  //   → 这类**不计数**（否则会把正常重启刷成「崩溃几十次」的假报警，实测踩到过）。
  if (isFile(GUARD_LOG)) {
    const gtail = tailLines(GUARD_LOG, 400) || []
    const downLines = gtail.filter((l) => /\]\s*DOWN:/.test(l))
    const crashLines = gtail.filter((l) => /\]\s*CRASH:/.test(l))
    const intentional = crashLines.filter((l) => /marker present|intentional|skip count/i.test(l))
    const realCrashes = crashLines.length - intentional.length
    const sev = (realCrashes > 0 || (st && (st.crashCount || 0) > 0)) ? SEV.WARN : SEV.OK
    checks.push({
      sev,
      name: '守护进程日志（尾部 400 行）',
      value: `DOWN ${downLines.length} 次 · 真崩溃 ${realCrashes} 次 · 预期内重启 ${intentional.length} 次`,
      detail: `${path.basename(GUARD_LOG)}（${shortTime(new Date(fs.statSync(GUARD_LOG).mtimeMs))}）· 状态文件 crashCount=${st ? (st.crashCount ?? '?') : '?'}`
        + (realCrashes > 0 ? ' —— 有非预期崩溃，看 repair 报告' : ' —— 均为预期内重启'),
    })
    details.push({ title: '守护进程日志尾部', tail: gtail.slice(-15) })
  }

  // 三条处置建议
  const v = verdictOf(checks)
  const advice = []
  if (v.level === 'OK') {
    advice.push('现状正常：服务在跑、守护进程在岗。若你看到的失败是**浏览器侧**（转圈/假死）→ 用症状 2。')
  } else {
    if (!gp.length) advice.push('① 守护进程不在 → 用你的服务启动入口拉起它（守护特征可用 FIRSTAID_GUARD_PATTERN 配置）。')
    else advice.push('① 守护在岗但服务没起来 → 用你的重启入口重启服务（有守护时它会用新进程拉起；**不要在守护缺席时手动杀服务进程**）。')
    if (!http.ok && port.pids.length) advice.push('② 端口在监听但 HTTP 不通 → 看上面「启动日志尾部」的报错；若是扩展/插件引起的启动失败，先摘掉再起。')
    advice.push('③ 上面两条都不确定 → 跑「症状 5（不知道怎么了）」生成体检包，把包路径交给 AI/同事看。')
  }

  return {
    symptom: 1,
    title: '症状 1 · DSH 打不开 / 起不来',
    checks, details, verdict: v, advice,
    extra: { guardPids: gp.map((x) => x.pid), dshPid: port.ok && port.pids.length ? port.pids[0] : null, dshAlive },
  }
}

// ─────────────────────────── 症状 2：界面假死 / 一直转圈 ───────────────────────────
export async function symptom2(opts = {}) {
  const checks = []
  const details = []

  const port = portListeners(PORT)
  checks.push({
    sev: port.ok && port.pids.length ? SEV.OK : SEV.BAD,
    name: `服务端（:${PORT}）`,
    value: port.ok ? (port.pids.length ? `pid ${port.pids.join(',')}` : '无监听') : 'netstat 不可用',
    detail: port.ok && port.pids.length ? 'DSH 服务在跑 —— 那么「转圈」大概率是浏览器侧' : '服务不在跑 → 先看症状 1',
  })

  const t0 = Date.now()
  const tcp = await tcpProbe('127.0.0.1', PORT, 3000)
  const http = await httpProbe(DSH_URL, opts.probeTimeoutMs ?? 5000)
  checks.push({
    sev: http.ok ? (http.ms > 3000 ? SEV.WARN : SEV.OK) : SEV.BAD,
    name: '服务端响应',
    value: http.ok ? `${http.ms}ms（HTTP ${http.status}）` : `失败 ${http.reason}`,
    detail: http.ok && http.ms > 3000 ? '响应偏慢：可能正在跑重活（会话解码/生图/后台任务扫描）' : 'TCP 与 HTTP 均正常',
  })
  void tcp; void t0

  const chrome = chromeProcesses()
  checks.push({
    sev: SEV.INFO,
    name: '浏览器进程数',
    value: chrome.items.length,
    detail: '值本身正常；但自动化窗口/常驻标签页会与服务抢 GPU → 关掉不用的窗口即流畅',
  })

  const est = port.ok ? port.established : -1
  checks.push({
    sev: SEV.INFO,
    name: `:${PORT} 已建立连接`,
    value: est,
    detail: '每个 DSH 页面在 HTTP/1.1 下会占多条连接；**同源开第二个页面会撞 Chrome 上限（约 6）→ 全站假死**',
  })

  // 其它 DSH 实例（测试/金丝雀）会干扰判断
  const others = []
  for (const p of resolveOtherPorts()) {
    const r = portListeners(p)
    if (r.ok && r.pids.length) others.push(`${p}(pid ${r.pids.join(',')})`)
  }
  checks.push({
    sev: SEV.INFO,
    name: '其它实例端口',
    value: others.length ? others.join(' · ') : '无',
    detail: '用 FIRSTAID_OTHER_PORTS（逗号分隔）指定本机可能同时存在的其它实例端口；有则说明你连的可能不是被诊断的那个',
  })

  const v = verdictOf(checks)
  const advice = []
  if (!v.bad.length) {
    advice.push('**第一处置（90% 有效）**：完全退出浏览器（所有窗口）再重开 —— 同一 origin 的连接池占满后，刷新/Flush socket 都无效。')
    advice.push('第二处置：关掉自动化窗口 / 其它标签页（它们和页面抢连接与 GPU）。')
    advice.push('第三处置：第二个页面一律用**无痕窗口**（Ctrl+Shift+N），不要同 origin 开两个标签。')
    if (others.length) advice.push(`注意：本机还有其它实例在跑（${others.join(' · ')}），确认你连的是 :${PORT}。`)
  } else {
    advice.push('服务端本身不可达 → 走症状 1（打不开 / 起不来）。')
  }

  details.push({
    title: '判据说明（口径）',
    tail: [
      '① 服务端可达 + 浏览器转圈 = 连接池/GPU 争用（非服务故障）→ 完全退出 Chrome 重开；',
      '② 服务端不可达 = 真故障 → 症状 1；',
      '③ 本诊断**不动手**（不重启、不杀进程）—— 重启是写动作，须人工确认后走你既定的重启流程。',
    ],
  })

  return { symptom: 2, title: '症状 2 · 界面假死 / 一直转圈', checks, details, verdict: v, advice, extra: { others } }
}

// ─────────────────────────── 回滚脚本索引 ───────────────────────────
/**
 * 回滚索引状态（只读）：急救台回答「哪次改动」，索引回答「跑哪个脚本、要不要停机、演练过没」。
 * 索引本体由 `tools\dsh-firstaid\rollback-index.mjs` 生成到桌面落地目录；这里只判**在不在 + 新不新**。
 *   stale 判据（宽口径，防误报）：索引 mtime 早于「窗口内**不晚于今天**的最新改动日期当天 00:00」→ 怀疑过期。
 *   ⚠️ 必须排除「未来日期」：流水里常有内联日程（如「9/21 计划」），时间轴会把它解析成条目 date，
 *      2026-09-15 实测踩中——按 items[0].date 直接比会把刚生成的索引误判成过期。
 */
const ROLLBACK_INDEX_NAME = 'README-回滚索引.md'
export function rollbackIndexStatus(tl = null) {
  const land = landingDir()
  const p = path.join(land.path, ROLLBACK_INDEX_NAME)
  const exists = isFile(p)
  let size = 0
  let mtime = 0
  if (exists) { try { const st = fs.statSync(p); size = st.size; mtime = st.mtimeMs } catch { /* ignore */ } }
  let newest = null
  let stale = false
  const now = new Date()
  const todayYmd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  if (tl && Array.isArray(tl.items) && tl.items.length) {
    const past = tl.items.map((i) => (i && i.date ? String(i.date) : null))
      .filter((d) => d && /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= todayYmd)
      .sort()
    newest = past.length ? past[past.length - 1] : null
    if (exists && newest) {
      const dayStart = new Date(`${newest}T00:00:00`).getTime()
      stale = Number.isFinite(dayStart) && mtime < dayStart
    }
  }
  return { path: p, dir: land.path, exists, size, mtime, newest, stale }
}

// ─────────────────────────── 症状 3：刚改完的东西想撤销 ───────────────────────────
export async function symptom3(opts = {}) {
  const checks = []
  const details = []
  const days = opts.days ?? 7
  const tl = buildTimeline({ days, includeArchive: opts.archive !== false })

  checks.push({
    sev: tl.stats.backupMissing > 0 ? SEV.BAD : SEV.OK,
    name: '备份缺失项',
    value: tl.stats.backupMissing,
    detail: tl.stats.backupMissing ? '这些条目**不可一键回滚**（不许假装能回滚）' : '窗口内所有条目都有备份在',
  })
  checks.push({
    sev: SEV.INFO,
    name: '窗口内改动',
    value: `${tl.stats.entries} 条（未登记改动 ${tl.stats.unregistered} 条）`,
    detail: `数据源 ${tl.files.join(', ') || '（无）'} + 回滚点根兜底`,
  })
  checks.push({
    sev: SEV.INFO,
    name: '可一键回滚',
    value: `${tl.stats.runnable} 条`,
    detail: '门槛 = 有恢复脚本 + 备份在 + 回滚点内有 PASS 演练记录',
  })
  if (tl.stats.unregistered > 0) {
    checks.push({
      sev: SEV.WARN, name: '未登记改动（兜底命中）', value: tl.stats.unregistered,
      detail: '有备份但流水查不到 → 说明漏记了流水；这是**暴露漏记**，不是故障',
    })
  }
  const idx = rollbackIndexStatus(tl)
  checks.push({
    sev: !idx.exists ? SEV.WARN : (idx.stale ? SEV.WARN : SEV.OK),
    name: '回滚脚本索引',
    value: idx.exists ? `${(idx.size / 1024).toFixed(0)} KB${idx.stale ? ' · 疑似过期' : ''}` : '缺失',
    detail: idx.exists
      ? `${idx.path} —— 「症状 → 脚本 → 影响面/前置条件 → 是否演练过」四列摊平（机读演练记录）；本窗口可一键 ${tl.stats.runnable} / 未演练 ${tl.stats.notDrilled}`
      : '未生成 → 跑 node rollback-index.mjs --write 生成（否则出事时仍要靠人翻脚本堆）',
  })
  const v = verdictOf(checks)
  const advice = [
    '在下面的时间轴里找到你要撤销的那次改动（最新在最上），记下序号。',
    '看该条的三态：🟢 备份在 / 🔴 备份缺失 / ⚠ 未登记改动 —— **🔴 与 ⚠ 都不可一键回滚**。',
    idx.exists
      ? `要知道「这改动该跑哪个脚本、要不要停机」→ 打开回滚索引：\`${idx.path}\`（按症状搜索即可）。`
      : '看清单没有索引 → 先跑 node rollback-index.mjs --write 生成回滚索引（症状→脚本→前置条件→演练状态）。',
    '真要回滚：跑 node timeline.mjs --run <序号> 先看预检（本版本只预检、不执行）。',
    '看不清选哪条 → 把这份报告交给 AI/同事（症状 5 会连时间轴一起打包）。',
  ]
  details.push({ title: '时间轴全文（可整段复制给 agent）', tail: renderTimeline(tl, { limit: opts.limit ?? 40 }).split('\n') })

  return { symptom: 3, title: '症状 3 · 刚改完的东西想撤销（→ 改动时间轴）', checks, details, verdict: v, advice, extra: { timelineStats: tl.stats, rollbackIndex: idx }, timeline: tl }
}

// ─────────────────────────── 症状 4：数据 / 文件被删 ───────────────────────────
export async function symptom4() {
  const checks = []
  const details = []
  const cold = coldRoots()
  const mirrors = mirrorLocations()

  const archive = archiveRoot()
  checks.push({
    sev: archive.exists ? SEV.OK : SEV.BAD,
    name: '回滚点根',
    value: archive.exists ? '可达' : '不可达',
    detail: `${archive.logical}${archive.exists ? ` → ${archive.real}` : '（junction 目标不在线）'}`,
  })
  let pointCount = 0
  let withScript = 0
  if (archive.exists) {
    try {
      const ents = fs.readdirSync(archive.real, { withFileTypes: true }).filter((e) => e.isDirectory())
      pointCount = ents.length
      for (const e of ents) {
        const p = path.join(archive.real, e.name)
        let names = []
        try { names = fs.readdirSync(p) } catch { continue }
        if (names.some((n) => /^restore-.*\.(cmd|mjs|ps1)$/i.test(n))) withScript++
      }
    } catch { /* ignore */ }
  }
  checks.push({
    sev: SEV.INFO, name: '回滚点统计', value: `${pointCount} 个（含恢复脚本 ${withScript} 个）`,
    detail: '回滚点 = 改动前的备份 + 恢复脚本；能恢复的是「被备份过的东西」，不是任意文件',
  })

  if (!cold.length) {
    checks.push({
      sev: SEV.INFO, name: '冷盘备份', value: '未配置',
      detail: '用 FIRSTAID_COLD_ROOTS 指定离线备份介质（形如 "冷盘=<盘符>:\\\\rollback-points"）；未配置时本报告不承诺冷盘可用性',
    })
  }
  for (const c of cold) {
    let detail
    let sev = SEV.OK
    if (!c.known) { sev = SEV.WARN; detail = `未配置落点（用环境变量 ${c.envVar} 指定）` }
    else if (!c.drivePresent) { sev = SEV.WARN; detail = `卷 ${c.drive} 不在线 → 该项标「待盘」，**不假装有备份**` }
    else if (!c.reachable) { sev = SEV.WARN; detail = `盘在线但目录不存在：${c.root}` }
    else detail = `${c.root}`
    checks.push({ sev, name: c.name, value: c.reachable ? '在线' : '不可达', detail })
  }
  for (const m of mirrors) {
    checks.push({ sev: m.exists ? SEV.OK : SEV.INFO, name: `镜像/备份：${m.name}`, value: m.exists ? '在位' : '不在本机', detail: m.p })
  }

  const v = verdictOf(checks)
  const advice = [
    '**先别写任何东西** —— 删除后最大的风险是被后续写入覆盖。',
    '按数据类别找对应备份（可恢复范围**以实测存在为准**，本报告不承诺不可恢复的东西）：',
  ]
  for (const s of resolveBackupSources()) {
    advice.push(`  · ${s.category} → ${s.target}${s.note ? `（${s.note}）` : ''}；`)
  }
  advice.push(
    '恢复动作一律走「备份 + 恢复脚本 + 演练过」三件套；没有脚本或没演练过的，交给 AI/同事处理，别手抄。',
  )
  if (cold.some((c) => !c.reachable)) {
    advice.push('⚠ 有冷盘不在线：**现在无法从冷盘恢复**，请接上介质后重跑本症状（本工具不替你做假设）。')
  }
  details.push({
    title: '可恢复范围（口径）',
    tail: [
      '能恢复 = 存在备份（本报告已逐项实测）+ 有恢复脚本（或可反向抄回）；',
      '不能恢复 = 从未被备份、或备份所在盘不在线、或被 junction 跟删（remove 会跟随链接删目标）；',
      '事故处置铁律：搬/删含 junction 的树之前先看 LinkType（Get-Item -Force），复制一律 robocopy /XJ。',
    ],
  })

  return { symptom: 4, title: '症状 4 · 数据 / 文件被删', checks, details, verdict: v, advice, extra: { pointCount, withScript, cold } }
}

// ─────────────────────────── 症状 5：不知道怎么了（体检包） ───────────────────────────
export async function symptom5(opts = {}) {
  const days = opts.days ?? 7
  const parts = []
  const s1 = await symptom1(opts)
  const s2 = await symptom2(opts)
  const s3 = await symptom3(opts)
  const s4 = await symptom4()
  parts.push(s1, s2, s3, s4)

  const checks = []
  const details = []
  const worst = parts.reduce((acc, p) => {
    const rank = (v) => (v.level === 'BAD' ? 2 : v.level === 'WARN' ? 1 : 0)
    return rank(p.verdict) > rank(acc) ? p.verdict : acc
  }, { level: 'OK', text: '未发现异常', bad: [], warn: [] })

  checks.push({
    sev: worst.level === 'BAD' ? SEV.BAD : (worst.level === 'WARN' ? SEV.WARN : SEV.OK),
    name: '综合判断', value: worst.level, detail: worst.text,
  })

  // 恢复脚本清单 + 演练状态（未演练不得列为一键执行项）
  const land = landingDir()
  const scripts = []
  if (land.exists) {
    let names = []
    try { names = fs.readdirSync(land.path) } catch { names = [] }
    for (const n of names.filter((x) => /^restore-.*\.(cmd|mjs|ps1)$/i.test(x))) {
      let st = null
      try { st = fs.statSync(path.join(land.path, n)) } catch { /* ignore */ }
      scripts.push({ name: n, size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 })
    }
  }
  const archive = archiveRoot()
  let drillPass = 0
  let drillTotal = 0
  if (archive.exists) {
    let ents = []
    try { ents = fs.readdirSync(archive.real, { withFileTypes: true }).filter((e) => e.isDirectory()) } catch { ents = [] }
    for (const e of ents) {
      const p = path.join(archive.real, e.name)
      let recs = []
      try { recs = fs.readdirSync(p).filter((n) => /^drill-record-.*\.json$/i.test(n)) } catch { continue }
      for (const r of recs) {
        drillTotal++
        const j = readJsonSafe(path.join(p, r))
        if (j && String(j.verdict).toUpperCase() === 'PASS') drillPass++
      }
    }
  }
  checks.push({
    sev: scripts.length ? SEV.OK : SEV.WARN,
    name: '落地恢复脚本',
    value: `${scripts.length} 个`,
    detail: `${land.path}${land.exists ? '' : '（目录不存在）'}`,
  })
  checks.push({
    sev: SEV.INFO,
    name: '演练记录',
    value: `PASS ${drillPass} / 共 ${drillTotal}`,
    detail: '未过演练的恢复脚本标「未演练」，急救台不把它列为可一键执行项',
  })

  // 历史线索目录 + 自愈报告（纳入体检包当线索）
  const kb = []
  if (isDir(KNOWLEDGE_DIR)) {
    try {
      for (const n of fs.readdirSync(KNOWLEDGE_DIR)) {
        const p = path.join(KNOWLEDGE_DIR, n)
        if (isFile(p) && /\.(md|json|txt)$/i.test(n)) kb.push(n)
      }
    } catch { /* ignore */ }
  }
  const reports = []
  if (isDir(LOGS_DIR)) {
    try {
      for (const n of fs.readdirSync(LOGS_DIR)) {
        if (/^repair-report-.*\.md$/i.test(n)) reports.push(n)
      }
    } catch { /* ignore */ }
  }
  checks.push({
    sev: SEV.INFO, name: '历史线索 / 报告', value: `线索 ${kb.length} 条 · 报告 ${reports.length} 份`,
    detail: `${KNOWLEDGE_DIR} ／ ${LOGS_DIR} 下的 repair-report-*.md（已随本包索引）`,
  })

  // 回滚脚本索引：体检包里给使用者一个「症状 → 跑哪个脚本」的入口
  const rIdx = (s3 && s3.extra && s3.extra.rollbackIndex) || rollbackIndexStatus(s3 && s3.timeline)
  checks.push({
    sev: !rIdx.exists ? SEV.WARN : (rIdx.stale ? SEV.WARN : SEV.OK),
    name: '回滚脚本索引',
    value: rIdx.exists ? `在（${(rIdx.size / 1024).toFixed(0)} KB${rIdx.stale ? ' · 疑似过期' : ''}）` : '缺失',
    detail: rIdx.exists ? rIdx.path : '缺失 → 跑 rollback-index.mjs --write 生成（否则只能靠人翻脚本名）',
  })

  details.push({
    title: '体检包索引（给 agent 用）',
    tail: [
      `1) 本报告（现场体检）`,
      `2) 症状 3 的时间轴全文（见下）`,
      `3) 恢复脚本清单 ${scripts.length} 个：${scripts.slice(0, 12).map((s) => s.name).join(', ')}${scripts.length > 12 ? ' …' : ''}`,
      `4) 历史线索：${kb.slice(0, 7).join(', ')}${kb.length > 7 ? ' …' : ''}`,
      `5) 自愈报告：${reports.slice(-5).join(', ')}${reports.length > 5 ? ' …' : ''}`,
      `6) 回滚脚本索引：${rIdx.exists ? rIdx.path : '（缺失，建议先生成：node rollback-index.mjs --write）'}`,
      ``,
      `把本文件路径直接发给 AI/同事，并说明：请据此判断该跑哪个恢复入口 / 该怎么修。`,
    ],
  })
  details.push({ title: '时间轴全文（症状 3）', tail: renderTimeline(s3.timeline, { limit: opts.limit ?? 40 }).split('\n') })

  const advice = [
    '**你不在场 / 不会跑**：把这份报告的路径发给 AI/同事，一句话说明「这是急救台体检包，请判断该跑哪个入口」。',
    `**脚本失败**：本报告与日志都在 ${LOGS_DIR}（firstaid-*.md|log）；退出码非 0 表示发现异常（🔴）。`,
    '本体检包**不改任何文件**（诊断只读）—— 请把判断权交给 AI/同事，别自行试跑恢复脚本。',
  ]

  return { symptom: 5, title: '症状 5 · 不知道怎么了（一键体检包）', checks, details, verdict: worst, advice, sub: parts }
}

// ─────────────────────────── 渲染 + 落盘 ───────────────────────────
function render(result, { json = false } = {}) {
  const L = []
  const head = reportHeader({
    title: `现场体检报告 · ${result.title}`,
    symptoms: `${result.symptom} · ${result.title.replace(/^症状 \d+ · /, '')}`,
  })
  L.push(...head)
  L.push('## 结论', '')
  L.push(`**${result.verdict.level === 'OK' ? '🟢' : result.verdict.level === 'WARN' ? '🟡' : '🔴'} ${result.verdict.text}**`)
  L.push('')

  L.push('## 逐项体检', '')
  L.push('| 判据 | 状态 | 值 | 说明 |', '|---|---|---|---|')
  for (const c of result.checks) {
    L.push(`| ${c.name} | ${c.sev} | ${String(c.value ?? '').replace(/\|/g, '\\|')} | ${String(c.detail ?? '').replace(/\|/g, '\\|')} |`)
  }
  L.push('')

  L.push('## 处置建议', '')
  for (const a of result.advice) L.push(`- ${a}`)
  L.push('')

  for (const d of result.details) {
    L.push(`## ${d.title}`, '')
    if (d.tail) L.push('```', ...d.tail, '```', '')
  }

  L.push('## 两个出口', '')
  L.push(`- **你不在场 / 不会跑**：把本报告路径发给 AI/同事，一句话：「急救台体检包（${result.title}），请判断该跑哪个入口」。`)
  L.push(`- **脚本失败**：报告与日志落在 \`${LOGS_DIR}\` 下的 \`firstaid-<时间戳>.md\` / \`.log\`；退出码 0=正常 · 1=发现异常 · 2=用法 · 3=工具自身跑不动。`)
  L.push('- **本脚本只读**：除写报告/日志外不改任何文件；任何回滚/重启都是写动作，须人工确认 + 写前快照。')
  L.push('')

  if (json) {
    L.push('## 机读结果（JSON）', '')
    L.push('```json')
    L.push(JSON.stringify({
      schemaVersion: 1,
      symptom: result.symptom,
      verdict: result.verdict.level,
      verdictText: result.verdict.text,
      host: hostName(),
      generatedAt: new Date().toISOString(),
      checks: result.checks.map((c) => ({ name: c.name, sev: c.sev, value: c.value, detail: c.detail })),
      extra: result.extra || null,
    }, null, 2))
    L.push('```', '')
  }
  return L.join('\n')
}

// ─────────────────────────── CLI ───────────────────────────
const SYMPTOMS = [
  { n: 1, key: '1', title: '打不开 / 起不来', desc: '守护进程数 · 服务端口 · 状态文件 · 日志尾部 · 崩溃次数 → 三条处置建议' },
  { n: 2, key: '2', title: '界面假死 / 一直转圈', desc: '连接池与进程诊断 → 指向「完全退出 Chrome 重开」/ 重启闸门' },
  { n: 3, key: '3', title: '刚改完的东西想撤销', desc: '→ 改动时间轴（选序号回滚；缺备份标红禁一键）' },
  { n: 4, key: '4', title: '数据 / 文件被删', desc: '指到冷盘与镜像备份，给出可恢复范围（不承诺不可恢复的东西）' },
  { n: 5, key: '5', title: '不知道怎么了', desc: '一键生成「体检包」：进程/端口/日志尾/最近改动/备份可用性 → 交给 agent' },
]

function usage() {
  return [
    'firstaid v0.1（只读诊断 · 零第三方依赖）—— 出事时只有这一个入口',
    '',
    '用法：node firstaid.mjs --symptom <1-5> [选项]',
    '      node firstaid.mjs --list',
    '',
    '症状菜单：',
    ...SYMPTOMS.map((s) => `  ${s.n}) ${s.title} —— ${s.desc}`),
    '',
    '选项：',
    '  --symptom <1-5>   症状编号（也可用 --s1 .. --s5）',
    '  --list            只打印菜单',
    '  --days <N>        时间轴窗口（症状 3/5，默认 7）',
    '  --limit <N>       时间轴打印条数（默认 40）',
    '  --no-archive      时间轴不读回滚点根兜底',
    '  --json            报告附机读 JSON 段',
    '  --quiet           屏幕只打摘要（报告照常落盘）',
    '  --probe-timeout <ms>  HTTP 探活超时（默认 5000）',
    '  --help',
    '',
    `产出：${LOGS_DIR} 下 firstaid-<ts>.md（现场体检报告）+ .log（运行日志）`,
    '退出码：0 未发现异常 · 1 发现异常 · 2 用法错误 · 3 环境不可用（报告写不出）',
  ].join('\n')
}

function parseArgv(argv) {
  const o = { symptom: null, list: false, days: 7, limit: 40, archive: true, json: false, quiet: false, probeTimeoutMs: 5000, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => { const v = argv[++i]; if (v === undefined) { console.error(`✗ 参数 ${a} 缺值`); process.exit(EXIT_USAGE) } return v }
    switch (a) {
      case '--symptom': o.symptom = Number(next()); break
      case '--s1': case '--s2': case '--s3': case '--s4': case '--s5': o.symptom = Number(a.slice(3)); break
      case '--list': o.list = true; break
      case '--days': o.days = Number(next()); break
      case '--limit': o.limit = Number(next()); break
      case '--no-archive': o.archive = false; break
      case '--json': o.json = true; break
      case '--quiet': o.quiet = true; break
      case '--probe-timeout': o.probeTimeoutMs = Number(next()); break
      case '--help': case '-h': o.help = true; break
      default:
        console.error(`✗ 未知参数 ${a}`)
        console.error(usage())
        process.exit(EXIT_USAGE)
    }
  }
  if (o.symptom !== null && (!Number.isInteger(o.symptom) || o.symptom < 1 || o.symptom > 5)) {
    console.error(`✗ --symptom 只接受 1-5（收到 ${o.symptom}）`)
    process.exit(EXIT_USAGE)
  }
  return o
}

async function main() {
  const o = parseArgv(process.argv.slice(2))
  if (o.help || o.list) {
    console.log(usage())
    return EXIT_OK
  }
  if (o.symptom === null) {
    console.log(usage())
    console.error('')
    console.error('✗ 缺少 --symptom <1-5>（急救台不做默认动作，避免出事时误跑）')
    return EXIT_USAGE
  }

  const runOpts = { days: o.days, limit: o.limit, archive: o.archive, probeTimeoutMs: o.probeTimeoutMs }
  const t0 = Date.now()
  let result
  try {
    result = await (o.symptom === 1 ? symptom1
      : o.symptom === 2 ? symptom2
        : o.symptom === 3 ? symptom3
          : o.symptom === 4 ? symptom4 : symptom5)(runOpts)
  } catch (e) {
    // 急救台自身异常也必须留证据、也必须非零退出（不许崩成裸堆栈、不许静默）
    const md = reportHeader({ title: `现场体检报告 · 症状 ${o.symptom}（诊断中断）`, symptoms: `${o.symptom}（诊断中断）` }).join('\n')
      + `\n**🔴 急救台诊断过程异常**：${e && e.message}\n\n\`\`\`\n${e && e.stack}\n\`\`\`\n`
      + `\n## 出口\n\n- 把本报告交给 agent（诊断脚本自身出错）；\n- 或改用症状 5 生成体检包。\n`
    const w = writeArtifact('firstaid', 'md', md)
    writeArtifact('firstaid', 'log', `[${humanTime()}] symptom=${o.symptom} EXCEPTION ${e && e.message}\n${e && e.stack}\n`)
    console.error(md)
    console.error(`✗ 诊断异常（已落盘${w.ok ? `：${w.path}` : '失败'}）`)
    return EXIT_BAD
  }

  const elapsedMs = Date.now() - t0
  const md = render(result, { json: o.json })
    + `\n---\n\n*诊断耗时 ${(elapsedMs / 1000).toFixed(1)}s · 报告生成 ${humanTime()} · 设备 ${hostName()} · 症状 ${result.symptom}*\n`
    + `*落盘位置：${LOGS_DIR}*\n`

  const w = writeArtifact('firstaid', 'md', md)
  const logLine = [
    `[${humanTime()}] symptom=${result.symptom} verdict=${result.verdict.level} checks=${result.checks.length} elapsed=${elapsedMs}ms host=${hostName()}`,
    `报告：${w.ok ? w.path : '（写盘失败）'}`,
    ...result.checks.map((c) => `  ${c.sev} ${c.name} = ${c.value}`),
    ...result.advice.map((a) => `  建议：${a}`),
    '',
  ].join('\n')
  const wl = writeArtifact('firstaid', 'log', logLine)

  if (!w.ok) {
    console.error(md)
    console.error(`\n✗ 报告无法落盘：${w.error}`)
    console.error(`  工具环境不可用（退出码 3）——请检查日志目录是否可写：${LOGS_DIR}`)
    return EXIT_ENV
  }

  if (o.quiet) {
    console.log(`症状 ${result.symptom}：${result.verdict.level === 'OK' ? '🟢' : result.verdict.level === 'WARN' ? '🟡' : '🔴'} ${result.verdict.text}`)
    // 症状 1/2/4 的**定义性判据多半是 🟢**（守护进程在岗、端口在听、连接数、冷盘在线）——
    // 只打 🟡/🔴 会把最关键的数字藏起来（2026-09-12 单测 C2/C7 抓到：屏幕只剩一条无关告警）。
    // 故这三类**全打判据**；症状 3/5 的判据是统计量，只打 🟡/🔴（报告里有全量）。
    const showAll = [1, 2, 4].includes(result.symptom)
    for (const c of result.checks) {
      if (showAll || c.sev === SEV.BAD || c.sev === SEV.WARN) {
        console.log(`  ${c.sev} ${c.name} = ${c.value} —— ${c.detail}`)
      }
    }
    for (const a of result.advice) console.log(`  · ${a}`)
    console.log('')
    console.log(`报告：${w.path}`)
    console.log(`日志：${wl.ok ? wl.path : '（写盘失败）'}`)
  } else {
    console.log(md)
    console.log(`报告：${w.path}`)
    console.log(`日志：${wl.ok ? wl.path : '（写盘失败）'}`)
  }
  if (w.degraded) console.error(`⚠ ${LOGS_DIR} 不可写，报告已降级到临时目录（如实标注，不静默）`)

  // 退出码语义：只看 🔴；🟡 返回 0（否则正常态也会「有异常」，指标就废了）
  return result.verdict.level === 'BAD' ? EXIT_BAD : EXIT_OK
}

function isMainEntry() {
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url))
    const argv1 = process.argv[1] ? fs.realpathSync(process.argv[1]) : ''
    return self.toLowerCase() === argv1.toLowerCase()
  } catch { return false }
}

if (isMainEntry()) {
  main().then((code) => { process.exitCode = code }).catch((e) => {
    console.error(`✗ firstaid.mjs 异常：${e && e.message}`)
    console.error(e && e.stack)
    process.exitCode = EXIT_ENV
  })
}

export { EXIT_OK, EXIT_BAD, EXIT_USAGE, EXIT_ENV, usage }
