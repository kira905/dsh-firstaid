/**
 * lib/runtime-config.mjs —— 路径与标识的统一解析层（通用版）
 *
 * 设计目标：**包里不留任何本机路径与个人标识**。所有与"装在哪 / 数据在哪 / 谁是守护进程 /
 * 谁是备份介质"有关的事实，都从这里解析，优先级统一为：
 *
 *     CLI 参数（调用方传入）  >  环境变量  >  内置默认（跨平台通用形态）
 *
 * 数据根（home）目录口径：
 *     FIRSTAID_HOME  >  DSH_HOME  >  ~/.dsh
 * （空串 / 纯空白一律视为「未设置」，逐级回落 —— 空白值被当成"已设置"会让工具静默读写
 *   另一个安装的数据，这是实测踩过的形态，所以任何取值都要 trim 后判空。）
 *
 * 零依赖：只用 node 内置模块。本文件**不读任何文件、不写任何文件**，只做纯解析。
 */
import os from 'node:os'
import path from 'node:path'

/** 任意环境变量的非空取值（空串 / 纯空白 = 未设置）。 */
export function envValue(name) {
  const v = process.env[name]
  return v && String(v).trim() ? String(v).trim() : null
}

/**
 * 多值环境变量的拆分。
 * 分隔符支持 `,` `;` `|` 三种（语义相同）——**这条是有来历的**：早期只认 `,`/`;`，
 * 用 `|` 写注入值会导致整串被当成一个字面量，规则静默失效（"0 命中"其实是"没扫"）。
 */
export function envList(name) {
  const raw = envValue(name)
  if (!raw) return []
  return raw.split(/[,;|]/).map((s) => s.trim()).filter(Boolean)
}

// ─────────────────────────── 目录解析 ───────────────────────────

/** 数据根：显式参数 > FIRSTAID_HOME > DSH_HOME > ~/.dsh */
export function resolveHome(configured) {
  if (configured) return path.resolve(configured)
  const override = envValue('FIRSTAID_HOME') ?? envValue('DSH_HOME')
  if (override) return path.resolve(override)
  return path.join(os.homedir(), '.dsh')
}

/** 工作区根（放工具链 / 备份快照 / 文档的树）：显式 > FIRSTAID_WORKSPACE > DSH_WORKSPACE > null（不猜） */
export function resolveWorkspace(configured) {
  if (configured) return path.resolve(configured)
  const override = envValue('FIRSTAID_WORKSPACE') ?? envValue('DSH_WORKSPACE')
  return override ? path.resolve(override) : null
}

/** 任一环境变量组里第一个非空取值（用于「新名优先、旧名兼容」）。 */
function envAny(names) {
  for (const n of names) {
    const v = envValue(n)
    if (v) return v
  }
  return null
}

/** 日志目录：显式 > FIRSTAID_LOGS（兼容旧名 DSH_FIRSTAID_LOGS） > <home>/logs */
export function resolveLogsDir(configured) {
  if (configured) return path.resolve(configured)
  const override = envAny(['FIRSTAID_LOGS', 'DSH_FIRSTAID_LOGS'])
  return override ? path.resolve(override) : path.join(resolveHome(), 'logs')
}

/** 变更流水目录（时间轴的数据源）：显式 > FIRSTAID_CHANGELOG（兼容旧名） > <home>/changelog */
export function resolveChangelogDir(configured) {
  if (configured) return path.resolve(configured)
  const override = envAny(['FIRSTAID_CHANGELOG', 'DSH_FIRSTAID_CHANGELOG'])
  return override ? path.resolve(override) : path.join(resolveHome(), 'changelog')
}

/** 回滚点根：显式 > FIRSTAID_ARCHIVE_ROOT（兼容旧名） > <home>/_archive */
export function resolveArchiveRoot(configured) {
  if (configured) return path.resolve(configured)
  const override = envAny(['FIRSTAID_ARCHIVE_ROOT', 'DSH_FIRSTAID_ARCHIVE_ROOT'])
  return override ? path.resolve(override) : path.join(resolveHome(), '_archive')
}

/**
 * 落地目录（恢复脚本的家）：显式 > FIRSTAID_LANDING（兼容旧名） > <home>/landing。
 * 默认**不落桌面**：桌面目录名与位置各平台不同，工具不该去猜（要桌面就显式配置）。
 */
export function resolveLandingDir(configured) {
  if (configured) return path.resolve(configured)
  const override = envAny(['FIRSTAID_LANDING', 'DSH_FIRSTAID_LANDING'])
  return override ? path.resolve(override) : path.join(resolveHome(), 'landing')
}

/** 冷盘（离线备份介质）上的回滚点镜像根：显式 > ROLLBACK_POINTS_ROOT > FIRSTAID_ROLLBACK_ROOT > <home>/rollback-points */
export function resolveRollbackPointsRoot(configured) {
  if (configured) return path.resolve(configured)
  const override = envValue('ROLLBACK_POINTS_ROOT') ?? envValue('FIRSTAID_ROLLBACK_ROOT')
  return override ? path.resolve(override) : path.join(resolveHome(), 'rollback-points')
}

/** 历史线索目录（自愈报告 / 知识库）：显式 > FIRSTAID_KB_DIR > <home>/repair-knowledge */
export function resolveKnowledgeDir(configured) {
  if (configured) return path.resolve(configured)
  const override = envValue('FIRSTAID_KB_DIR')
  return override ? path.resolve(override) : path.join(resolveHome(), 'repair-knowledge')
}

/**
 * 冷盘落点表：显式参数 > FIRSTAID_COLD_ROOTS > 空。
 * 取值形态（两种都收）：`名称=路径` 多值（分隔符 `,;|`）或 JSON 数组 `[{"name":"...","root":"..."}]`。
 * 默认空 = 「本机没配冷盘」——报告会如实标「未配置」，而不是假装有备份。
 */
export function resolveColdRoots(configured) {
  if (Array.isArray(configured)) return configured
  const raw = envValue('FIRSTAID_COLD_ROOTS')
  if (!raw) return []
  if (raw.startsWith('[')) {
    try {
      const arr = JSON.parse(raw)
      return Array.isArray(arr) ? arr.filter((x) => x && x.root).map((x) => ({ name: String(x.name || x.root), root: String(x.root), envVar: 'FIRSTAID_COLD_ROOTS' })) : []
    } catch { return [] }
  }
  return envList('FIRSTAID_COLD_ROOTS').map((item) => {
    const i = item.indexOf('=')
    if (i < 0) return { name: item, root: item, envVar: 'FIRSTAID_COLD_ROOTS' }
    return { name: item.slice(0, i).trim(), root: item.slice(i + 1).trim(), envVar: 'FIRSTAID_COLD_ROOTS' }
  })
}

/**
 * 镜像/备份落点：显式 > FIRSTAID_MIRROR_ROOTS > 由 home/workspace 推出的通用两项。
 * 取值形态同冷盘表；未配置时只列「日志/备份快照」这类由配置本身决定的位置，不猜任何盘符。
 */
export function resolveMirrorRoots(configured) {
  if (Array.isArray(configured)) return configured
  const raw = envValue('FIRSTAID_MIRROR_ROOTS')
  if (raw && raw.startsWith('[')) {
    try {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) return arr.filter((x) => x && x.root).map((x) => ({ name: String(x.name || x.root), root: String(x.root) }))
    } catch { /* 回落默认 */ }
  }
  if (raw) return envList('FIRSTAID_MIRROR_ROOTS').map((item) => {
    const i = item.indexOf('=')
    if (i < 0) return { name: item, root: item }
    return { name: item.slice(0, i).trim(), root: item.slice(i + 1).trim() }
  })
  const out = []
  const ws = resolveWorkspace()
  if (ws) out.push({ name: 'backup snapshots', root: path.join(ws, 'backups') })
  out.push({ name: 'archived sessions', root: path.join(resolveHome(), '_archived-sessions') })
  return out
}

// ─────────────────────────── 接口 / 端口 ───────────────────────────

/**
 * 启动日志的文件名模式（症状 1 用它找「最近一次启动日志」）：
 *   FIRSTAID_LOG_PATTERN > 任意 *.log。
 * 例：FIRSTAID_LOG_PATTERN='web-.*[.]log'
 */
export function resolveLogPattern(configured) {
  if (configured instanceof RegExp) return configured
  const v = envValue('FIRSTAID_LOG_PATTERN')
  if (!v) return /[.]log$/i
  try { return new RegExp(v, 'i') } catch { return /[.]log$/i }
}

/** 被诊断服务的端口：显式 > FIRSTAID_PORT > 3080 */
export function resolvePort(configured) {
  if (Number.isInteger(configured) && configured > 0) return configured
  const v = Number(envValue('FIRSTAID_PORT'))
  return Number.isInteger(v) && v > 0 ? v : 3080
}

/** 附带检查的其它实例端口：显式 > FIRSTAID_OTHER_PORTS > 空（默认不假设本机还跑着别的实例） */
export function resolveOtherPorts(configured) {
  if (Array.isArray(configured)) return configured
  return envList('FIRSTAID_OTHER_PORTS').map(Number).filter((n) => Number.isInteger(n) && n > 0)
}

// ─────────────────────────── 守护进程 / 进程特征 ───────────────────────────

/** 守护进程的命令行特征：FIRSTAID_GUARD_PATTERN > `guard`（宽口径正则，字符串注入） */
export function resolveGuardPattern(configured) {
  if (configured) return new RegExp(String(configured), 'i')
  const v = envValue('FIRSTAID_GUARD_PATTERN')
  return new RegExp(v || 'guard', 'i')
}

/** 守护进程状态文件：显式 > FIRSTAID_GUARD_STATE（兼容旧名） > <home>/guard/guard-state.json */
export function resolveGuardStateFile(configured) {
  if (configured) return path.resolve(configured)
  const override = envAny(['FIRSTAID_GUARD_STATE', 'DSH_FIRSTAID_GUARD_STATE'])
  return override ? path.resolve(override) : path.join(resolveHome(), 'guard', 'guard-state.json')
}

/** 守护进程日志：显式 > FIRSTAID_GUARD_LOG（兼容旧名） > <home>/guard/guard.log */
export function resolveGuardLogFile(configured) {
  if (configured) return path.resolve(configured)
  const override = envAny(['FIRSTAID_GUARD_LOG', 'DSH_FIRSTAID_GUARD_LOG'])
  return override ? path.resolve(override) : path.join(resolveHome(), 'guard', 'guard.log')
}

// ─────────────────────────── 提示词 / 规则表注入 ───────────────────────────

/**
 * 设备标记词表（时间轴标题里要剥掉的 `[标记]`）：FIRSTAID_DEVICE_TAGS（多值）。
 * 默认空 —— 规则只能靠注入带进具体环境的主机短码，**包里一个字都不写**。
 * 未注入时仍会剥「通用方括号前缀」与「设备：xxx」形态（与具体环境无关的形态规则）。
 */
export function resolveDeviceTags(configured) {
  if (Array.isArray(configured)) return configured.filter(Boolean).map(String)
  return envList('FIRSTAID_DEVICE_TAGS')
}

/**
 * 影响面分类规则：FIRSTAID_IMPACT_RULES（JSON 数组 `[{"name":"...","pattern":"..."}]`，顺序即优先级）
 * > 内置中性默认表（只含与具体项目无关的类别：配置 / 依赖目录 / 数据 / 启动链 / 文档 / 工具链 / 会话）。
 */
export function resolveImpactRules(configured) {
  if (Array.isArray(configured)) return normalizeRules(configured)
  const raw = envValue('FIRSTAID_IMPACT_RULES')
  if (raw) {
    try {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) return normalizeRules(arr)
    } catch { /* 回落默认 */ }
  }
  return DEFAULT_IMPACT_RULES
}

function normalizeRules(arr) {
  const out = []
  for (const r of arr) {
    if (!r || !r.pattern) continue
    try { out.push({ name: String(r.name || '未分类'), re: new RegExp(String(r.pattern), 'i') }) } catch { /* 坏正则跳过，不炸整表 */ }
  }
  return out
}

/** 内置中性分类表（不含任何具体产品/内部组件名）。 */
export const DEFAULT_IMPACT_RULES = normalizeRules([
  { name: 'config/presets', pattern: '\\.preset|preset\\.ya?ml|settings\\.ya?ml|config\\.(json|ya?ml)|credentials|\\.env\\b' },
  { name: 'dependencies', pattern: 'node_modules|package-lock|pnpm-lock|package\\.json|deps?\\.lock' },
  { name: 'service control', pattern: 'guard|supervisor|daemon|start\\.(cmd|ps1|sh)|restart|shutdown' },
  { name: 'data/ledger', pattern: 'ledger|\\.db\\b|\\bsqlite|\\.jsonl?\\b.*data|storage|账本' },
  { name: 'docs', pattern: 'docs[\\\\/]|\\.md\\b|文档' },
  { name: 'toolchain', pattern: 'tools[\\\\/]|scripts[\\\\/]|bin[\\\\/]' },
  { name: 'sessions', pattern: 'sessions|会话' },
])

/**
 * 停机 / 重启判据（恢复脚本正文里出现即提示「需停机」）：
 *   FIRSTAID_STOP_PATTERNS / FIRSTAID_RESTART_PATTERNS（多值正则字符串）> 内置中性默认。
 */
export function resolveStopPatterns(configured) {
  if (Array.isArray(configured)) return configured.map((s) => new RegExp(String(s), 'i'))
  const list = envList('FIRSTAID_STOP_PATTERNS')
  return (list.length ? list : ['(guard|supervisor|daemon)[^\\n]{0,20}\\bstop\\b', 'stop-service']).map((s) => new RegExp(s, 'i'))
}

export function resolveRestartPatterns(configured) {
  if (Array.isArray(configured)) return configured.map((s) => new RegExp(String(s), 'i'))
  const list = envList('FIRSTAID_RESTART_PATTERNS')
  return (list.length ? list : ['\\brestart', 'taskkill[^\\n]*\\b\\d{2,5}\\b', '\\bstart\\.(cmd|ps1|sh)\\b']).map((s) => new RegExp(s, 'i'))
}

/**
 * 备份来源清单（症状 4 的处置建议里按数据类别给出「去哪儿找备份」）：
 *   FIRSTAID_BACKUP_SOURCES（JSON `[{"category":"...","target":"...","note":"..."}]`）> 内置中性三条。
 */
export function resolveBackupSources(configured) {
  if (Array.isArray(configured)) return configured
  const raw = envValue('FIRSTAID_BACKUP_SOURCES')
  if (raw) {
    try {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) return arr.filter((x) => x && x.target)
    } catch { /* 回落默认 */ }
  }
  return [
    { category: '配置 / 预设 / 凭据', target: '加密备份仓或回滚点', note: '按你的备份介质填（FIRSTAID_BACKUP_SOURCES 可注入）' },
    { category: '会话数据', target: '会话备份仓或归档目录', note: '常与配置分开备份' },
    { category: '工具链 / 文档 / 启动链', target: '工作区仓或回滚点', note: '本工具所在的目录树' },
  ]
}

// ─────────────────────────── 展示 ───────────────────────────

/** 每个解析值的来源（cli / env / default），供 `--print-config` 与故障排查使用。 */
export function describeResolution(overrides = {}) {
  const rows = []
  const push = (label, envNames, value) => {
    let source = 'default'
    if (overrides[label] !== undefined && overrides[label] !== null) source = 'cli'
    else if (envNames.some((n) => envValue(n))) source = `env:${envNames.find((n) => envValue(n))}`
    rows.push({ label, value, source })
  }
  push('home', ['FIRSTAID_HOME', 'DSH_HOME'], resolveHome(overrides.home))
  push('workspace', ['FIRSTAID_WORKSPACE', 'DSH_WORKSPACE'], resolveWorkspace(overrides.workspace))
  push('logs', ['FIRSTAID_LOGS', 'DSH_FIRSTAID_LOGS'], resolveLogsDir(overrides.logs))
  push('changelog', ['FIRSTAID_CHANGELOG', 'DSH_FIRSTAID_CHANGELOG'], resolveChangelogDir(overrides.changelog))
  push('archiveRoot', ['FIRSTAID_ARCHIVE_ROOT', 'DSH_FIRSTAID_ARCHIVE_ROOT'], resolveArchiveRoot(overrides.archiveRoot))
  push('landing', ['FIRSTAID_LANDING', 'DSH_FIRSTAID_LANDING'], resolveLandingDir(overrides.landing))
  push('rollbackPointsRoot', ['ROLLBACK_POINTS_ROOT', 'FIRSTAID_ROLLBACK_ROOT'], resolveRollbackPointsRoot(overrides.rollbackPointsRoot))
  push('knowledge', ['FIRSTAID_KB_DIR'], resolveKnowledgeDir(overrides.knowledge))
  push('guardState', ['FIRSTAID_GUARD_STATE', 'DSH_FIRSTAID_GUARD_STATE'], resolveGuardStateFile(overrides.guardState))
  push('guardLog', ['FIRSTAID_GUARD_LOG', 'DSH_FIRSTAID_GUARD_LOG'], resolveGuardLogFile(overrides.guardLog))
  push('port', ['FIRSTAID_PORT'], resolvePort(overrides.port))
  push('otherPorts', ['FIRSTAID_OTHER_PORTS'], resolveOtherPorts(overrides.otherPorts))
  push('deviceTags', ['FIRSTAID_DEVICE_TAGS'], resolveDeviceTags(overrides.deviceTags))
  push('coldRoots', ['FIRSTAID_COLD_ROOTS'], resolveColdRoots(overrides.coldRoots))
  push('mirrorRoots', ['FIRSTAID_MIRROR_ROOTS'], resolveMirrorRoots(overrides.mirrorRoots))
  return rows
}

export function formatResolution(rows) {
  const w = Math.max(...rows.map((r) => r.label.length))
  return rows.map((r) => `  ${r.label.padEnd(w)} : ${Array.isArray(r.value) ? JSON.stringify(r.value) : r.value}   [${r.source}]`).join('\n')
}
