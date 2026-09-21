/**
 * loader-audit-hooks.mjs —— loader-audit.mjs 的挂钩实现（module.register 的第二参）
 * 记录 / 拦截逻辑与主文件一致：只放行 node 内置与包内相对路径，其余一律视为第三方包并抛错。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LOG = process.env.FIRSTAID_LOADER_LOG || process.env.DSH_FIRSTAID_LOADER_LOG
  || path.join(os.tmpdir(), 'firstaid-loader.log')
const ALLOWED = [
  /^node:/,
  /^\.{1,2}\//,
  /^file:/,
]

function record(line) {
  try { fs.appendFileSync(LOG, `${line}\n`) } catch { /* ignore */ }
}
function forbidden(spec) {
  if (!spec) return false
  if (ALLOWED.some((re) => re.test(spec))) return false
  if (path.isAbsolute(spec) || /^[a-zA-Z]:[\\/]/.test(spec)) return false
  return true
}

export async function resolve(specifier, context, nextResolve) {
  if (forbidden(specifier)) {
    record(`BLOCKED ${specifier} (parent ${context.parentURL || '-'})`)
    throw new Error(`ZERO-DEP-VIOLATION: 本工具试图加载第三方包：${specifier}`)
  }
  const res = await nextResolve(specifier, context)
  record(`LOAD ${specifier} -> ${res.url || ''}`)
  return res
}
