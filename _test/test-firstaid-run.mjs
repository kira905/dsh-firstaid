#!/usr/bin/env node
/**
 * test-firstaid-run.mjs —— 单测的**唯一入口**
 *
 * 为什么单独一个入口（不是仪式感，是实测暴露的真 bug）：
 *   测试体 `test-firstaid.mjs` 静态 `import` 了 timeline/firstaid —— ESM 的 import 求值**先于**模块体代码，
 *   所以在测试体内部再设 `*_LOGS/CHANGELOG = 沙箱` 已经太晚：常量早已定型，
 *   于是「沙箱单测」实际读的是**真实的变更流水**（首轮实测：条数几百条 = 真实数据，B 组全红）。
 *   结论：**环境必须先于任何 import 设定** → 由本文件（父进程）建沙箱、设 env、再 spawn 子进程跑断言。
 *
 * 本入口负责：
 *   ① 建临时沙箱（logs / changelog / archive / landing 四目录）并把它们塞进 env；
 *   ② 把「沙箱改道生效」自证出来（父进程直接断言，不许只靠子进程自报）；
 *   ③ 用 `--import ./_test/loader-audit.mjs` 挂上零依赖拦截层（记录每次模块加载、遇第三方包即炸）；
 *   ④ 汇总子进程结论、保留沙箱路径供人工检查。
 *
 * 用法：node _test/test-firstaid-run.mjs [--keep]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEST_BODY = path.join(HERE, 'test-firstaid.mjs')
const LOADER = path.join(HERE, 'loader-audit.mjs')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'firstaid-test-'))
const SANDBOX = {
  logs: path.join(TMP, 'logs'),
  changelog: path.join(TMP, 'changelog'),
  archive: path.join(TMP, 'archive'),
  landing: path.join(TMP, 'landing'),
}
for (const p of Object.values(SANDBOX)) fs.mkdirSync(p, { recursive: true })

const loaderLog = path.join(TMP, 'loader.log')
const env = {
  ...process.env,
  FIRSTAID_SANDBOX: TMP,
  DSH_T17_SANDBOX: TMP,               // 兼容旧名（测试体两侧都认）
  FIRSTAID_LOGS: SANDBOX.logs,
  FIRSTAID_CHANGELOG: SANDBOX.changelog,
  FIRSTAID_ARCHIVE_ROOT: SANDBOX.archive,
  FIRSTAID_LANDING: SANDBOX.landing,
  FIRSTAID_LOADER_LOG: loaderLog,
}

console.log('=== 急救台单测入口 ===')
console.log(`沙箱根：${TMP}`)
console.log(`零依赖拦截层：${path.relative(process.cwd(), LOADER)}`)

// ② 沙箱改道自证：在**设了 env 的子进程**里读常量，必须指向沙箱
const probeUrl = pathToFileURL(path.resolve(HERE, '..', 'lib', 'common.mjs')).href
const probe = spawnSync(process.execPath, ['-e',
  `import(${JSON.stringify(probeUrl)}).then(m=>{console.log(JSON.stringify({logs:m.LOGS_DIR,cl:m.CHANGELOG_DIR}))})`,
], { encoding: 'utf8', env })
const probed = (() => { try { return JSON.parse((probe.stdout || '').trim().split('\n').pop()) } catch { return null } })()
const redirectOk = !!probed && probed.logs === SANDBOX.logs && probed.cl === SANDBOX.changelog
console.log(`沙箱改道自证：${redirectOk ? '✓ 生效' : '✗ 未生效'}（logs=${probed?.logs}）`)

const r = spawnSync(process.execPath, ['--import', pathToFileURL(LOADER).href, TEST_BODY], {
  encoding: 'utf8', env, timeout: 600000, maxBuffer: 64 * 1024 * 1024,
})
const out = `${r.stdout || ''}`
process.stdout.write(out)
if (r.stderr) process.stderr.write(r.stderr)

const loaderText = fs.existsSync(loaderLog) ? fs.readFileSync(loaderLog, 'utf8') : ''
const pairs = [...loaderText.matchAll(/LOAD (\S+) -> (\S+)/g)].map(([, spec, url]) => ({ spec, url }))
const specs = pairs.map((p) => p.spec)
const blocked = [...loaderText.matchAll(/BLOCKED (\S+)/g)].map((m) => m[1])

console.log('')
console.log('=== 入口级附加断言（父进程视角，不采信子进程自报）===')
let extraFail = 0
const say = (label, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${!ok && extra ? ` :: ${extra}` : ''}`)
  if (!ok) extraFail++
}
say('沙箱改道生效（logs/changelog 都指向沙箱）', redirectOk, JSON.stringify(probed))
say('零依赖拦截层真的拦在路径上（有 LOAD 记录）', pairs.length > 0, `loads=${pairs.length}`)
// 判据看**解析后的真路径**（specifier 可能是相对路径）：只要解析结果落进 node_modules 就算加载了第三方包
say('全程零次第三方包加载（只看解析后真路径）', pairs.length > 0 && pairs.every((p) => p.url.startsWith('node:') || !/node_modules/i.test(p.url)),
  pairs.filter((p) => /node_modules/i.test(p.url)).map((p) => p.url).join(' '))
say('没有任何 BLOCKED（即真的一次都没加载第三方包）', blocked.length === 0, blocked.join(','))
// 参照日志目录：想核对「有没有误写进真实日志目录」时用 FIRSTAID_TEST_REF_LOGS 指定；未配置则跳过。
const REF_LOGS = process.env.FIRSTAID_TEST_REF_LOGS || null
say(`日志改道生效：参照日志目录无本轮沙箱产物${REF_LOGS ? '' : '（未配置 FIRSTAID_TEST_REF_LOGS → 跳过）'}`, (() => {
  const sandboxLogs = fs.readdirSync(SANDBOX.logs)
  if (!REF_LOGS) return sandboxLogs.length > 0
  const refLogs = fs.readdirSync(REF_LOGS)
  return sandboxLogs.length > 0 && !sandboxLogs.some((n) => refLogs.includes(n))
})(), `sandbox=${fs.readdirSync(SANDBOX.logs).length}`)

fs.writeFileSync(path.join(TMP, 'loader-specs.txt'), pairs.map((p) => `${p.spec} -> ${p.url}`).join('\n'), 'utf8')

const bodyFailed = r.status !== 0
console.log('')
console.log(`入口结论：${bodyFailed || extraFail ? 'FAIL' : 'PASS'}（子进程退出码 ${r.status}，附加断言失败 ${extraFail}）`)
console.log(`沙箱保留：${TMP}`)
if (process.argv.includes('--keep')) console.log('（--keep：不清理；默认也保留供检查）')
process.exitCode = bodyFailed || extraFail ? 1 : 0
