#!/usr/bin/env node
/**
 * test-rollback-index.mjs — 回滚脚本索引生成器单测
 *
 * 隔离纪律：全部数据落在临时目录（archive / landing / changelog 三个 env 注入点），
 *   **绝不读真实数据、绝不写真实数据**（不调用 --write）。
 *
 * 退出码：0 全过 / 1 有失败
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`) }
}
function eq(name, actual, expected) { ok(name, actual === expected, `期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}`) }

// ─────────────────────────── 夹具（临时目录） ───────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-index-test-'))
const arch = path.join(tmp, 'archive')
const land = path.join(tmp, 'landing')
const chg = path.join(tmp, 'changelog')
for (const d of [arch, land, chg]) fs.mkdirSync(d, { recursive: true })

const POINT = 'demo-point-20260915-0000'
const pointDir = path.join(arch, POINT)
fs.mkdirSync(pointDir)
const scriptText = '@echo off\r\nrem 回滚 demo\r\nnode "%~dp0restore-demo-thing.mjs"\r\n'
fs.writeFileSync(path.join(pointDir, 'restore-demo-thing.cmd'), scriptText, 'utf8')
fs.writeFileSync(path.join(land, 'restore-demo-thing.cmd'), scriptText, 'utf8')
// 落地目录里另一个脚本：内部代号命名 + 需停守护进程+重启服务
fs.writeFileSync(path.join(land, 'restore-p9-alpha.cmd'), '@echo off\r\nrem guard-ctl stop\r\nrem service-restart.ps1\r\n', 'utf8')
// 一个已归档批次目录（验证第 6 节）
const batch = path.join(arch, 'desktop-restore-archive-20260914')
fs.mkdirSync(batch)
fs.writeFileSync(path.join(batch, 'INDEX.md'), '# idx', 'utf8')
fs.writeFileSync(path.join(batch, 'restore-desktop-scripts.cmd'), '@echo off', 'utf8')
fs.writeFileSync(path.join(batch, 'restore-old-one.cmd'), '@echo off', 'utf8')

const year = new Date().getFullYear()
const MM = String(new Date().getMonth() + 1).padStart(2, '0')
const DD = String(new Date().getDate()).padStart(2, '0')
// 两条流水都指向同一脚本（验证「可一键表按脚本名去重」）
fs.writeFileSync(path.join(chg, `${year}-${MM}.md`), [
  `## ${MM}-${DD}`,
  '',
  `- 00:10 [WS-01] demo 改动落地 ｜ \`_archive\\${POINT}\` ｜ 回滚: restore-demo-thing.cmd`,
  `- 00:20 [WS-01] demo 改动补丁 ｜ \`_archive\\${POINT}\` ｜ 回滚: restore-demo-thing.cmd`,
  '',
].join('\n'), 'utf8')

const drillRec = (verdict, level, payload = {}) => JSON.stringify({
  drillVersion: 1, point: pointDir, mode: level.includes('L2') ? 'live' : 'sandbox', level, verdict,
  time: `${year}-${MM}-${DD} 00:00`, host: 'TESTHOST',
  restoreScript: path.join(pointDir, 'restore-demo-thing.cmd'), targets: [], ...payload,
}, null, 2)

// env 注入必须在 import 之前（common.mjs 在模块顶层读取）
process.env.DSH_FIRSTAID_ARCHIVE_ROOT = arch
process.env.DSH_FIRSTAID_LANDING = land
process.env.DSH_FIRSTAID_CHANGELOG = chg

const RI = await import(new URL('../rollback-index.mjs', import.meta.url).href)

console.log('\n[1] 纯函数：影响面分类 impactOf')
eq('配置/预设命中', RI.impactOf('改 presets\\team\\agent.preset.yml'), 'config/presets')
eq('依赖目录命中', RI.impactOf('profiles\\web\\package.json bundles'), 'dependencies')
eq('数据/账本命中', RI.impactOf('ledger.json 主线回填'), 'data/ledger')
eq('空文本 → 未分类', RI.impactOf('', null, undefined), '未分类')
eq('第一个命中优先（流水文本优先于脚本正文）', RI.impactOf('docs\\x.md 文档', 'tools\\x.mjs'), 'docs')

console.log('\n[2] 纯函数：前置条件 prereqOf')
eq('停守护进程 + 重启服务', RI.prereqOf('guard-ctl stop && service-restart.ps1'), '需 停守护进程 + 重启服务')
eq('仅重启', RI.prereqOf('node service-restart.ps1'), '需 重启服务')
eq('文件级回滚', RI.prereqOf('node restore-x.mjs --apply'), '无需停机（文件级回滚）')
eq('未读到内容', RI.prereqOf(''), '（未读到脚本内容）')
ok('管理员标记', RI.prereqOf('rem 需管理员 UAC').includes('管理员'))

console.log('\n[3] 纯函数：内部代号判定 isCodeName')
eq('p8-11a 是代号', RI.isCodeName('restore-p8-11a.cmd'), true)
eq('ch1-superset 是代号', RI.isCodeName('restore-ch1-superset.cmd'), true)
eq('b0-decoupling 是代号', RI.isCodeName('restore-b0-decoupling.cmd'), true)
eq('p9-alpha 是代号', RI.isCodeName('restore-p9-alpha.cmd'), true)
eq('title-live-deploy 不是代号', RI.isCodeName('restore-title-live-deploy.cmd'), false)
eq('policy-p1 不是代号', RI.isCodeName('restore-policy-p1.cmd'), false)
eq('overnight-power 不是代号', RI.isCodeName('restore-overnight-power.cmd'), false)

console.log('\n[4] 纯函数：演练状态 drillText')
eq('无记录 → 未演练', RI.drillText({ status: 'none' }), '❌ 未演练')
ok('PASS + 档位', RI.drillText({ status: 'pass', levels: ['L1 沙箱级', 'L2 真实级·无需停机'] }).includes('L1+L2'))
ok('FAIL 标红', RI.drillText({ status: 'fail', levels: ['L1 沙箱级'] }).startsWith('🔴'))
eq('无回滚点', RI.drillText(undefined), '❌ 未演练')

console.log('\n[5] 模型组装：可一键 / 未登记 / 归档批次')
fs.writeFileSync(path.join(pointDir, 'drill-record-20260915-000000.json'), drillRec('PASS', 'L1 沙箱级'), 'utf8')
let model = RI.buildIndexModel({ days: 30 })
const demo = model.rows.find((r) => r.name === 'restore-demo-thing.cmd')
ok('流水条目入索引', !!demo)
eq('备份 present', demo && demo.backup, 'present')
eq('演练后进「可一键」组', demo && demo.group, 'runnable')
ok('演练列显示 PASS', demo && demo.drill.includes('PASS'))
eq('同名脚本只算一条 runnable', model.rows.filter((r) => r.name === 'restore-demo-thing.cmd' && r.group === 'runnable').length, 2)
const flat = model.extra.find((r) => r.name === 'restore-p9-alpha.cmd')
ok('桌面未登记脚本进 extra', !!flat)
eq('未登记脚本识别为内部代号', flat && flat.codeName, true)
eq('未登记脚本前置条件', flat && flat.prereq, '需 停守护进程 + 重启服务')
ok('归档批次被采集', model.archiveBatches.some((b) => b.name === 'desktop-archive-20260914' || b.name === 'desktop-restore-archive-20260914'))

console.log('\n[6] 演练记录缺席 → 掉出可一键组（判据来自记录，不靠人记）')
fs.rmSync(path.join(pointDir, 'drill-record-20260915-000000.json'))
model = RI.buildIndexModel({ days: 30 })
const demo2 = model.rows.find((r) => r.name === 'restore-demo-thing.cmd')
eq('无演练记录 → 受阻组', demo2 && demo2.group, 'blocked')
eq('演练列回落未演练', demo2 && demo2.drill, '❌ 未演练')
ok('可一键计数为 0', model.stats.runnable === 0, `实得 ${model.stats.runnable}`)

console.log('\n[7] 演练 FAIL → 仍不可一键')
fs.writeFileSync(path.join(pointDir, 'drill-record-20260915-000001.json'), drillRec('FAIL', 'L1 沙箱级', { steps: [] }), 'utf8')
model = RI.buildIndexModel({ days: 30 })
ok('FAIL 不进可一键', RI.buildIndexModel({ days: 30 }).stats.runnable === 0)
eq('演练列标红', model.rows.find((r) => r.name === 'restore-demo-thing.cmd').drill.startsWith('🔴'), true)

console.log('\n[8] 渲染：必需小节 / 四列 / 去重标注 / 转义')
fs.writeFileSync(path.join(pointDir, 'drill-record-20260915-000002.json'), drillRec('PASS', 'L1 沙箱级'), 'utf8')
model = RI.buildIndexModel({ days: 30 })
const md = RI.renderIndex(model)
for (const sec of ['# 回滚索引', '## 0. 出事怎么用', '## 1. 统计', '## 2. 可一键回滚', '## 3. 有回滚入口但受阻', '## 5. 命名规范与内部代号', '## 6. 归档入口批次', '## 7. 未演练怎么办']) {
  ok(`含小节 ${sec}`, md.includes(sec))
}
for (const col of ['症状（那次改了什么）', '回滚脚本', '影响面', '前置条件', '是否演练过']) ok(`含列 ${col}`, md.includes(col))
ok('同脚本重复出现标注「另有 N 条相关流水」', md.includes('另有 1 条相关流水'))
ok('内部代号行带 ⚠代号 标记', md.includes('`restore-p9-alpha.cmd` ⚠代号'))
ok('渲染转义管道符', RI.renderIndex({ ...model, rows: [{ group: 'runnable', name: 'a|b.cmd', symptom: 'x|y', impact: '未分类', prereq: 'x', drill: '❌ 未演练' }], extra: [], archiveBatches: [], stats: { total: 1, runnable: 1, blocked: 0, unregistered: 0, flat: 0, notDrilled: 1, backupBad: 0, codeNames: 0 } }).includes('x\\|y'))

console.log('\n[9] 隔离：夹具目录外零写入')
const before = fs.readdirSync(land).sort().join(',')
RI.renderIndex(RI.buildIndexModel({ days: 30 }))
eq('landing 目录未被写', fs.readdirSync(land).sort().join(','), before)
ok('未生成 README-回滚索引.md', !fs.existsSync(path.join(land, 'README-回滚索引.md')))

console.log('\n[10] refScan：引用扫描')
fs.writeFileSync(path.join(chg, 'ref-doc.md'), '照单执行：先跑 restore-p9-alpha.cmd 一键回滚', 'utf8')
const hits = RI.refScan('restore-p9-alpha.cmd', { roots: [chg] })
ok('扫到引用', hits.some((h) => h.endsWith('ref-doc.md')), JSON.stringify(hits))
eq('无引用返回空', RI.refScan('restore-not-exists-xyz.cmd', { roots: [chg] }).length, 0)

// ─────────────────────────── 收尾 ───────────────────────────
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结论 */ }
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exitCode = 1 } else process.exitCode = 0
