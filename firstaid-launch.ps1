# DSH 急救台启动器（ASCII 内容；中文路径只存在于 .cmd 里，本文件负责显示中文菜单）
# ---------------------------------------------------------------------------
# 为什么用 PowerShell 做交互菜单：
#   1) 中文 .cmd 会被 cmd.exe 按 GBK 解析而拆坏命令（2026-08-28 实测教训）；
#   2) 菜单与提示需要中文，靠 `chcp 65001` + 本 .ps1 承载。
# 只读原则：本脚本只调用 firstaid.mjs 做**诊断**；任何写动作（回滚/重启）都不在这里做。
# 退出码：把 firstaid.mjs 的退出码原样透出（0 正常 / 1 有异常 / 2 用法 / 3 环境不可用）。
param(
  [int]$Symptom = 0,
  [switch]$List,
  [switch]$NoPause
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# 脚本位置按本文件自身解析（不写死任何安装路径）
$Here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$Firstaid = Join-Path $Here 'firstaid.mjs'
$Timeline = Join-Path $Here 'timeline.mjs'

function Get-NodePath {
  # 急救台的前提是「node 可用」；主包不在也不影响（本脚本零主包依赖）
  $c = Get-Command node -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in @(
      (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
      (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'))) {
    if ($p -and (Test-Path -LiteralPath $p)) { return $p }
  }
  return $null
}

function Show-Menu {
  Write-Host ''
  Write-Host '  ==============================================' -ForegroundColor DarkCyan
  Write-Host '     DSH 急救台 v0.1   (只读诊断 · 不擅自动手)' -ForegroundColor Cyan
  Write-Host '  ==============================================' -ForegroundColor DarkCyan
  Write-Host ''
  Write-Host '   1) DSH 打不开 / 起不来' -ForegroundColor White
  Write-Host '   2) 界面假死 / 一直转圈' -ForegroundColor White
  Write-Host '   3) 刚改完的东西想撤销  -> 改动时间轴' -ForegroundColor White
  Write-Host '   4) 数据 / 文件被删' -ForegroundColor White
  Write-Host '   5) 不知道怎么了        -> 一键体检包（交给 agent）' -ForegroundColor White
  Write-Host ''
  Write-Host '   q) 退出' -ForegroundColor DarkGray
  Write-Host ''
}

$node = Get-NodePath
if (-not $node) {
  Write-Host ''
  Write-Host '  ✗ 找不到 node.exe —— 本工具需要系统 node（零第三方依赖，但需要运行时）。' -ForegroundColor Red
  Write-Host '    请安装 Node.js 或把 node 加入 PATH 后重试。' -ForegroundColor Red
  Write-Host ''
  if (-not $NoPause) { Read-Host '  按回车结束' }
  exit 3
}
if (-not (Test-Path -LiteralPath $Firstaid)) {
  Write-Host ''
  Write-Host "  ✗ 找不到急救台脚本：$Firstaid" -ForegroundColor Red
  Write-Host '    若它被误删/回滚掉了 —— 从你的备份或仓库里把它取回来。' -ForegroundColor Yellow
  Write-Host ''
  if (-not $NoPause) { Read-Host '  按回车结束' }
  exit 3
}

if ($List) {
  & $node $Firstaid --list
  exit $LASTEXITCODE
}

$code = 0
if ($Symptom -ge 1 -and $Symptom -le 5) {
  & $node $Firstaid --symptom $Symptom
  $code = $LASTEXITCODE
} else {
  Show-Menu
  $ans = Read-Host '  请输入症状编号 1-5（回车直接看菜单）'
  if ($ans -eq 'q' -or $ans -eq 'Q') { exit 0 }
  if ($ans -match '^[1-5]$') {
    & $node $Firstaid --symptom $ans
    $code = $LASTEXITCODE
  } else {
    & $node $Firstaid --list
    $code = 0
  }
}

Write-Host ''
switch ($code) {
  0 { Write-Host '  🟢 未发现异常（报告里有详细判据）' -ForegroundColor Green }
  1 { Write-Host '  🔴 发现异常 —— 按报告里的「处置建议」走；看不懂就把报告路径发给 agent' -ForegroundColor Red }
  2 { Write-Host '  ⚠ 用法问题（参数不对）' -ForegroundColor Yellow }
  3 { Write-Host '  ⚠ 急救台自身跑不动（环境不可用）—— 见上方提示' -ForegroundColor Yellow }
  default { Write-Host "  ⚠ 退出码 $code" -ForegroundColor Yellow }
}
Write-Host ''
Write-Host '  报告与日志落在日志目录（见上方「报告：」一行，firstaid-*.md / .log）' -ForegroundColor DarkGray
Write-Host '  · 你不在场：把报告路径发给 AI/同事，一句话说明' -ForegroundColor DarkGray
Write-Host ('  · 想撤销某次改动：跑  node "' + $Timeline + '" --days 7') -ForegroundColor DarkGray
Write-Host ''

if (-not $NoPause) { Read-Host '  按回车关闭' }
exit $code
