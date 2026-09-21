/**
 * inspect-sandbox.mjs —— 单测沙箱巡检器（开发期诊断用，保留以便复现）
 *
 * 用法：node _test/inspect-sandbox.mjs [沙箱根]
 *   默认取环境变量 DSH_T17_SANDBOX；会把沙箱流水逐条解析结果 + 时间轴各条状态打出来。
 *   用途：单测失败时快速看清「夹具 → 解析 → 状态判定」哪一环偏了（不写任何东西）。
 */
import fs from 'node:fs'
import { parseChangelog, buildTimeline } from '../timeline.mjs'

const TMP = process.argv[2] || process.env.FIRSTAID_SANDBOX || process.env.DSH_T17_SANDBOX
if (!TMP) { console.error('需要沙箱根（参数或 FIRSTAID_SANDBOX）'); process.exit(2) }
const cl = process.env.FIRSTAID_CHANGELOG || process.env.DSH_FIRSTAID_CHANGELOG || (TMP + '\\changelog')

const md = fs.readFileSync(cl + '\\2026-09.md', 'utf8')
const p = parseChangelog(md, { year: 2026 })
console.log(`条目数 = ${p.entries.length}（issues=${p.issues.length}）`)
for (const e of p.entries) {
  console.log(`  [${e.date} ${e.time}] ${e.text.slice(0, 20)} | refs=${JSON.stringify(e.archiveRefs)} | restore=${JSON.stringify(e.restoreNames)}`)
}
console.log('')
const tl = buildTimeline({ days: 7, now: new Date('2026-09-10T15:00:00') })
console.log(`items=${tl.items.length} stats=${JSON.stringify(tl.stats)} archivePoints=${tl.archive.points}`)
for (const it of tl.items) {
  console.log(`  ${it.kind.padEnd(12)} ${it.date} ${it.time || '--:--'} | ${String(it.entryStatus).padEnd(9)} | ${it.title.slice(0, 30)} | ${it.restoreScript ? 'script✓' : 'script✗'} | drill=${it.drill.status}`)
}
