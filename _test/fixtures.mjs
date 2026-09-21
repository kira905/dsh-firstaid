/**
 * fixtures.mjs —— 急救台单测的共享夹具（2026-09-12）
 *
 * 为什么单独一份：入口（父进程）与测试体（子进程）都要用同一批夹具；
 *   之前夹具写在测试体里，父进程无法复用 → 现抽成模块，避免两份漂移。
 *
 * 夹具覆盖的四种时间轴状态（三态 + 兜底）：
 *   A good      备份在 + 脚本在 + 有 PASS 演练记录  → 唯一可一键
 *   B missing   备份声明了但本机没有（从别处同步来的条目就是这形态）
 *   C partial   声明两个备份位置，只有其中一处存在（回滚会只回落一半）
 *   D orphan    备份在但流水没写 restore-*          → 🟡 无一键入口
 *   E unreg     回滚点存在但流水完全没记             → ⚠ 未登记改动（兜底命中）
 */
import fs from 'node:fs'
import path from 'node:path'

export const GOOD = 'fake-a-20260910-0900'
export const MISSING = 'fake-b-20260910-1000'
export const PARTIAL = 'fake-c-20260910-1100'
export const ORPHAN = 'fake-d-20260910-1200'
export const UNREG = 'fake-e-20260910-1300'
export const SANDBOX_DATE = '2026-09-10T15:00:00'

export function fixtureMarkdown() {
  return [
    '# 变更流水 · 2026-09',
    '',
    '> 头部说明行（不该被当条目）',
    '',
    '## 09-10',
    `- 09:00 夹具条目 A：正常（有备份 + 脚本 + PASS 演练）｜文件 a.mjs｜备份 _archive\\${GOOD}\\｜恢复：restore-fake.cmd`,
    '  续行 1：这一行必须归到上一条，不能被当成新条目',
    '  · 续行 2：缩进的圆点行同样是续行',
    '',
    `- 10:00 夹具条目 B：备份不在本机（跨机同步来的）｜文件 b.mjs｜备份 _archive\\${MISSING}\\｜恢复：restore-missing.cmd`,
    `- 11:00 夹具条目 C：备份只找到一部分｜文件 c.mjs｜备份 _archive\\${PARTIAL}\\ + _archive\\${PARTIAL}\\side2\\｜恢复：restore-partial.cmd`,
    `- 12:00 夹具条目 D：无一键入口（流水没写 restore-*）｜文件 d.mjs｜备份 _archive\\${ORPHAN}\\`,
    '- 13:5x 夹具条目 E：时间戳带 x 占位（宽松解析）',
    '- 14:61 夹具条目 F：时间越界（14:61 非法）→ 应记解析提示',
    `- 15:00 夹具条目 G：字段用不同分隔符｜文件 g.mjs｜备份 _archive\\${GOOD}\\|恢复：restore-fake.cmd`,
    '| 表格行 | 不该被当续行 |',
    '',
    '## 09-11',
    '- 09:10 【设备：WS-01】夹具条目 H：段头换日 + 设备前缀要剥掉',
    '- 08:00 夹具条目 I：段内乱序（时间比上一条早，仍按时间排序输出）',
    '',
    '## 09-12',
    '- 07:00 [WS-01] **夹具条目 J：标题噪声前缀** 正文',
  ].join('\n')
}

/** 建/重置完整夹具（幂等：先清空四个沙箱目录） */
export function setupFixture(sandbox, { removeBackupOf = null } = {}) {
  for (const p of Object.values(sandbox)) { fs.rmSync(p, { recursive: true, force: true }); fs.mkdirSync(p, { recursive: true }) }

  for (const name of [GOOD, PARTIAL, ORPHAN, UNREG]) {
    const d = path.join(sandbox.archive, name)
    fs.mkdirSync(path.join(d, 'before'), { recursive: true })
    fs.writeFileSync(path.join(d, 'before', 'x.txt'), `backup of ${name}\n`, 'utf8')
    fs.writeFileSync(path.join(d, 'restore-fake.cmd'), '@echo off\r\n', 'utf8')
  }
  fs.writeFileSync(path.join(sandbox.archive, GOOD, 'drill-record-20260910-0905.json'),
    JSON.stringify({ verdict: 'PASS', mode: 'sandbox', level: 'L1 沙箱级', time: '2026-09-10 09:05:00' }), 'utf8')
  fs.mkdirSync(path.join(sandbox.archive, PARTIAL, 'side'), { recursive: true })
  fs.writeFileSync(path.join(sandbox.archive, PARTIAL, 'side', 'y.txt'), 'side\n', 'utf8')
  void MISSING   // MISSING 点**故意不建目录**（模拟「备份不在本机」）
  fs.writeFileSync(path.join(sandbox.archive, ORPHAN, 'drill-record-20260910-1201.json'),
    JSON.stringify({ verdict: 'PASS', level: 'L1 沙箱级' }), 'utf8')

  fs.writeFileSync(path.join(sandbox.landing, 'restore-fake.cmd'), '@echo off\r\n', 'utf8')
  fs.writeFileSync(path.join(sandbox.landing, 'restore-partial.cmd'), '@echo off\r\n', 'utf8')
  fs.writeFileSync(path.join(sandbox.landing, 'restore-missing.cmd'), '@echo off\r\n', 'utf8')

  if (removeBackupOf) fs.rmSync(path.join(sandbox.archive, removeBackupOf), { recursive: true, force: true })
  fs.writeFileSync(path.join(sandbox.changelog, '2026-09.md'), fixtureMarkdown(), 'utf8')
}

/** 写一份「只有一条干净条目」的流水（用于验证退出码 0 的路径） */
export function writeCleanFixture(sandbox) {
  fs.rmSync(path.join(sandbox.changelog, '2026-09.md'), { force: true })
  fs.writeFileSync(path.join(sandbox.changelog, '2026-09.md'),
    ['## 09-10', `- 09:00 干净条目｜备份 _archive\\${GOOD}\\｜恢复：restore-fake.cmd`].join('\n'), 'utf8')
}
