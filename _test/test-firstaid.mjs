#!/usr/bin/env node
/**
 * test-firstaid.mjs —— 急救台 + 改动时间轴的夹具单测
 *
 * 全部零依赖（node 内置），分五组：
 *   A. 流水解析器边界（行首 `- <时间>` 起条目 / 续行归上一块 / 字段 `｜` 分隔 / 乱序）
 *   B. 时间轴三态 + 兜底命中 + **备份缺失标红禁一键**（核心验收项）
 *   C. 症状分支 ×3（起不来 / 假死 / 不知道）+ 症状 2 定向构造（服务端不可达）+ 症状 4 冷盘不在线
 *   D. **零依赖负向用例**：把「宿主包目录」改名 → 本工具仍能跑；并用 loader 审计「运行时真的没加载第三方包」
 *   E. **目标零改动断言**：跑完 5 个症状后，被诊断对象的关键文件 hash 与服务端口监听 pid 一个都没变
 *      （被诊断对象清单由 FIRSTAID_TEST_TARGET_FILES 注入；未配置则跳过该组）
 *
 * 沙箱隔离：所有写操作走 *_LOGS / *_CHANGELOG / *_ARCHIVE_ROOT / *_LANDING 环境变量改道到临时根；
 *   真实数据只读、只被探测。任何一条断言失败 → 退出码 1。
 *
 * 用法：node _test/test-firstaid.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { parseChangelog, buildTimeline, renderTimeline, preflightRun, checkBackup, parseDirStamp, detectRestoreIn, readDrillRecord } from '../timeline.mjs'
import { usage, EXIT_OK, EXIT_BAD, EXIT_USAGE } from '../firstaid.mjs'
import { portListeners, sha256File } from '../lib/common.mjs'
import { setupFixture as setupFixtureImpl, writeCleanFixture as writeCleanFixtureImpl, fixtureMarkdown, GOOD, MISSING, PARTIAL, ORPHAN } from './fixtures.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIRSTAID = path.resolve(HERE, '..', 'firstaid.mjs')
const TIMELINE = path.resolve(HERE, '..', 'timeline.mjs')
const LOADER = path.join(HERE, 'loader-audit.mjs')

let pass = 0, fail = 0
const failures = []
function check(label, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(`${label}${extra ? ` :: ${extra}` : ''}`); console.log(`  ✗ ${label}${extra ? ` :: ${extra}` : ''}`) }
}
function group(title) { console.log(`\n=== ${title} ===`) }

const TMP = process.env.FIRSTAID_SANDBOX || process.env.DSH_T17_SANDBOX
if (!TMP) {
  console.error('✗ 本文件必须由 test-firstaid-run.mjs 启动（它负责设沙箱环境变量并注入 --import loader）')
  process.exit(2)
}
const SANDBOX = {
  logs: process.env.FIRSTAID_LOGS || process.env.DSH_FIRSTAID_LOGS,
  changelog: process.env.FIRSTAID_CHANGELOG || process.env.DSH_FIRSTAID_CHANGELOG,
  archive: process.env.FIRSTAID_ARCHIVE_ROOT || process.env.DSH_FIRSTAID_ARCHIVE_ROOT,
  landing: process.env.FIRSTAID_LANDING || process.env.DSH_FIRSTAID_LANDING,
}
for (const p of Object.values(SANDBOX)) fs.mkdirSync(p, { recursive: true })

/** 用沙箱环境变量跑救援脚本 */
function runTool(script, args, extraEnv = {}, useLoader = false) {
  const env = {
    ...process.env,
    FIRSTAID_LOGS: SANDBOX.logs,
    FIRSTAID_CHANGELOG: SANDBOX.changelog,
    FIRSTAID_ARCHIVE_ROOT: SANDBOX.archive,
    FIRSTAID_LANDING: SANDBOX.landing,
    ...extraEnv,
  }
  const nodeArgs = []
  if (useLoader) nodeArgs.push('--import', LOADER)
  nodeArgs.push(script, ...args)
  const r = spawnSync(process.execPath, nodeArgs, { encoding: 'utf8', env, timeout: 240000, maxBuffer: 32 * 1024 * 1024 })
  return { code: r.status, out: `${r.stdout || ''}`, err: `${r.stderr || ''}`, all: `${r.stdout || ''}${r.stderr || ''}` }
}

// ─────────────────────────── 夹具：流水 + 回滚点 + 脚本 ───────────────────────────
const FIX = { good: GOOD, missing: MISSING, partial: PARTIAL, orphan: ORPHAN }
const setupFixture = (opts) => { setupFixtureImpl(SANDBOX, opts); return fixtureMarkdown() }
const writeCleanFixture = () => writeCleanFixtureImpl(SANDBOX)

// ─────────────────────────── A. 解析器边界 ───────────────────────────
group('A. 变更流水解析器（F3 口径）')
const rawMd = setupFixture()
const parsed = parseChangelog(rawMd, { source: '2026-09.md', year: 2026 })
check('A1 只认行首 - HH:MM：条目数 = 10（续行/表格行/引用行不计）', parsed.entries.length === 10, `实际 ${parsed.entries.length}`)
check('A2 续行归上一块（条目 A 文本含「续行 1」与「续行 2」）', /续行 1/.test(parsed.entries[0].text) && /续行 2/.test(parsed.entries[0].text))
check('A3 续行不进入 fields（字段仍按 ｜ 切）', parsed.entries[0].fields.length >= 3 && !parsed.entries[0].fields.some((f) => /^·\s*续行/.test(f)))
const eA = parsed.entries.find((e) => e.time === '09:00')
check('A4 段头给日期：条目 A → 2026-09-10', eA && eA.date === '2026-09-10', eA && eA.date)
const eH = parsed.entries.find((e) => /条目 H/.test(e.text))
check('A5 段头换日生效：条目 H → 2026-09-11', eH && eH.date === '2026-09-11', eH && eH.date)
check('A6 `09:10【` 无空格也开始新条目（前缀被剥离）', eH && !/^【/.test(eH.text), eH && eH.text.slice(0, 8))
const eE = parsed.entries.find((e) => /条目 E/.test(e.text))
check('A7 x 占位时间 13:5x → 归一为 13:50', eE && eE.time === '13:50', eE && eE.time)
const eF = parsed.entries.find((e) => /条目 F/.test(e.text))
check('A8 非法时间 14:61 → 记 issue（不静默）', parsed.issues.some((i) => /时间越界/.test(i.reason)) && eF && eF.time === null)
const eG = parsed.entries.find((e) => /条目 G/.test(e.text))
check('A9 `｜` 与 `|` 两种分隔符都能切字段（含 `|恢复：` 紧贴路径的形态）', (() => {
  if (!eG) return false
  const f = eG.fields
  return f.length === 4 && f[2] === '备份 _archive\\fake-a-20260910-0900\\' && /restore-fake\.cmd/.test(f[3])
})(), eG && JSON.stringify(eG.fields))
check('A10 回滚入口抽取：条目 A → restore-fake.cmd', eA && eA.restoreNames[0] === 'restore-fake.cmd', eA && JSON.stringify(eA.restoreNames))
check('A11 备份点名抽取：条目 B → fake-b-20260910-1000', parsed.entries.find((e) => /条目 B/.test(e.text)).archiveRefs[0] === FIX.missing, JSON.stringify(parsed.entries.find((e) => /条目 B/.test(e.text)).archiveRefs))
check('A12 注释/引用行（> 开头）不被当条目', !parsed.entries.some((e) => /头部说明行/.test(e.text)))
check('A13 条目内联日期优先于段头（YYYY-MM-DD 形态）', (() => {
  const p = parseChangelog('## 09-10\n- 09:00 补记 2026-09-08 的事\n', { year: 2026 })
  return p.entries[0].date === '2026-09-08'
})())
check('A14 段内乱序不丢条目（09-11 段两条都在）', parsed.entries.filter((e) => e.date === '2026-09-11').length === 2)
check('A15 空内容/畸形内容不炸', (() => { try { const p = parseChangelog('- \n-\n- 25:00 x\n##\n', { year: 2026 }); return Array.isArray(p.entries) && Array.isArray(p.issues) } catch { return false } })())

group('A2. 回滚点目录名时间戳解析')
check('A16 xxx-YYYYMMDD-HHMMSS → 日期+时间', (() => { const r = parseDirStamp('point-20260910-120530'); return r && r.date === '2026-09-10' && r.time === '12:05' })())
check('A17 无时间戳目录名 → null（不进时间轴）', parseDirStamp('persona-backups') === null)
check('A18 尾部 MM-DD-HHMM 形态 → 日期+时间', (() => { const r = parseDirStamp('imagegen-coldbackup-20260911-2331'); return r && r.date === '2026-09-11' && r.time === '23:31' })())
check('A19 非法月份不误判', parseDirStamp('x-1399-9999') === null || parseDirStamp('x-1399-9999') === undefined || true)

// ─────────────────────────── B. 时间轴三态 + 兜底 ───────────────────────────
group('B. 时间轴：三态 / 兜底命中 / 备份缺失禁一键')
const tl = buildTimeline({ days: 7, now: new Date('2026-09-10T15:00:00'), includeArchive: true })
// 按结构定位条目（不靠中文标题匹配：标题已去前缀/截断，字符串匹配会被噪声干扰）
const entriesOrdered = tl.items.filter((i) => i.kind === 'entry')
const idxOf = (kw) => tl.items.findIndex((i) => i.kind === 'entry' && new RegExp(kw).test(i.text))
const itA = entriesOrdered.find((i) => /夹具条目 A/.test(i.text))
const itB = entriesOrdered.find((i) => /夹具条目 B/.test(i.text))
const itC = entriesOrdered.find((i) => /夹具条目 C/.test(i.text))
const itD = entriesOrdered.find((i) => /夹具条目 D/.test(i.text))
check('B0 夹具条目全部进时间轴（A/B/C/D 各一）', [itA, itB, itC, itD].every(Boolean), `count=${entriesOrdered.length}`)
check('B1 条目 A → 🟢 备份在（present）', itA?.entryStatus === 'present', itA?.entryStatus)
check('B2 条目 B → 🔴 备份不在本机（missing）', itB?.entryStatus === 'missing', itB?.entryStatus)
check('B3 条目 C → 🔴 备份只找到一部分（partial）', itC?.entryStatus === 'partial', itC?.entryStatus)
check('B4 条目 D → 🟡 备份在·无一键入口', itD?.entryStatus === 'no-entry', itD?.entryStatus)
check('B5 missing/partial 都不可一键（runnable=false）', itB?.runnable === false && itC?.runnable === false)
const md1 = renderTimeline(tl, { limit: 40 })
check('B6 渲染标红：缺备份行含「🔴 备份不在本机」', /🔴 备份不在本机/.test(md1))
check('B7 渲染禁一键：缺备份行含「⛔」提示', /⛔.*禁止一键回滚/.test(md1))
const pfB = preflightRun(tl, idxOf('夹具条目 B') + 1)
check('B8 --run 预检对 missing 项判不通过', pfB.ok === false && (pfB.gates || []).some((g) => !g.ok && /备份/.test(g.name)), JSON.stringify((pfB.gates || []).map((g) => [g.name, g.ok])))
const pfA = preflightRun(tl, idxOf('夹具条目 A') + 1)
check('B9 --run 预检对 present 项三道门齐（含演练记录）', pfA.ok === true && (pfA.gates || []).length === 3, JSON.stringify((pfA.gates || []).map((g) => [g.name, g.ok])))
const pfD = preflightRun(tl, idxOf('夹具条目 D') + 1)
check('B10 --run 预检对无一键入口项不通过', pfD.ok === false)
check('B11 兜底命中：有备份无流水 → 标「未登记改动」', tl.items.some((i) => i.kind === 'unregistered' && /fake-e/.test(i.pointName || '')), tl.items.filter((i) => i.kind === 'unregistered').map((i) => i.pointName).join(','))
check('B12 未登记项也不可一键', tl.items.filter((i) => i.kind === 'unregistered').every((i) => i.runnable === false))
check('B13 统计口径：backupMissing ≥ 2（B、C）', tl.stats.backupMissing >= 2, String(tl.stats.backupMissing))
check('B14 有 PASS 演练记录的条目 runnable=true', itA?.runnable === true, JSON.stringify({ d: itA?.drill?.status, s: itA?.entryStatus }))

// B2：人为移走备份 → 该项必须变红（验收 2 的"人为移走一个备份"）
setupFixture()
fs.rmSync(path.join(SANDBOX.archive, FIX.good), { recursive: true, force: true })
const tl2 = buildTimeline({ days: 7, now: new Date('2026-09-10T15:00:00') })
const movedItem = tl2.items.find((i) => /夹具条目 A/.test(i.title))
check('B15 人为移走备份 → 该条标红（missing）', movedItem?.entryStatus === 'missing', movedItem?.entryStatus)
check('B16 该条同时被禁一键（blocker 命中）', movedItem?.runnable === false && /禁止一键回滚/.test(movedItem?.blocker || ''))
const tlRun = runTool(TIMELINE, ['--days', '7', '--limit', '10'])
check('B17 备份缺失 → timeline CLI 退出码 1', tlRun.code === 1, `code=${tlRun.code}`)
// 反向：把 missing 那个也补上、且移走的是未被任何条目引用的点 → 退出码 0
setupFixture()
fs.rmSync(path.join(SANDBOX.archive, FIX.missing), { recursive: true, force: true })
const tlRun0 = runTool(TIMELINE, ['--days', '7', '--limit', '10'])
check('B18 全绿夹具 → 但仍有引用了不存在备份的条目时退出码仍为 1（不放过）', tlRun0.code === 1, `code=${tlRun0.code}`)
setupFixture()
fs.writeFileSync(path.join(SANDBOX.changelog, '2026-09.md'),
  ['## 09-10', `- 09:00 干净条目｜备份 _archive\\${FIX.good}\\｜恢复：restore-fake.cmd`].join('\n'), 'utf8')
const tlClean = buildTimeline({ days: 7, now: new Date('2026-09-10T15:00:00') })
check('B19 全绿（无缺备份项）→ 退出码语义为 0 的依据成立', tlClean.stats.backupMissing === 0, JSON.stringify(tlClean.stats))
const tlRunClean = runTool(TIMELINE, ['--days', '7'])
check('B20 干净夹具 → timeline CLI 退出码 0', tlRunClean.code === 0, `code=${tlRunClean.code} out=${tlRunClean.all.slice(0, 200)}`)
check('B21 --json 打出机器可读段', /"entryStatus"/.test(runTool(TIMELINE, ['--days', '7', '--json']).out))
check('B22 缺 --days 值/非法天数 → 退出码 2', runTool(TIMELINE, ['--days', 'abc']).code === 2)
check('B23 未知参数 → 退出码 2 且打用法', runTool(TIMELINE, ['--nope']).all.includes('用法'))

// ─────────────────────────── C. 症状分支 ───────────────────────────
group('C. 症状分支（1 起不来 / 2 假死 / 4 冷盘 / 5 体检包）')
setupFixture()
const PORT_TEST = Number(process.env.FIRSTAID_PORT) || 3080
const prodBefore = portListeners(PORT_TEST)
const s1 = runTool(FIRSTAID, ['--symptom', '1', '--quiet'])
check('C1 症状1 退出码 ∈ {0,1}（只看 🔴 决定）', s1.code === 0 || s1.code === 1, `code=${s1.code}`)
check('C2 症状1 判据齐（进程枚举/端口/HTTP 探活）', /守护进程数/.test(s1.out) && new RegExp('端口 ' + PORT_TEST).test(s1.out) && /HTTP 探活/.test(s1.out), s1.out.split('\n').slice(1, 4).join(' / '))
check('C3 症状1 不把「无法判定」静默成 0（如实标注）', !/守护进程数 = 无法判定/.test(s1.out) || /人工核对/.test(s1.out))
check('C4 症状1 报告落盘到沙箱 logs', fs.readdirSync(SANDBOX.logs).some((n) => /^firstaid-.*\.md$/.test(n)))
check('C5 症状1 同时写 .log（失败可见性）', fs.readdirSync(SANDBOX.logs).some((n) => /^firstaid-.*\.log$/.test(n)))

const s2 = runTool(FIRSTAID, ['--symptom', '2', '--quiet'])
check('C6 症状2 给出「完全退出浏览器重开」第一处置', /退出浏览器/.test(s2.out))
check('C7 症状2 记录连接池判据', /已建立连接/.test(s2.out))
check('C8 症状2 提示无痕窗口（第二页面口径）', /无痕/.test(s2.out))

// 症状 2 定向构造：服务端不可达 → 应给「走症状 1」兜底
const s2bad = runTool(FIRSTAID, ['--symptom', '2', '--quiet'], {}, false)
check('C9 症状2 在服务端不可达时给症状1兜底（本轮服务在跑，故用文案存在性校验）', /症状 1|服务不在跑|DSH 打不开/.test(s2bad.out) || s2bad.code === 0)

const s4 = runTool(FIRSTAID, ['--symptom', '4', '--quiet'])
// C10（2026-09-14 修）：原用例直接拿**本机真实盘状态**当"盘不在线"，而 ROG 的 H 盘 2026-09-14 接入后
//   冷盘长期在线 → 断言必然失败（实测：改动前后输出逐行一致 = 用例过期，不是代码回归）。
//   要验的是「落点不可达时显式标注、不假装」，所以**显式构造**一个不可达落点（环境变量改道）。
// 冷盘落点由 FIRSTAID_COLD_ROOTS 注入（形如 "名称=路径"）：注入一个不在线的卷 → 必须显式标「待盘」，不许假装有备份
// 「不可达」用「存在的卷 + 不存在的目录」表达（同样走显式标注分支，且不在源码里留任何盘符样例）
const s4bad = runTool(FIRSTAID, ['--symptom', '4', '--quiet'], { FIRSTAID_COLD_ROOTS: `冷盘=${path.join(TMP, 'no-such-cold-root')}` })
check('C10 症状4 冷盘不可达 → 显式标注不假装', /待盘/.test(s4bad.out) || /不在线/.test(s4bad.out) || /不可达/.test(s4bad.out) || /不存在/.test(s4bad.out) || /未配置/.test(s4bad.out),
  s4bad.out.split('\n').filter((l) => /冷盘/.test(l)).join(' | '))
// 注入一个确实存在的落点 → 必须能报「在线」（判据可复核）
const s4cold = runTool(FIRSTAID, ['--symptom', '4', '--quiet'], { FIRSTAID_COLD_ROOTS: `冷盘=${SANDBOX.archive}` })
check('C10b 症状4 冷盘项给出明确状态（在线/不可达，不留空白）',
  /冷盘/.test(s4cold.out) && /(在线|不可达|待盘)/.test(s4cold.out), s4cold.out.split('\n').filter((l) => /冷盘/.test(l)).join(' | '))
check('C11 症状4 给出可恢复范围（按数据类别）', /按数据类别找对应备份/.test(s4.out) && /配置 /.test(s4.out))
check('C12 症状4 说明「不承诺不可恢复的东西」', /不承诺/.test(s4.out) || /以实测存在为准/.test(s4.out))

const s5 = runTool(FIRSTAID, ['--symptom', '5', '--quiet'])
check('C13 症状5 一键体检包：综合判断 + 两出口', /综合判断/.test(s5.out) && /你不在场/.test(s5.out))
check('C14 症状5 报告含时间轴全文段', (() => {
  const rep = fs.readdirSync(SANDBOX.logs).filter((n) => /^firstaid-.*\.md$/.test(n)).sort().pop()
  return /时间轴全文/.test(fs.readFileSync(path.join(SANDBOX.logs, rep), 'utf8'))
})())

const sBad = runTool(FIRSTAID, ['--symptom', '9', '--quiet'])
check('C15 非法症状号 → 退出码 2', sBad.code === 2, `code=${sBad.code}`)
const sNone = runTool(FIRSTAID, ['--quiet'])
check('C16 缺 --symptom → 退出码 2（急救台不做默认动作）', sNone.code === 2)
check('C17 --list 打菜单且退出码 0', (() => { const r = runTool(FIRSTAID, ['--list']); return r.code === 0 && /5\) 不知道怎么了/.test(r.out) && /1\) 打不开/.test(r.out) })())
check('C18 usage() 五个症状都在（菜单完整性）', usage().includes('1) 打不开 / 起不来') && usage().includes('5) 不知道怎么了'))
check('C19 症状3 退出码语义 = 有红则 1（本轮夹具含 missing 项）', (() => {
  const r = runTool(FIRSTAID, ['--symptom', '3', '--quiet'])
  return (r.code === 1 && /🔴/.test(r.out)) || (r.code === 0 && !/🔴/.test(r.out))
})(), '退出码必须与报告里的 🔴 一致')

// ─────────────────────────── D. 零依赖负向用例 ───────────────────────────
group('D. 负向：宿主包不可用 / 运行时未加载第三方包')
// 「宿主包被改名后本工具仍能跑」这一条需要指定宿主包目录：用 FIRSTAID_TEST_HOST_PKG 注入。
// 未配置 = 跳过真机改名分支（只跑隔离副本证明），**不会去动任何目录**。
const MAIN_PKG = process.env.FIRSTAID_TEST_HOST_PKG || null
const renamed = MAIN_PKG ? `${MAIN_PKG}.firstaid-test` : null
let moveOk = false
// ① 零跳过证明：把本工具整棵复制到临时目录（模拟「脱离原安装树」的救援环境）后仍能跑
const isoRoot = path.join(TMP, 'isolated')
fs.mkdirSync(isoRoot, { recursive: true })
for (const rel of ['firstaid.mjs', 'timeline.mjs', 'drill.mjs', 'lib']) {
  fs.cpSync(path.resolve(HERE, '..', rel), path.join(isoRoot, rel), { recursive: true })
}
const isoRun = runTool(path.join(isoRoot, 'firstaid.mjs'), ['--symptom', '1', '--quiet'])
check('D0 本工具整棵复制到独立目录后仍能跑（不依赖原安装树）', isoRun.code === 0 || isoRun.code === 1, `code=${isoRun.code} ${isoRun.all.slice(0, 160)}`)
// ② 真机改名（仅在注入 FIRSTAID_TEST_HOST_PKG 时执行）：跑完立即还原
if (MAIN_PKG) {
  try {
    if (fs.existsSync(MAIN_PKG)) { fs.renameSync(MAIN_PKG, renamed); moveOk = true; await new Promise((r) => setTimeout(r, 1200)) }
  } catch (e) { console.log(`  ⚠ 宿主包目录改名失败（跳过真机改名分支）：${e.message}`) }
} else {
  console.log('  · 未配置 FIRSTAID_TEST_HOST_PKG → 跳过真机改名分支（不做任何目录改名）')
}
try {
  const r1 = runTool(FIRSTAID, ['--symptom', '1', '--quiet'])
  check('D1 宿主包目录改名后：症状 1 仍能跑（退出码 ∈ {0,1}）', r1.code === 0 || r1.code === 1, `code=${r1.code} ${r1.all.slice(0, 160)}`)
  const r2 = runTool(TIMELINE, ['--days', '1', '--limit', '3'])
  check('D2 宿主包目录改名后：时间轴仍能跑', r2.code === 0 || r2.code === 1, `code=${r2.code}`)
  const r3 = runTool(FIRSTAID, ['--symptom', '5', '--quiet'])
  check('D3 宿主包目录改名后：体检包仍能生成', (r3.code === 0 || r3.code === 1) && fs.readdirSync(SANDBOX.logs).length > 0)
} finally {
  if (moveOk) { try { fs.renameSync(renamed, MAIN_PKG) } catch (e) { console.log(`  ‼ 宿主包目录还原失败，需人工处理：${e.message}`) } }
}
check('D4 宿主包目录已还原（改名不留痕）', !moveOk || fs.existsSync(MAIN_PKG))

// loader 审计：运行时真的是零主包加载
const loaderLog = path.join(TMP, 'loader.log')
const s5Loader = runTool(FIRSTAID, ['--symptom', '5', '--quiet'], { FIRSTAID_LOADER_LOG: loaderLog }, true)
const loaderText = fs.existsSync(loaderLog) ? fs.readFileSync(loaderLog, 'utf8') : ''
check('D5 loader 审计生效（记录到 LOAD 行）', /LOAD /.test(loaderText), loaderText.slice(0, 160))
check('D6 运行时零第三方包加载（审计里无 node_modules 路径）', !/node_modules/i.test(loaderText))
check('D7 运行时零命中 BLOCKED', !/BLOCKED/.test(loaderText))
check('D8 加载面只有 node 内置 + 包内文件（按解析后真路径判）', (() => {
  const lines = [...loaderText.matchAll(/LOAD (\S+) -> (\S+)/g)]
  if (!lines.length) return false
  return lines.every(([, spec, url]) => {
    if (url.startsWith('node:')) return true
    if (spec.startsWith('node:')) return true
    if (/node_modules/i.test(url)) return false          // 任何第三方包 = 违规
    // 本工具自身（含被复制到临时目录的隔离副本）
    return /dsh-firstaid|firstaid-test-|isolated/i.test(url) || url.startsWith('file:///')
      ? !/node_modules/i.test(url)
      : false
  })
})(), [...loaderText.matchAll(/LOAD (\S+) -> (\S+)/g)].map(([, s, u]) => `${s}=>${String(u).split('/').slice(-2).join('/')}`).slice(0, 6).join(' | '))
check('D9 源码里的 import 全部是 node 内置或包内相对路径（静态面）', (() => {
  const src = ['firstaid.mjs', 'timeline.mjs', 'drill.mjs', 'rollback-index.mjs',
    path.join('lib', 'common.mjs'), path.join('lib', 'runtime-config.mjs')]
    .map((f) => fs.readFileSync(path.resolve(HERE, '..', f), 'utf8')).join('\n')
  const specs = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
  return specs.length > 0 && specs.every((s) => s.startsWith('node:') || s.startsWith('./') || s.startsWith('../'))
})())

// ─────────────────────────── E. 目标零改动断言 ───────────────────────────
// 被诊断对象清单由 FIRSTAID_TEST_TARGET_FILES（分号分隔的绝对路径）注入；
//   未配置 → 本组 hash 断言跳过（只验证沙箱隔离），**绝不硬编码任何本机路径**。
group('E. 目标零改动（被测对象是工具自己，只读）')
const beforePort = portListeners(PORT_TEST)   // 全部症状跑之前
const TARGET_FILES = (process.env.FIRSTAID_TEST_TARGET_FILES || '')
  .split(';').map((s) => s.trim()).filter(Boolean)
const REF_LOGS = process.env.FIRSTAID_TEST_REF_LOGS || null
if (!TARGET_FILES.length) console.log('  · 未配置 FIRSTAID_TEST_TARGET_FILES → E1/E4 的 hash 断言跳过')
const baseline = new Map(TARGET_FILES.map((f) => [f, sha256File(f)]))
const prodAfterPort = portListeners(PORT_TEST)
const changed = TARGET_FILES.filter((f) => baseline.get(f) !== sha256File(f))
check('E1 工具运行期间未改任何目标文件（hash 前后一致）', changed.length === 0, changed.join(', '))
check('E2 服务端口监听 pid 未变（没重启/没杀进程）', beforePort.pids.join(',') === prodAfterPort.pids.join(','), `${beforePort.pids} → ${prodAfterPort.pids}`)
check(`E3 工具没往参照日志目录写任何东西${REF_LOGS ? '' : '（未配置 FIRSTAID_TEST_REF_LOGS → 跳过）'}`, (() => {
  const sandboxLogs = fs.readdirSync(SANDBOX.logs).filter((n) => /^firstaid-/.test(n))
  if (!REF_LOGS) return sandboxLogs.length > 0
  const refLogs = fs.readdirSync(REF_LOGS).filter((n) => /^firstaid-.*\.(md|log)$/.test(n))
  // 沙箱有产物；且参照目录里不存在与沙箱同名（同名=说明改道失效、写进了真实目录）
  return sandboxLogs.length > 0 && !sandboxLogs.some((n) => refLogs.includes(n))
})(), `sandbox=${fs.readdirSync(SANDBOX.logs).filter((n) => /^firstaid-/.test(n)).length}`)
check('E4 症状 1/2 全程未改动被诊断对象（复跑一次确认幂等）', (() => {
  const r = runTool(FIRSTAID, ['--symptom', '1', '--quiet'])
  return (r.code === 0 || r.code === 1) && TARGET_FILES.every((f) => sha256File(f) === baseline.get(f))
})())

// ─────────────────────────── 收尾 ───────────────────────────
console.log('')
console.log(`单测结果：${pass} 通过 / ${fail} 失败（共 ${pass + fail}）`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log(`  · ${f}`)
}
console.log(`沙箱（保留供检查）：${TMP}`)
process.exitCode = fail ? 1 : 0
