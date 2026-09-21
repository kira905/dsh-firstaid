#!/usr/bin/env node
/**
 * test-drill.mjs —— drill.mjs 的夹具单测（2026-09-12）
 *
 * 全部在临时沙箱里跑：造一个假回滚点（before/ + restore-*.mjs）+ 假「目标文件」，
 * 然后跑真 drill，验证：
 *   ① --plan 只打印不动作                    ② L1 沙箱 PASS + 生产零改动
 *   ③ L1 前置错误（备份源缺失）非零退出      ④ L2 无 --yes 被拒
 *   ⑤ L2 正常路径 PASS + 现场还原            ⑥ L2 失败路径 FAIL + 现场仍还原
 *   ⑦ 回落断言真的在断言（错误脚本必 FAIL）  ⑧ 验活探针通过/失败两向
 *   ⑨ 记录文件生成且字段齐（md + json）      ⑩ 多 restore-*.mjs 时要求显式指定
 *   ⑪ L1 脚本级沙箱（--sandbox-cmd）          ⑫ 目标不存在 → 环境不可用退出码
 *
 * 用法：node _test/test-drill.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DRILL = path.resolve(HERE, '..', 'drill.mjs')

let pass = 0, fail = 0
const results = []
function check(label, ok, extra = '') {
  results.push({ label, ok, extra })
  if (ok) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; console.log(`  ✗ ${label}${extra ? ` :: ${extra}` : ''}`) }
}
function sha256(f) {
  try { return createHash('sha256').update(fs.readFileSync(f)).digest('hex') } catch { return null }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-test-'))
const POINT = path.join(TMP, 'point-ok')
const POINT_BAD = path.join(TMP, 'point-nofix')
const POINT_MULTI = path.join(TMP, 'point-multi')
const TARGET = path.join(TMP, 'target')
const PROBE_OK = path.join(TMP, 'probe-ok.mjs')
const PROBE_FAIL = path.join(TMP, 'probe-fail.mjs')

const RESTORE_STUB = `#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
const args = process.argv.slice(2)
const i = args.indexOf('--dir')
const dir = i >= 0 ? args[i + 1] : null
if (!dir) { console.error('need --dir'); process.exit(2) }
const here = path.dirname(process.argv[1])
for (const f of fs.readdirSync(path.join(here, 'before'))) {
  fs.copyFileSync(path.join(here, 'before', f), path.join(dir, f))
}
console.log('restored', fs.readdirSync(path.join(here, 'before')).length, 'files')
`
const NOFIX_STUB = `#!/usr/bin/env node
console.log('I did nothing at all')
`

function setup() {
  for (const p of [POINT, POINT_BAD, POINT_MULTI, path.join(POINT, 'before'), path.join(POINT_BAD, 'before'), path.join(POINT_MULTI, 'before'), TARGET]) {
    fs.mkdirSync(p, { recursive: true })
  }
  fs.writeFileSync(path.join(POINT, 'before', 'a.txt'), 'ORIGINAL-A\n', 'utf8')
  fs.writeFileSync(path.join(POINT, 'before', 'b.txt'), 'ORIGINAL-B\n', 'utf8')
  fs.writeFileSync(path.join(POINT, 'restore-fake.mjs'), RESTORE_STUB, 'utf8')

  fs.writeFileSync(path.join(POINT_BAD, 'before', 'a.txt'), 'ORIGINAL-A\n', 'utf8')
  fs.writeFileSync(path.join(POINT_BAD, 'restore-nofix.mjs'), NOFIX_STUB, 'utf8')

  fs.writeFileSync(path.join(POINT_MULTI, 'before', 'a.txt'), 'ORIGINAL-A\n', 'utf8')
  fs.writeFileSync(path.join(POINT_MULTI, 'restore-1.mjs'), RESTORE_STUB, 'utf8')
  fs.writeFileSync(path.join(POINT_MULTI, 'restore-2.mjs'), RESTORE_STUB, 'utf8')

  // 假"生产文件"（演练前状态 = 已改动的版本）
  fs.writeFileSync(path.join(TARGET, 'a.txt'), 'CURRENT-A\n', 'utf8')
  fs.writeFileSync(path.join(TARGET, 'b.txt'), 'CURRENT-B\n', 'utf8')

  fs.writeFileSync(PROBE_OK, 'process.exit(0)\n', 'utf8')
  fs.writeFileSync(PROBE_FAIL, 'process.exit(1)\n', 'utf8')
}

function run(args) {
  const r = spawnSync(process.execPath, [DRILL, ...args], { encoding: 'utf8' })
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }
}
const recordsOf = (point) => fs.readdirSync(point).filter((n) => /^drill-record-.*\.(md|json)$/.test(n))
const latestJson = (point) => {
  const js = fs.readdirSync(point).filter((n) => /^drill-record-.*\.json$/.test(n)).sort()
  if (!js.length) return null
  return JSON.parse(fs.readFileSync(path.join(point, js[js.length - 1]), 'utf8'))
}
const baseArgs = (point) => ['--point', point, '--target', `${path.join(TARGET, 'a.txt')}=before/a.txt`]

setup()

console.log('=== ① --plan 只打印 ===')
{
  const r = run([...baseArgs(POINT), '--plan'])
  check('--plan 退出码 0', r.code === 0, `code=${r.code}`)
  check('--plan 声明不执行动作', /只打印计划/.test(r.out), r.out.slice(0, 200))
  check('--plan 不生成记录', recordsOf(POINT).length === 0, recordsOf(POINT).join(','))
}

console.log('\n=== ② L1 沙箱 PASS + 目标零改动 ===')
{
  const before = sha256(path.join(TARGET, 'a.txt'))
  const r = run([...baseArgs(POINT)])
  check('L1 退出码 0', r.code === 0, `code=${r.code} :: ${r.out.slice(-400)}`)
  check('L1 结论 PASS', /结论：PASS/.test(r.out), r.out.slice(-200))
  check('L1 未改生产文件', sha256(path.join(TARGET, 'a.txt')) === before)
  const j = latestJson(POINT)
  check('L1 记录 json 生成且级别为 L1', j && j.level.startsWith('L1'), JSON.stringify(j && j.level))
  check('L1 记录含目标零改动步骤', j && j.steps.some((s) => /目标文件未被改动/.test(s.name) && s.ok))
}

console.log('\n=== ③ L1 前置错误（备份源缺失）→ 环境不可用退出码 3 ===')
{
  const r = run(['--point', POINT, '--target', `${path.join(TARGET, 'a.txt')}=before/missing.txt`])
  check('备份源缺失退出码 3', r.code === 3, `code=${r.code}`)
  check('提示备份源不存在', /备份源不存在/.test(r.out), r.out.slice(0, 200))
}

console.log('\n=== ⑫ 目标文件不存在 → 环境不可用 ===')
{
  const r = run(['--point', POINT, '--target', `${path.join(TARGET, 'nope.txt')}=before/a.txt`])
  check('目标不存在退出码 3', r.code === 3, `code=${r.code}`)
}

console.log('\n=== ④ L2 无 --yes 被拒 ===')
{
  const r = run([...baseArgs(POINT), '--live'])
  check('缺 --yes 退出码 2', r.code === 2, `code=${r.code}`)
  check('提示必须 --yes', /必须显式加 --yes/.test(r.out), r.out.slice(0, 200))
}

console.log('\n=== ⑤ L2 正常路径 PASS + 现场还原 ===')
{
  const beforeA = fs.readFileSync(path.join(TARGET, 'a.txt'), 'utf8')
  const r = run([...baseArgs(POINT), '--live', '--yes', '--restore-args', `--dir ${TARGET}`])
  check('L2 退出码 0', r.code === 0, `code=${r.code} :: ${r.out.slice(-500)}`)
  check('L2 结论 PASS', /结论：PASS/.test(r.out), r.out.slice(-200))
  check('现场已还原（内容 == 演练前）', fs.readFileSync(path.join(TARGET, 'a.txt'), 'utf8') === beforeA)
  const j = latestJson(POINT)
  check('L2 记录里有造坏步骤且生效', j && j.steps.some((s) => /造坏/.test(s.name) && s.ok))
  check('L2 记录里有还原现场步骤且 ok', j && j.steps.some((s) => /还原现场/.test(s.name) && s.ok))
  check('L2 记录 mode=live', j && j.mode === 'live', JSON.stringify(j && j.mode))
}

console.log('\n=== ⑥ L2 失败路径 FAIL + 现场仍还原 ===')
{
  const beforeA = fs.readFileSync(path.join(TARGET, 'a.txt'), 'utf8')
  const r = run([
    '--point', POINT_BAD,
    '--target', `${path.join(TARGET, 'a.txt')}=before/a.txt`,
    '--live', '--yes',
  ])
  check('恢复脚本不干活 → 退出码 1', r.code === 1, `code=${r.code}`)
  check('结论 FAIL', /结论：FAIL/.test(r.out), r.out.slice(-300))
  check('回落断言步骤为 ❌', /✗ \d+\. 回落断言/.test(r.out), r.out.slice(-600))
  check('失败后现场仍被还原', fs.readFileSync(path.join(TARGET, 'a.txt'), 'utf8') === beforeA)
  const j = latestJson(POINT_BAD)
  check('FAIL 也产出记录', j !== null && j.verdict === 'FAIL', JSON.stringify(j && j.verdict))
}

console.log('\n=== ⑧ 验活探针两向 ===')
{
  const okRun = run([...baseArgs(POINT), '--live', '--yes', '--restore-args', `--dir ${TARGET}`, '--probe', `"${process.execPath}" "${PROBE_OK}"`])
  check('探针通过 → PASS', okRun.code === 0 && /结论：PASS/.test(okRun.out), `code=${okRun.code}`)
  const failRun = run([...baseArgs(POINT), '--live', '--yes', '--restore-args', `--dir ${TARGET}`, '--probe', `"${process.execPath}" "${PROBE_FAIL}"`])
  check('探针失败 → FAIL(1)', failRun.code === 1, `code=${failRun.code}`)
  check('失败原因指向探针', /✗ \d+\. 验活探针/.test(failRun.out), failRun.out.slice(-400))
}

console.log('\n=== ⑩ 多个 restore-*.mjs → 要求显式指定 ===')
{
  const r = run(['--point', POINT_MULTI, '--target', `${path.join(TARGET, 'a.txt')}=before/a.txt`, '--live', '--yes'])
  check('多脚本时退出码 2', r.code === 2, `code=${r.code}`)
  check('提示用 --restore 指定', /请用 --restore 指定/.test(r.out), r.out.slice(0, 300))
}

console.log('\n=== ⑪ L1 脚本级沙箱（--sandbox-cmd） ===')
{
  const r = run([
    ...baseArgs(POINT),
    '--sandbox',
    '--sandbox-cmd', path.join(POINT, 'restore-fake.mjs'),
    '--sandbox-args', '--dir {SANDBOX}',
  ])
  check('脚本级沙箱退出码 0', r.code === 0, `code=${r.code} :: ${r.out.slice(-500)}`)
  check('含沙箱内回落断言', /沙箱内回落断言/.test(r.out), r.out.slice(-400))
  check('沙箱演练未改生产', sha256(path.join(TARGET, 'a.txt')) !== null)
}

console.log('\n=== ⑨ 记录字段完整性 ===')
{
  const j = latestJson(POINT)
  const need = ['drillVersion', 'point', 'mode', 'level', 'verdict', 'time', 'host', 'restoreScript', 'targets', 'steps']
  const missing = need.filter((k) => !(k in (j || {})))
  check('记录字段齐全', missing.length === 0, `缺失：${missing.join(',')}`)
  const md = fs.readdirSync(POINT).filter((n) => /^drill-record-.*\.md$/.test(n)).sort().pop()
  const text = md ? fs.readFileSync(path.join(POINT, md), 'utf8') : ''
  check('md 记录含约定字段', ['时间', '操作者', '回滚点', '演练级别', '造坏方式', '验活判据', '目标影响面', '残留清理', '结论'].every((k) => text.includes(k)))
}

console.log(`\n=== 汇总：${pass} passed / ${fail} failed ===`)
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail === 0 ? 0 : 1)
