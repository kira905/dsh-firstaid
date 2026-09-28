# firstaid · 急救台

> 出事时只想知道「跑哪个」——这个工具把「起不来 / 界面假死 / 要撤销改动 / 数据被删」四类现场压成**一个入口**，
> 产出一份可整段交给 AI 或同事的**现场体检报告**。
>
> **默认只诊断，不动手。** 任何回滚/重启都是写动作，必须有人确认；而且**没演练过的恢复脚本永远不会被列进「可一键执行」**。

- 零第三方依赖：只用 Node 内置模块（宿主/主包挂了，它照样能跑）
- 只读为主：除写自己的报告/日志外，不改任何被诊断的对象
- 三档演练：L1 沙箱（必做）/ L2 真实（造坏→恢复→还原）/ L3 需停机
- 机读友好：每份报告都有固定字段，退出码即结论（0 正常 / 1 有异常 / 2 用法 / 3 环境不可用）

---

## 设计依据

本工具是「[ops-handoff-design](https://github.com/kira905/ops-handoff-design)」所述运维体系的一个实现，
设计依据（对应文档仓约定的固定四问）：

- **它为什么存在、边界在哪** → 见《体系全景与家规》**§4 家规**（其中"回滚演练"那条纪律要求：**没演练过的恢复脚本不许列进一键执行**——本工具的 L1/L2/L3 三档演练与"只诊断优先"正是这条纪律的实现），以及《放行判据与开关矩阵》**§3 执行矩阵**（动作 → 风险级 → 开关 → 护栏 → 放行判据：不可逆动作必须有人确认）
- **它与宿主版本的兼容区间** → 见《多机交接与云中继》**§4.5「兼容性要求」**（另见本 README 第七节「兼容性」）
- **本组件特有的坑与实测** → 见本 README「核心纪律」与「已知限制」两节；本仓的 `_test`/演练脚本即"自证可用"那一环
- **文档仓地址** → Gitee（镜像）<https://gitee.com/kira905/ops-handoff-design>
  ｜ GitHub（主）<https://github.com/kira905/ops-handoff-design>
  （文档仓的组件索引表回指本仓；两仓互链、版本各自独立）

> 设计稿里不写具体仓库地址（写死即死链），实现清单统一收在文档仓的组件索引表里——本仓只负责回链章节。

---

## 一、这工具治什么病

| 症状 | 它能回答的问题 |
|---|---|
| 服务打不开 / 起不来 | 守护进程在不在、端口有没有人听、进程活着吗、日志尾部报了什么 |
| 界面假死 / 一直转圈 | 是服务端真故障，还是浏览器侧连接池/GPU 争用（90% 是后者） |
| 刚改完的东西想撤销 | 最近几天改了什么、每条的备份还在不在、该跑哪个恢复脚本、要不要停机 |
| 数据 / 文件被删 | 哪些备份介质真的在位、可恢复范围是什么（**不承诺不可恢复的东西**） |
| 不知道怎么了 | 一键生成体检包（进程/端口/日志尾/最近改动/备份可用性/演练状态） |

反过来，它**不做**这些事：不替你回滚、不替你重启、不猜你的环境、不在没备份时假装有备份。

---

## 二、目录结构

```
firstaid/
├─ firstaid.mjs            症状入口（5 个症状 → 现场体检报告）
├─ timeline.mjs            改动时间轴（变更流水 ∩ 回滚点 ∩ 演练记录）
├─ drill.mjs               恢复点演练编排器（L1 沙箱 / L2 真实）
├─ rollback-index.mjs      回滚脚本索引（症状 → 脚本 → 影响面 → 前置条件 → 是否演练过）
├─ firstaid-launch.ps1     Windows 交互菜单外壳（可选；纯 CLI 用户不需要）
├─ lib/
│   ├─ common.mjs          公共库（进程/端口/HTTP 探活、报告渲染、落盘）
│   └─ runtime-config.mjs  路径与特征解析层（**所有环境相关的值都从这里来**）
├─ scripts/verify-source.mjs   发布前自检（脱敏扫描 + 注入规则 + 扫描器自检）
├─ _test/                  单测与夹具（全部在临时沙箱里跑）
└─ examples/               配置示例
```

---

## 三、安装（三步）

**第 1 步 · 需要 Node**

```bash
node --version        # 需要 Node 18+（本工具只用内置模块，无构建、无 npm install）
```

**第 2 步 · 取到本地**

```bash
git clone https://github.com/kira905/dsh-firstaid.git firstaid
# 国内镜像：git clone https://gitee.com/kira905/dsh-firstaid.git firstaid
cd firstaid
node firstaid.mjs --list          # 看到症状菜单就算装好了
```

**第 3 步 · 告诉它你的环境（可选但强烈建议）**

工具默认按「数据根 = `~/.dsh`」工作。如果不对，用环境变量指一下：

```bash
# 例：数据根、工作区、被诊断服务的端口
export FIRSTAID_HOME=/srv/myservice/.data
export FIRSTAID_WORKSPACE=/srv/myservice
export FIRSTAID_PORT=3080
node firstaid.mjs --symptom 1
```

Windows PowerShell：

```powershell
$env:FIRSTAID_HOME = '<盘符>:\myservice\.data'
node .\firstaid.mjs --symptom 1
```

不想每次设环境变量，就把它们写进自己的启动脚本——**本工具不读任何私有的全局配置文件**，这是故意的（避免"配置漂移"导致的误诊断）。

---

## 四、怎么用

### 4.1 日常：跑一个症状

```bash
node firstaid.mjs --symptom 1        # 起不来
node firstaid.mjs --symptom 3 --days 14   # 想撤销改动（看 14 天时间轴）
node firstaid.mjs --symptom 5 --json # 一键体检包（含机读 JSON 段）
```

报告落在**日志目录**（默认 `<数据根>/logs`），同时写一份 `.log` 流水。屏幕输出与报告内容一致（`--quiet` 只打判据与建议）。

### 4.2 出事前：把恢复点演练过

**未演练的恢复脚本不会被列为「可一键执行」**——这条纪律是本工具设计的核心，不是可选项。

```bash
# L1 沙箱级（默认档，任何恢复点都该过）：只验证「备份源确实能还原目标」，并强断言目标文件 hash 前后一致
node drill.mjs --point "<回滚点目录>" --target "<目标文件>"

# L2 真实级：真造坏 → 真跑恢复 → 真验活 → **无论成败都还原现场**
node drill.mjs --point "<回滚点目录>" --target "<目标文件>" --restore "<恢复脚本.mjs>" --live --yes
```

演练记录 `drill-record-<ts>.md/.json` 落在**回滚点目录内**，时间轴与索引会自动读到它。

### 4.3 收尾：生成回滚索引

```bash
node rollback-index.mjs --write       # 生成 <落地目录>/README-回滚索引.md
node rollback-index.mjs --check       # 巡检：索引与实况是否一致（不一致退出码 3）
node rollback-index.mjs --refs <脚本名>  # 归档/改名前的全量引用扫描
```

---

## 五、配置表（CLI > 环境变量 > 默认值）

数据根解析顺序：**`FIRSTAID_HOME` > `DSH_HOME` > `~/.dsh`**（空串/纯空白一律视为未设置，逐级回落）。

| 用途 | 环境变量 | 默认值 |
|---|---|---|
| 数据根 | `FIRSTAID_HOME` / `DSH_HOME` | `~/.dsh` |
| 工作区（工具链/文档树） | `FIRSTAID_WORKSPACE` / `DSH_WORKSPACE` | 未配置（不猜） |
| 日志目录 | `FIRSTAID_LOGS` | `<数据根>/logs` |
| 变更流水目录 | `FIRSTAID_CHANGELOG` | `<数据根>/changelog` |
| 回滚点根 | `FIRSTAID_ARCHIVE_ROOT` | `<数据根>/_archive` |
| 恢复脚本落地目录 | `FIRSTAID_LANDING` | `<数据根>/landing` |
| 冷盘（离线介质）上的回滚点镜像 | `FIRSTAID_ROLLBACK_ROOT` / `ROLLBACK_POINTS_ROOT` | `<数据根>/rollback-points` |
| 被诊断服务端口 | `FIRSTAID_PORT` | `3080` |
| 本机其它实例端口（附带检查） | `FIRSTAID_OTHER_PORTS` | 空 |
| 守护进程命令行特征（正则字符串） | `FIRSTAID_GUARD_PATTERN` | `guard` |
| 守护进程状态文件 / 日志 | `FIRSTAID_GUARD_STATE` / `FIRSTAID_GUARD_LOG` | `<数据根>/guard/{guard-state.json,guard.log}` |
| 启动日志文件名模式（正则字符串） | `FIRSTAID_LOG_PATTERN` | 任意 `*.log` |
| 冷盘落点表 | `FIRSTAID_COLD_ROOTS` | 空（未配置时报告如实写「未配置」，**不假装有备份**） |
| 镜像/备份落点表 | `FIRSTAID_MIRROR_ROOTS` | 工作区 `backups/` + 数据根 `_archived-sessions/` |
| 备份来源清单（症状 4 的建议） | `FIRSTAID_BACKUP_SOURCES` | 三条中性提示 |
| 影响面分类规则 | `FIRSTAID_IMPACT_RULES` | 内置中性表（配置/依赖/数据/启动链/文档/工具链/会话） |
| 停机 / 重启判据 | `FIRSTAID_STOP_PATTERNS` / `FIRSTAID_RESTART_PATTERNS` | 内置中性默认 |
| 设备标记词表（时间轴标题剥离） | `FIRSTAID_DEVICE_TAGS` | 空（只剥离「通用方括号前缀」与「设备：xxx」形态） |
| 历史线索目录（自愈报告等） | `FIRSTAID_KB_DIR` | `<数据根>/repair-knowledge` |

**多值写法**：分隔符 `,` `;` `|` 三者等价，例如 `FIRSTAID_COLD_ROOTS='archive=<盘符>:\rollback-points;keys=<盘符>:\keys'`。
也接受 JSON 数组形态（`[{"name":"...","root":"..."}]`）。

### 5.1 时间轴的输入格式（变更流水）

时间轴读**变更流水**文件：`<变更流水目录>/YYYY-MM.md`。解析口径固定：

- 条目起点 = 行首 `- <HH:MM>`（`- 09:00 xxx`），续行自动归上一条；
- 字段用全角竖线 `｜` 或半角 `|` 分隔；
- 条目里出现 `_archive\<点名>\` 形态的路径 → 视为备份线索；
- 出现 `restore-*.cmd|mjs|ps1` → 视为回滚入口。

没有流水也能用：直接把它们放在回滚点根下，工具会按目录名的时间戳兜底识别，并标注为「未登记改动」。

---

## 六、核心纪律（读一遍再动手）

1. **默认只诊断**：本工具除写自己的报告/日志外，不改任何文件。回滚、重启、杀进程都不做。
2. **未演练不得一键**：恢复脚本没跑过演练（回滚点内没有 PASS 演练记录）→ 只登记、不列入可一键项。
3. **缺备份不得一键**：备份不在本机 / 只找到一部分 → 标红并禁一键（不许假装能回滚）。
4. **失败冻结现场**：任何写动作前先备份；失败不无限重试，报告里给「冷却」提示。
5. **不猜环境**：冷盘没配就是「未配置」，日志目录没配就用默认值；**宁可说"不知道"，也不假装知道**。

---

## 七、兼容性

| 平台 | 状态 | 说明 |
|---|---|---|
| Windows 10/11 | ✅ 实测 | 进程枚举用 PowerShell CIM（回落 wmic / tasklist），端口用 `netstat` |
| macOS | ⚠️ 未实测 | 路径与配置层是跨平台写法，但进程/端口探针依赖 Windows 命令，需要适配 |
| Linux | ⚠️ 未实测 | 同上 |

| 依赖 | 要求 |
|---|---|
| Node.js | 18+（实测 24.x） |
| npm 包 | **零**（全部用 node 内置模块；单测有运行时拦截层，加载第三方包即报错） |

---

## 八、已知限制（如实列出）

1. **非 Windows 平台的进程/端口探针未实现**：`tasklist` / `netstat` / PowerShell CIM 都是 Windows 命令；其他平台会走「无法判定」分支并如实标注（不会静默当成 0）。
2. **单测里的夹具日期是固定的**：`_test/fixtures.mjs` 的夹具条目落在 `2026-09-10` 附近；用默认 `--days 7` 跑时间轴时，若当前日期离夹具日期超过 7 天，B17/B18/B21/C19 四条会失败。这是**用例的时间脆性**，不是判据坏了（探针见交付报告：把窗口放大到 30 天后立即判红）。
3. **`--run` 只做预检，不执行回滚**：本版本一律拒绝真执行（红线：只读诊断）。
4. **不做跨机同步**：备份是否"在别处"由你自己的备份介质回答；工具只实测本机可见的落点。
5. **变更流水格式是固定的**：不按这个格式写的日志，时间轴解析不到（会记「解析提示」，不静默）。
6. **没有 GUI**：Windows 下有可选的交互菜单外壳（`firstaid-launch.ps1`），其余平台走命令行。
7. **`rollback-index --refs` 是浅层扫描**：默认只扫工作区的 `docs/`、`tools/` 与数据根，不做全盘搜索。

---

## 九、发布前自检

```bash
# 语法 + 配置层 + 脱敏扫描（注入词表只走环境变量，源码里一个字都不写）
BUILD_MACHINE_NAMES='...' BUILD_USER_NAMES='...' node scripts/verify-source.mjs .

# 阳性对照：故意注入一个必然存在的串，必须报红（证明规则真的在跑）
node scripts/verify-source.mjs . --positive-control <一个确信存在的串>

# 单测（全部在系统临时目录里跑，不碰真实数据）
node _test/test-firstaid-run.mjs
node _test/test-drill.mjs
node _test/test-rollback-index.mjs
```

> 注入词表里的值**只存在于你的命令行**（或 CI secret），不会写进仓库。

---

## 十、许可

本仓以 **MIT** 许可发布（全文见 `LICENSE`）：你可以自由使用、修改、再分发，**包括嵌入自己的闭源工具与 CI**，只需保留版权与许可声明。

> **背景说明（透明化）**：本仓最初派生的草稿曾以 **AGPL-3.0-only** 作为占位（定稿前的临时状态）。该占位版本**从未对外分发**（未推送、未发布）；对外首发的即是本 MIT 版本。三处口径（`LICENSE` / `README` / `package.json` 的 `license` 字段）已同步为 MIT。

---

## 十一、与内部版的默认值差异（从内部版派生而来时必读）

| 项 | 内部版默认 | 本仓默认 | 怎么恢复内部版行为 |
|---|---|---|---|
| 数据根 | 固定工作区路径 | `FIRSTAID_HOME` > `DSH_HOME` > `~/.dsh` | 设 `DSH_HOME` 或 `FIRSTAID_HOME` |
| 变更流水目录 | `<工作区>/docs/变更流水` | `<数据根>/changelog` | 设 `FIRSTAID_CHANGELOG` |
| 恢复脚本落地目录 | 桌面上的固定目录 | `<数据根>/landing` | 设 `FIRSTAID_LANDING` |
| 守护进程状态/日志 | 系统临时目录 | `<数据根>/guard/` | 设 `FIRSTAID_GUARD_STATE` / `FIRSTAID_GUARD_LOG` |
| 其它实例端口 | 内置一串固定端口 | 空 | 设 `FIRSTAID_OTHER_PORTS` |
| 冷盘 / 镜像落点 | 按主机名硬编码盘符 | 空 / 由 home+工作区推出 | 设 `FIRSTAID_COLD_ROOTS` / `FIRSTAID_MIRROR_ROOTS` |
| 影响面分类、停机判据、设备标记 | 内含具体项目与主机名 | 中性默认表 | 用 `FIRSTAID_IMPACT_RULES` / `FIRSTAID_STOP_PATTERNS` / `FIRSTAID_DEVICE_TAGS` 注入 |

**恢复脚本自身、`_archive` 目录名、`restore-*.{cmd,mjs,ps1}` 命名约定、时间轴解析口径 —— 这些是设计语义，未改。**

---

## 相关组件

同属 DSH 生态的伴生组件，各自独立仓、独立版本、许可各自独立；它们都回链到同一份文档仓
[`ops-handoff-design`](https://github.com/kira905/ops-handoff-design)
（Gitee 镜像 <https://gitee.com/kira905/ops-handoff-design>）：

| 组件仓 | 做什么 | 与本组件的关系 |
|---|---|---|
| `dsh-firstaid` | 零依赖急救台：起不来 / 假死 / 要撤销改动 / 数据被删 | **本仓** |
| [`dsh-ecosystem-panel`](https://github.com/kira905/dsh-ecosystem-panel) | 只读生态健康面板（六类体检一屏看完） | 日常与应急的分工：它回答**「今天怎么样」**（持续、只读、三色），本仓回答**「现在坏了、下一步做什么」**（一次性、可整段交出去的报告）——而且**面板自己坏了的时候，本仓是它的兜底** |
| [`dsh-diagnostic-tools`](https://github.com/kira905/dsh-diagnostic-tools) | 依赖闭包 / 解耦体检 + 会话图片附件对账 | 同属"只诊断不动手"，但场景不同：它做**离线专项取证**（升级前后主动跑），本仓做**现场四类症状的分诊**（已经出事时先跑） |
| [`dsh-butler-archive`](https://github.com/kira905/dsh-butler-archive) | 会话归档管理（列表 / 预览 / 恢复 / 删除 + 可选自动归档） | 本仓「要撤销改动 / 数据被删」两类现场里，最常撞上的就是会话与归档面；本仓只负责**如实标注恢复脚本演练过没有**，不替谁回滚 |
| [`dsh-session-title-live`](https://github.com/kira905/dsh-session-title-live) | 会话标题随对话实时刷新 + 回合边界状态前缀 | 本仓的体检报告要回答"最近哪些会话没走完"，标题轴是那份清单可读性的来源 |
| [`dsh-task-board-local`](https://github.com/kira905/dsh-task-board-local) | 自维护任务看板（卡片 = 一次真实会话 + 人工验收闸） | 反过来看：长跑体系的日常编排在它那儿，**出事时它自己也可能卡住**——本仓负责把现场压成一份能交出去的报告 |

> 组件之间**没有代码依赖**，也不共享运行时 —— 之所以互指，是因为它们回答的是同一类人的同一批问题
> （长期在自有机器上跑 agent：装得下、找得到、看得见、查得清）。谁装谁不装，互不影响。
