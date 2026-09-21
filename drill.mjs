#!/usr/bin/env node
/**
 * drill.mjs —— 恢复点演练编排器
 *
 * 一句话：把「造坏 → 恢复 → 验活 → 还原现场」变成一条命令，并产出演练记录。
 *
 * 三档演练：
 *   L1 沙箱级  --sandbox（默认）：**不碰目标环境**。验证「备份源确实能复原目标」+（给 --sandbox-cmd 时）真跑脚本到沙箱；
 *                                  结尾强断言**目标文件 hash 前后一致**。
 *   L2 真实级  --live --yes     ：真造坏 → 真跑恢复 → 真验活 → **结束时把现场还原成演练开始的样子**。
 *   L3 需停机  ：不在本脚本职责内（停机/重启由编排器或人工执行，本脚本可作为其中一步被调用）。
 *
 * 设计约束：
 *   · 零第三方依赖：只用 node 内置模块，**不 import 任何 npm 包**——宿主服务崩了它也得能跑。
 *   · 不留痕：L2 无论成功失败都必须还原现场（finally 兜底），失败也要如实记录。
 *   · 可机读：产出 drill-record-<ts>.md + .json，退出码即结论（0=PASS / 1=FAIL / 2=用法 / 3=环境不可用）。
 *
 * 用法：
 *   node drill.mjs --point <回滚点目录> --target <目标文件>[=<备份源相对路径>] [--target ...] \
 *                  [--restore <恢复脚本.mjs>] [--restore-args "<参数...>"] [--probe "<验活命令>"] \
 *                  [--plan | --sandbox | --live --yes] [--break-mode overwrite|remove] [--json]
 *
 *   备份源相对路径省略时默认 `before/<目标文件名>`。
 *   --restore 省略时自动探测回滚点内唯一的 restore-*.mjs。
 *   --sandbox-cmd / --sandbox-args 用于「脚本级沙箱」（args 里用 {SANDBOX} 占位临时根）。
 *
 * 示例（路径按你的环境替换）：
 *   node drill.mjs --point "<回滚点根>\<点>" --target "<工作区>\docs\x.md" --plan
 *   node drill.mjs --point "<回滚点根>\<点>" --target "<工作区>\docs\x.md"            # L1
 *   node drill.mjs --point "<回滚点根>\<点>" --target "<工作区>\docs\x.md" --live --yes  # L2
 *
 * 退出码：0=PASS · 1=FAIL（演练未通过）· 2=用法或前置错误 · 3=环境不可用
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { resolveWorkspace, resolveHome } from './lib/runtime-config.mjs'

const EXIT_PASS = 0
const EXIT_FAIL = 1
const EXIT_USAGE = 2
const EXIT_ENV = 3
const BREAK_MARK = 'DRILL-BROKEN'
/** 相对键的基准根：工作区根优先、其次数据根（两者都可被环境变量改道，包里不写死盘符）。 */
const REL_ROOT = resolveWorkspace() || resolveHome()

// ─────────────────────────── 基础工具 ───────────────────────────
function sha256(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') } catch { return null }
}
function exists(p) { try { fs.statSync(p); return true } catch { return false } }
function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
}
function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
function humanTime() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
/** 稳定的短键：在基准根下用相对路径，否则用文件名（跨卷时 path.relative 会返回绝对路径，必须挡掉） */
function relKey(p) {
  const rel = path.relative(REL_ROOT, p)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return path.basename(p)
  return rel
}
function fail(msg) {
  console.error(`✗ ${msg}`)
  console.error('（用 --help 看用法）')
  process.exit(EXIT_USAGE)
}

// ─────────────────────────── 参数解析 ───────────────────────────
function usageText() {
  return [
    'drill.mjs —— 恢复点演练编排器',
    '',
    '必需：',
    '  --point <dir>            回滚点目录（<回滚点根>\\<任务>-<时间戳>\\）',
    '  --target <dst>[=<bakRel>] 受影响的目标文件；= 后为备份源相对路径（默认 before/<文件名>），可多次',
    '',
    '可选：',
    '  --restore <script.mjs>   恢复脚本（默认自动探测回滚点内唯一的 restore-*.mjs）',
    '  --restore-args "<args>"  传给恢复脚本的参数（空格分隔）',
    '  --probe "<cmd>"          验活命令（shell 执行，exit 0 判通过）',
    '  --sandbox-cmd <script>   脚本级沙箱：在沙箱里真跑该脚本',
    '  --sandbox-args "<args>"  沙箱脚本参数；⚠️ {SANDBOX} = 沙箱 root **本身**（别再拼 /root → root\\root 双拼，脚本会 ENOENT）',
    '                           例：--sandbox-args "--apply --root={SANDBOX}"（要求恢复脚本支持 --root=<dir>，默认目标根）',
    '  --break-mode overwrite|remove  造坏方式（默认 overwrite 写入 DRILL-BROKEN）',
    '  --plan | --sandbox | --live     演练档（默认 sandbox=L1；--live 必须配 --yes）',
    '  --yes                    L2 真实演练的确认开关',
    '  --json                   额外把记录 JSON 打到 stdout',
    '  --help',
  ].join('\n')
}

function parseArgs(argv) {
  const opt = {
    point: null, targets: [], restore: null, restoreArgs: [], probe: null,
    sandboxCmd: null, sandboxArgs: [], breakMode: 'overwrite',
    mode: null, yes: false, json: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) fail(`参数 ${a} 缺少值`)
      return v
    }
    switch (a) {
      case '--point': opt.point = next(); break
      case '--target': opt.targets.push(next()); break
      case '--restore': opt.restore = next(); break
      case '--restore-args': opt.restoreArgs = next().split(/\s+/).filter(Boolean); break
      case '--probe': opt.probe = next(); break
      case '--sandbox-cmd': opt.sandboxCmd = next(); break
      case '--sandbox-args': opt.sandboxArgs = next().split(/\s+/).filter(Boolean); break
      case '--break-mode': opt.breakMode = next(); break
      case '--plan': opt.mode = 'plan'; break
      case '--sandbox': opt.mode = 'sandbox'; break
      case '--live': opt.mode = 'live'; break
      case '--yes': opt.yes = true; break
      case '--json': opt.json = true; break
      case '--help': case '-h': console.log(usageText()); process.exit(EXIT_PASS); break
      default: fail(`未知参数 ${a}`)
    }
  }
  return opt
}

// ─────────────────────────── 目标与前置 ───────────────────────────
function resolveTargets(opt, point) {
  return opt.targets.map((spec) => {
    const idx = spec.indexOf('=')
    const dstRaw = idx >= 0 ? spec.slice(0, idx) : spec
    const bakRel = idx >= 0 ? spec.slice(idx + 1) : path.join('before', path.basename(dstRaw))
    const dst = path.resolve(dstRaw)
    const bak = path.isAbsolute(bakRel) ? bakRel : path.join(point, bakRel)
    return { dst, bak, bakRel }
  })
}

function detectRestore(point) {
  let names = []
  try { names = fs.readdirSync(point).filter((n) => /^restore-.*\.mjs$/i.test(n)) } catch { /* ignore */ }
  if (names.length === 1) return { script: path.join(point, names[0]) }
  if (names.length === 0) return { script: null, note: '回滚点内没有 restore-*.mjs' }
  return { script: null, error: `回滚点内有多个 restore-*.mjs，请用 --restore 指定：${names.join(', ')}` }
}

function preflight(targets, restoreScript, mode) {
  const problems = []
  for (const t of targets) {
    if (!exists(t.dst)) problems.push(`目标文件不存在：${t.dst}`)
    if (!exists(t.bak)) problems.push(`备份源不存在：${t.bak}`)
  }
  if (mode === 'live') {
    if (!restoreScript) problems.push('L2 真实演练必须指定恢复脚本（--restore 或自动探测）')
    else if (!exists(restoreScript)) problems.push(`恢复脚本不存在：${restoreScript}`)
  } else if (restoreScript && !exists(restoreScript)) {
    problems.push(`恢复脚本不存在：${restoreScript}`)
  }
  return problems
}

// ─────────────────────────── L1 沙箱 ───────────────────────────
function runSandbox(ctx) {
  const steps = []
  const beforeHashes = ctx.targets.map((t) => sha256(t.dst))
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-l1-'))

  // ① 备份源可复原性：把备份源复制成沙箱目标，断言字节一致
  for (const [i, t] of ctx.targets.entries()) {
    const sbFile = path.join(tmp, 'restore-check', relKey(t.dst))
    let ok = false
    let detail = ''
    try {
      copyFile(t.bak, sbFile)
      const a = sha256(t.bak), b = sha256(sbFile)
      ok = a !== null && a === b
      detail = `备份源 ${String(a).slice(0, 12)} → 沙箱副本 ${String(b).slice(0, 12)}`
    } catch (e) {
      detail = `复制失败：${e.message}`
    }
    steps.push({ name: `备份源可复原：${relKey(t.dst)}`, ok, detail })
    void i
  }

  // ② 可选：脚本级沙箱（在沙箱里真跑恢复脚本，断言沙箱内目标 == 备份源）
  if (ctx.opt.sandboxCmd) {
    const sbRoot = path.join(tmp, 'root')
    fs.mkdirSync(sbRoot, { recursive: true })
    for (const t of ctx.targets) {
      // 沙箱里先放"当前目标文件"，模拟改动后状态
      if (exists(t.dst)) copyFile(t.dst, path.join(sbRoot, relKey(t.dst)))
    }
    const args = ctx.opt.sandboxArgs.map((a) => a.replace(/\{SANDBOX\}/g, sbRoot))
    const r = spawnSync(process.execPath, [ctx.opt.sandboxCmd, ...args], { encoding: 'utf8', cwd: ctx.point })
    steps.push({
      name: '脚本级沙箱：恢复脚本在沙箱内执行',
      ok: r.status === 0,
      detail: `exit=${r.status}${r.status !== 0 ? ` · ${(r.stderr || '').trim().split('\n').slice(-3).join(' / ')}` : ''}`,
    })
    for (const t of ctx.targets) {
      const sbFile = path.join(sbRoot, relKey(t.dst))
      const want = sha256(t.bak), got = sha256(sbFile)
      steps.push({
        name: `脚本级沙箱：沙箱内回落断言 ${relKey(t.dst)}`,
        ok: want !== null && want === got,
        detail: `期望 ${String(want).slice(0, 12)} 实际 ${String(got).slice(0, 12)}`,
      })
    }
  }

  // ③ 目标零改动强断言
  const afterHashes = ctx.targets.map((t) => sha256(t.dst))
  const changed = ctx.targets.filter((t, i) => beforeHashes[i] !== afterHashes[i]).map((t) => relKey(t.dst))
  steps.push({
    name: '目标文件未被改动（沙箱演练强断言）',
    ok: changed.length === 0,
    detail: changed.length === 0 ? `${ctx.targets.length} 个目标 hash 前后一致` : `被改动了：${changed.join(', ')}`,
  })

  fs.rmSync(tmp, { recursive: true, force: true })
  return { steps, tmp }
}

// ─────────────────────────── L2 真实 ───────────────────────────
function runLive(ctx) {
  const steps = []
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-l2-'))

  // ① 现场快照（还原现场用）
  const snapshot = ctx.targets.map((t) => {
    const existed = exists(t.dst)
    const snapFile = path.join(tmp, 'snapshot', relKey(t.dst))
    if (existed) copyFile(t.dst, snapFile)
    return { dst: t.dst, existed, snapFile, sha: existed ? sha256(t.dst) : null }
  })
  steps.push({
    name: '现场快照（演练后还原用）',
    ok: true,
    detail: `${snapshot.filter((s) => s.existed).length} 个文件已快照 / ${snapshot.filter((s) => !s.existed).length} 个原本不存在`,
  })

  let restoreOutput = ''
  try {
    // ② 造坏
    for (const t of ctx.targets) {
      if (ctx.opt.breakMode === 'remove') fs.rmSync(t.dst, { force: true })
      else {
        fs.mkdirSync(path.dirname(t.dst), { recursive: true })
        fs.writeFileSync(t.dst, `${BREAK_MARK} ${new Date().toISOString()}\n`, 'utf8')
      }
    }
    const breakOk = ctx.targets.every((t, i) => sha256(t.dst) !== snapshot[i].sha)
    steps.push({
      name: `造坏（${ctx.opt.breakMode === 'remove' ? '删除' : '写入 DRILL-BROKEN'}）`,
      ok: breakOk,
      detail: breakOk ? `${ctx.targets.length} 个目标状态已改变` : '有目标状态未改变（造坏无效）',
    })

    // ③ 跑恢复
    const r = spawnSync(process.execPath, [ctx.restoreScript, ...ctx.opt.restoreArgs], {
      encoding: 'utf8',
      cwd: ctx.point,
    })
    restoreOutput = `${r.stdout || ''}${r.stderr || ''}`.trim()
    steps.push({
      name: '执行恢复脚本',
      ok: r.status === 0,
      detail: `exit=${r.status} · ${path.basename(ctx.restoreScript)}${restoreOutput ? ` · ${restoreOutput.split('\n').slice(-2).join(' / ').slice(0, 200)}` : ''}`,
    })

    // ④ 回落断言
    for (const [i, t] of ctx.targets.entries()) {
      const want = sha256(t.bak)
      const got = sha256(t.dst)
      steps.push({
        name: `回落断言：${relKey(t.dst)}`,
        ok: want !== null && want === got,
        detail: `期望(备份源) ${String(want).slice(0, 12)} · 实际(恢复后) ${String(got).slice(0, 12)} · 演练前 ${String(snapshot[i].sha).slice(0, 12)}`,
      })
    }

    // ⑤ 验活探针
    if (ctx.opt.probe) {
      const p = spawnSync(ctx.opt.probe, { shell: true, encoding: 'utf8' })
      steps.push({
        name: '验活探针',
        ok: p.status === 0,
        detail: `exit=${p.status} · ${String(p.stdout || '').trim().split('\n').slice(-3).join(' / ').slice(0, 200)}`,
      })
    }
  } finally {
    // ⑥ 还原现场（无论成败）
    let restoredAll = true
    for (const s of snapshot) {
      try {
        if (s.existed) copyFile(s.snapFile, s.dst)
        else fs.rmSync(s.dst, { force: true })
        if (s.existed && sha256(s.dst) !== s.sha) restoredAll = false
      } catch { restoredAll = false }
    }
    steps.push({
      name: '还原现场（演练前状态写回）',
      ok: restoredAll,
      detail: restoredAll ? '全部目标已回到演练开始时的字节状态' : '有目标未能还原（需人工检查！）',
    })
  }

  fs.rmSync(tmp, { recursive: true, force: true })
  return { steps, restoreOutput }
}

// ─────────────────────────── 记录 ───────────────────────────
function allOk(steps) { return steps.length > 0 && steps.every((s) => s.ok) }

function writeRecord(ctx, steps, extra = {}) {
  const ts = stamp()
  const level = ctx.mode === 'live' ? 'L2 真实级·无需停机' : 'L1 沙箱级'
  const verdict = allOk(steps) ? 'PASS' : 'FAIL'
  const md = [
    `# 演练记录 · ${path.basename(ctx.point)} · ${level}`,
    '',
    `- **时间**：${humanTime()}`,
    `- **操作者**：firstaid-cli（自动化）· 设备 ${process.env.COMPUTERNAME || os.hostname()}`,
    `- **回滚点**：\`${ctx.point}\``,
    `- **演练级别**：${level}`,
    `- **恢复脚本**：${ctx.restoreScript ? `\`${ctx.restoreScript}\`` : '（未提供）'}`,
    `- **造坏方式**：${ctx.mode === 'live' ? (ctx.opt.breakMode === 'remove' ? '删除目标文件' : `写入 \`${BREAK_MARK}\``) : '不造坏（沙箱验证备份可复原性）'}`,
    `- **验活判据**：${ctx.opt.probe ? `探针 \`${ctx.opt.probe}\`` : '文件 sha256 回落到备份源'} + 目标 hash 前后比对`,
    `- **目标影响面**：${ctx.mode === 'live' ? '是（真实文件，演练结束已还原现场）' : '否（沙箱）'}`,
    `- **残留清理**：临时目录已删除；现场已还原`,
    `- **结论**：**${verdict}**`,
    '',
    '| # | 步骤 | 结果 | 说明 |',
    '|---|---|---|---|',
    ...steps.map((s, i) => `| ${i + 1} | ${s.name} | ${s.ok ? '✅' : '❌'} | ${String(s.detail || '').replace(/\|/g, '\\|')} |`),
    '',
  ].join('\n')

  const json = {
    drillVersion: 1,
    point: ctx.point,
    mode: ctx.mode,
    level,
    verdict,
    time: humanTime(),
    host: process.env.COMPUTERNAME || os.hostname(),
    restoreScript: ctx.restoreScript,
    breakMode: ctx.mode === 'live' ? ctx.opt.breakMode : null,
    probe: ctx.opt.probe,
    targets: ctx.targets.map((t) => ({ dst: t.dst, bak: t.bak, bakRel: t.bakRel })),
    steps,
    ...extra,
  }

  const mdPath = path.join(ctx.point, `drill-record-${ts}.md`)
  const jsonPath = path.join(ctx.point, `drill-record-${ts}.json`)
  try {
    fs.writeFileSync(mdPath, md, 'utf8')
    fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2), 'utf8')
  } catch (e) {
    console.error(`⚠ 记录写入失败（回滚点可能只读）：${e.message}`)
    return { mdPath: null, jsonPath: null, verdict }
  }
  return { mdPath, jsonPath, verdict }
}

// ─────────────────────────── 主流程 ───────────────────────────
function main() {
  const opt = parseArgs(process.argv.slice(2))
  if (!opt.point) fail('缺少 --point <回滚点目录>')
  if (!opt.targets.length) fail('缺少 --target <目标文件>[=<备份源相对路径>]')

  const pointRaw = path.resolve(opt.point)
  if (!exists(pointRaw)) {
    console.error(`环境不可用：回滚点目录不存在 ${pointRaw}`)
    process.exit(EXIT_ENV)
  }
  const point = fs.realpathSync(pointRaw) // junction 一律用物理路径
  const mode = opt.mode || 'sandbox'
  if (mode === 'live' && !opt.yes) fail('L2 真实演练会真的改目标文件，必须显式加 --yes')

  const targets = resolveTargets(opt, point)
  let restoreScript = opt.restore ? path.resolve(opt.restore) : null
  let restoreNote = ''
  if (!restoreScript) {
    const d = detectRestore(point)
    if (d.error) { if (mode === 'live') fail(d.error); restoreNote = d.error }
    else { restoreScript = d.script; restoreNote = d.script ? '' : (d.note || '') }
  }

  const problems = preflight(targets, restoreScript, mode)
  if (problems.length) {
    console.error('前置检查未通过：')
    for (const p of problems) console.error(`  · ${p}`)
    process.exit(mode === 'live' ? EXIT_USAGE : EXIT_ENV)
  }

  const ctx = { opt, point, targets, restoreScript, mode }
  const level = mode === 'live' ? 'L2' : 'L1'

  console.log(`=== drill · ${level} · ${path.basename(point)} ===`)
  console.log(`回滚点   : ${point}`)
  console.log(`恢复脚本 : ${restoreScript || '（未提供，仅验证备份可复原性）'}${restoreNote ? `（${restoreNote}）` : ''}`)
  for (const t of targets) {
    console.log(`目标     : ${t.dst}`)
    console.log(`  备份源 : ${t.bak}  [当前 ${String(sha256(t.dst)).slice(0, 12)} / 备份 ${String(sha256(t.bak)).slice(0, 12)}]`)
  }

  if (mode === 'plan') {
    console.log('')
    console.log('（--plan 只打印计划，不执行任何动作）')
    console.log(`将执行：${mode === 'live' ? '造坏 → 恢复 → 回落断言 → 还原现场' : '备份可复原性验证 → 目标零改动断言'}`)
    process.exit(EXIT_PASS)
  }

  // 提示：目标当前已等于备份源时，演练判别力下降
  const alreadySame = targets.filter((t) => sha256(t.dst) !== null && sha256(t.dst) === sha256(t.bak))
  if (alreadySame.length) {
    console.log('')
    console.log(`⚠ 提示：${alreadySame.length} 个目标当前内容已等于备份源（${alreadySame.map((t) => relKey(t.dst)).join(', ')}）——L2 回落断言仍有效，但判别力有限`)
  }

  console.log('')
  let steps
  try {
    steps = (mode === 'live' ? runLive(ctx) : runSandbox(ctx)).steps
  } catch (e) {
    // 编排器自身出错也要留证据、也要能被判 FAIL（不许崩成裸堆栈）
    steps = [{ name: '演练编排器异常', ok: false, detail: `${e.message}` }]
    if (mode === 'live') {
      console.error('⚠ 异常发生在真实演练中——请人工核对目标文件是否已还原！')
    }
  }
  for (const [i, s] of steps.entries()) {
    console.log(`  ${s.ok ? '✓' : '✗'} ${i + 1}. ${s.name}${s.detail ? `\n        ${s.detail}` : ''}`)
  }

  const { mdPath, jsonPath, verdict } = writeRecord(ctx, steps)
  console.log('')
  console.log(`结论：${verdict}`)
  if (mdPath) console.log(`记录：${mdPath}`)
  if (jsonPath) console.log(`记录：${jsonPath}`)
  if (opt.json && jsonPath) console.log(fs.readFileSync(jsonPath, 'utf8'))

  process.exit(verdict === 'PASS' ? EXIT_PASS : EXIT_FAIL)
}

main()
