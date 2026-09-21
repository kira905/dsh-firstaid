#!/usr/bin/env node
/**
 * scripts/verify-source.mjs —— 源码体检：脱敏扫描 + 注入规则 + 扫描器自检
 *
 * 用途：发布前/改动后跑一遍，确认包里**没有本机路径、机器名、用户名、私人称呼、内部代号**。
 *
 * ⚠️ 铁律：**本文件里一个字都不写被保护的标识**。
 *    扫描器的"词表"只能通过环境变量注入（BUILD_*），否则扫描器自身就成了泄密点
 *    ——「把要藏的东西写进要发布的仓」是最典型的自伤。
 *    脚本自带**自检**：用注入进来的规则反过来扫本文件自身，命中必须为 0；这条断言把
 *    「扫描器没有夹带」从人工声明变成可复跑结论。
 *
 * 用法：
 *   node scripts/verify-source.mjs [包根]                       # 默认当前目录
 *   node scripts/verify-source.mjs . --positive-control <串>    # 阳性对照：注入一个必定存在的串，必须报红
 *   node scripts/verify-source.mjs . --json
 *
 * 注入词表（多值分隔符：` , ` ` ; ` ` | ` 三者等价）：
 *   BUILD_PERSONAL_TERMS   私人称呼 / 角色词
 *   BUILD_MACHINE_NAMES    机器名 / 主机短码
 *   BUILD_USER_NAMES       用户名
 *   BUILD_LAYOUT_ROOTS     本机目录布局（工作区目录名、同步产品名、测试根等）
 *   BUILD_INTERNAL_TERMS   内部组件名 / 项目代号
 *
 * 退出码：0 = 干净；1 = 有命中（或自检失败/阳性对照未报红）；2 = 用法错误
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const EXIT_OK = 0
const EXIT_HIT = 1
const EXIT_USAGE = 2

// ─────────────────────────── 通用形态规则（不含任何具体标识） ───────────────────────────
// 只描述"长什么样"，不描述"叫什么"：凡是与具体机器/人相关的词，一律走 BUILD_* 注入。
const GENERIC_RULES = [
  {
    id: 'user-profile-path',
    hint: '用户主目录绝对路径形态',
    re: /(?:^|[^A-Za-z0-9_.-])(?:Users|Documents and Settings)[\\/][^\s"'`)/]+/,
  },
  {
    id: 'posix-home-path',
    hint: 'POSIX 家目录绝对路径形态',
    re: /(?:^|[^A-Za-z0-9_.-])\/home\/[^\s"'`)/]+/,
  },
  {
    id: 'drive-letter-path',
    hint: '盘符绝对路径',
    re: /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/][^\s"'`)]+/,
  },
  {
    id: 'card-id-form',
    hint: '8 位十六进制（内部任务卡号 / 短 hash 形态）',
    re: /(?<![0-9a-f])[0-9a-f]{8}(?![0-9a-f])/,
    // 纯 8 位数字更像日期戳（20260910）或毫秒常量（86400000），不算卡号 —— 不这样收紧会有大量假红，
    // 而假红会训练人「看到红就忽略」，比漏判更危险。
    filter: (s) => /[a-f]/.test(s),
  },
  {
    id: 'credential-form',
    hint: '凭证形态',
    re: /\b(?:sk-[A-Za-z0-9_-]{12,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  },
  {
    id: 'private-key',
    hint: '私钥块',
    re: /BEGIN [A-Z ]*PRIVATE KEY/,
  },
]

/** 注入词表：环境变量名 → 规则 id（**这里只写变量名，不写任何词**）。 */
const INJECT_ENV = [
  { env: 'BUILD_PERSONAL_TERMS', id: 'injected-personal-terms' },
  { env: 'BUILD_MACHINE_NAMES', id: 'injected-machine-names' },
  { env: 'BUILD_USER_NAMES', id: 'injected-user-names' },
  { env: 'BUILD_LAYOUT_ROOTS', id: 'injected-layout-roots' },
  { env: 'BUILD_INTERNAL_TERMS', id: 'injected-internal-terms' },
]

// ─────────────────────────── 参数 ───────────────────────────
function parseArgs(argv) {
  const o = { root: null, json: false, positiveControl: null, quiet: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') o.json = true
    else if (a === '--quiet') o.quiet = true
    else if (a === '--positive-control') o.positiveControl = argv[++i]
    else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(EXIT_OK) }
    else if (a.startsWith('-')) { console.error(`✗ 未知参数 ${a}\n${USAGE}`); process.exit(EXIT_USAGE) }
    else o.root = a
  }
  return o
}

const USAGE = [
  '用法：node scripts/verify-source.mjs [包根] [--json] [--quiet]',
  '     node scripts/verify-source.mjs . --positive-control <串>   # 阳性对照',
  '',
  '注入词表（环境变量，多值分隔符 , ; | 均可）：',
  ...INJECT_ENV.map((e) => `  ${e.env.padEnd(22)} → ${e.id}`),
  '',
  '退出码：0 干净 / 1 有命中或自检失败 / 2 用法错误',
].join('\n')

// ─────────────────────────── 工具 ───────────────────────────
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 多值环境变量（分隔符 , ; | 等价 —— 只认逗号会让竖线写法静默失效，那是"0 命中"的经典假通过）。 */
function envList(name) {
  const raw = process.env[name]
  if (!raw || !String(raw).trim()) return []
  return String(raw).split(/[,;|]/).map((s) => s.trim()).filter((s) => s.length >= 2)
}

/**
 * 占位符剔除：`<...>` / `%VAR%` / `${...}` / `{{...}}` / `~~~` 都是文档里的"填这里"，不是真标识。
 * 例：`<workspace>\\docs`、`%APPDATA%\\npm`、`${HOME}/logs` 不该被当成泄露。
 */
function stripPlaceholders(line) {
  return String(line)
    .replace(/<[^<>\n]{0,80}>/g, '<>')
    .replace(/\{\{[^}\n]{0,80}\}\}/g, '{{}}')
    .replace(/\$\{[^}\n]{0,80}\}/g, '${}')
    .replace(/%[A-Za-z_][A-Za-z0-9_]*(?:\([^)]*\))?%/g, '%VAR%')
}

const INCLUDE_EXT = new Set(['.mjs', '.cjs', '.js', '.json', '.md', '.ps1', '.cmd', '.sh', '.yml', '.yaml', '.txt', '.example'])
const SKIP_DIRS = new Set(['node_modules', '.git', '_archive', 'dist', 'coverage'])

function collectFiles(root) {
  const out = []
  const walk = (dir, rel) => {
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const abs = path.join(dir, e.name)
      const relp = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        walk(abs, relp)
        continue
      }
      if (!e.isFile()) continue
      const ext = path.extname(e.name).toLowerCase()
      if (INCLUDE_EXT.has(ext) || /^(LICENSE|CHANGELOG|NOTICE|README)$/i.test(e.name)) out.push({ abs, rel: relp })
    }
  }
  walk(root, '')
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

function buildRules({ positiveControl = null } = {}) {
  const rules = GENERIC_RULES.map((r) => ({ ...r, source: 'generic' }))
  for (const { env, id } of INJECT_ENV) {
    const values = envList(env)
    if (!values.length) continue
    rules.push({
      id, source: `env:${env}`, hint: `注入词表（${env}）`,
      re: new RegExp(`(${values.map(escapeRe).join('|')})`, 'i'),
    })
  }
  if (positiveControl) {
    rules.push({
      id: 'positive-control', source: 'cli:--positive-control', hint: '阳性对照（应当命中）',
      re: new RegExp(`(${escapeRe(positiveControl)})`, 'i'),
    })
  }
  return rules
}

function scanFile(file, rules) {
  const text = fs.readFileSync(file.abs, 'utf8')
  const lines = text.split(/\r?\n/)
  const hits = []
  for (const [i, raw] of lines.entries()) {
    const line = stripPlaceholders(raw)
    for (const r of rules) {
      const m = r.re.exec(line)
      if (!m) continue
      const matched = m[1] !== undefined ? m[1] : m[0]
      if (r.filter && !r.filter(matched)) continue
      hits.push({
        file: file.rel, line: i + 1, rule: r.id, source: r.source, hint: r.hint,
        match: matched,
        text: raw.trim().slice(0, 160),
      })
    }
  }
  return { hits, lines: lines.length }
}

// ─────────────────────────── 主流程 ───────────────────────────
const o = parseArgs(process.argv.slice(2))
const selfPath = fs.realpathSync(fileURLToPath(import.meta.url))
const root = fs.realpathSync(path.resolve(o.root || process.cwd()))
if (!fs.existsSync(root)) { console.error(`✗ 包根不存在：${root}`); process.exit(EXIT_USAGE) }

const rules = buildRules({ positiveControl: o.positiveControl })
const all = collectFiles(root)
const target = all.filter((f) => fs.realpathSync(f.abs) !== selfPath)

const results = []
let totalLines = 0
for (const f of target) {
  const r = scanFile(f, rules)
  totalLines += r.lines
  results.push(...r.hits)
}

// 自检：用**注入规则**扫本文件自身（排除通用形态规则：规则定义处必然含 `Users`、盘符这类形态样例）
const injectOnly = rules.filter((r) => r.source.startsWith('env:'))
const selfHits = injectOnly.length
  ? scanFile({ abs: selfPath, rel: path.relative(root, selfPath) || 'scripts/verify-source.mjs' }, injectOnly).hits
  : []

const genericCount = rules.filter((r) => r.source === 'generic').length
const injectedCount = injectOnly.length

if (o.json) {
  console.log(JSON.stringify({
    root, files: target.length, lines: totalLines,
    rules: { generic: genericCount, injected: injectedCount },
    hits: results, selfCheck: { rules: injectedCount, hits: selfHits.length, details: selfHits },
  }, null, 2))
} else {
  if (!o.quiet) console.log(`[i] 扫描根：${root}`)
  console.log(`[i] 脱敏规则：通用 ${genericCount} 条 + 注入 ${injectedCount} 条`)
  console.log(`[i] 扫描范围：${target.length} 个文件 / ${totalLines} 行（唯一排除项 = 本脚本自身，另跑自检）`)
  if (results.length) {
    console.log('')
    console.log(`✗ 命中 ${results.length} 处：`)
    for (const h of results) console.log(`  · ${h.file}:${h.line} [${h.rule}/${h.source}] 「${h.match}」 —— ${h.hint}\n      ${h.text}`)
  } else {
    console.log(`[OK] 脱敏扫描完成（${target.length} 文件 / ${totalLines} 行 / 命中 0）`)
  }
  console.log(`[${selfHits.length ? '✗' : 'OK'}] 自检 scripts/verify-source.mjs：${injectedCount} 条注入规则 / 命中 ${selfHits.length}`)
  if (selfHits.length) {
    for (const h of selfHits) console.log(`  · 第 ${h.line} 行含被注入规则命中的内容：「${h.match}」`)
    console.log('  ⚠ 扫描器自身夹带了被保护的标识 —— 必须改成注入，不得写进源码。')
  }
}

if (o.positiveControl) {
  const hit = results.filter((r) => r.rule === 'positive-control')
  if (hit.length) {
    console.log(`[OK] 阳性对照通过：注入的探针串命中 ${hit.length} 处 ⇒ 规则确实在跑（「命中 0」不是空判）`)
    process.exitCode = EXIT_OK
  } else {
    console.log('[✗] 阳性对照失败：注入的探针串一处都没命中 ⇒ 规则链路有问题，本次「命中 0」不可信')
    process.exitCode = EXIT_HIT
  }
} else {
  process.exitCode = (results.length || selfHits.length) ? EXIT_HIT : EXIT_OK
}
