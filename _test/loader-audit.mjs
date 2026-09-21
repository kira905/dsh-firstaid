/**
 * loader-audit.mjs —— 零依赖负向用例的**运行时拦截层**
 *
 * 用途：用 `--import ./_test/loader-audit.mjs` 挂到本工具的脚本上，
 *   ① 记录每一个被 `import` / `require` 的模块说明符；
 *   ② 凡是**第三方包**（既不是 node 内置、也不是本包内相对路径）的加载 → **直接抛错并落审计日志**。
 *
 * 为什么要有它：静态 grep「源码里有没有 import 第三方包」只能证明写了什么；
 *   本 loader 证明的是**进程运行时真的一个都没加载**——即便将来有人在深层依赖里偷偷引入，
 *   也会在这里当场炸掉，而不是等宿主服务崩了才发现本工具跟着跑不起来。
 *
 * 审计日志：环境变量 FIRSTAID_LOADER_LOG（兼容旧名 DSH_FIRSTAID_LOADER_LOG）指定的文件（追加写）；
 *   未设置则写 %TEMP%/firstaid-loader.log。
 * 退出码：被拦截时由加载方进程以非零退出（抛错），日志里记 BLOCKED 一行。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { register } from 'node:module'

const LOG = process.env.FIRSTAID_LOADER_LOG || process.env.DSH_FIRSTAID_LOADER_LOG
  || path.join(os.tmpdir(), 'firstaid-loader.log')
/**
 * 允许的说明符：node 内置（node:xxx）与本包内相对路径（./ ../）、以及 file: URL。
 * 其余一律视为第三方包 —— 通用判定，不需要维护任何包名清单。
 */
const ALLOWED = [
  /^node:/,
  /^\.{1,2}\//,
  /^file:/,
]

function record(line) {
  try { fs.appendFileSync(LOG, `${line}\n`) } catch { /* 日志失败不影响判定 */ }
}
function forbidden(spec) {
  if (!spec) return false
  if (ALLOWED.some((re) => re.test(spec))) return false
  // 绝对路径（Windows 盘符或 POSIX 根）也算包内：脚本被复制到临时目录运行时会出现这种形态
  if (path.isAbsolute(spec) || /^[a-zA-Z]:[\\/]/.test(spec)) return false
  return true
}

register('./loader-audit-hooks.mjs', import.meta.url)
record(`[${new Date().toISOString()}] loader armed (pid ${process.pid})`)
