# dsh-firstaid

> **Status**: published (Gitee + GitHub)
> **Repository**: <https://github.com/kira905/dsh-firstaid> ｜ <https://gitee.com/kira905/dsh-firstaid>
> **License**: MIT — see [`LICENSE`](./LICENSE)
> **中文**: [README.md](./README.md)

When something breaks you only want to know *which command to run*. This tool compresses four on-site
scenarios — **will not start / UI is frozen / I need to undo a change / data got deleted** — into **one
entry point**, and produces a **field report** you can hand to an AI or a colleague as one block of text.

**It diagnoses by default and never touches anything.** Every rollback or restart is a write action and
requires a human to confirm it; and **a recovery script that has never been drilled is never listed as
"one-click executable"**.

- Zero third-party dependencies: Node built-in modules only (it still runs when the host or a package is wedged)
- Read-mostly: apart from writing its own reports and logs, it modifies nothing it diagnoses
- Three drill tiers: L1 sandbox (mandatory) / L2 live (break → recover → restore) / L3 requires downtime
- Machine-readable: every report has fixed fields, and the exit code *is* the verdict (0 normal / 1 anomaly found / 2 usage error / 3 environment unavailable)

---

## Design basis

This tool is one implementation of the operations system described in
[ops-handoff-design](https://github.com/kira905/ops-handoff-design), and its design basis follows the
fixed four questions that the documentation repository requires:

- **Why it exists and where its boundary is** → see *System Panorama and House Rules* (**《体系全景与家规》**) **§4 House Rules** (one of those rules states: **a recovery script that has never been drilled must not be listed as one-click executable** — this tool's L1/L2/L3 drill tiers and its "diagnose first" stance are that rule, implemented), and *Release Criteria and the Switch Matrix* (**《放行判据与开关矩阵》**) **§3 the execution matrix** (action → risk tier → switch → guardrail → release criterion: an irreversible action must be confirmed by a human)
- **Its compatibility window with the host** → see *Multi-machine Handoff and Cloud Relay* (**《多机交接与云中继》**) **§4.5 "compatibility requirements"** (see also "Compatibility" below)
- **This component's own pitfalls and measurements** → see the "Core discipline" and "Known limitations" sections below; this repository's `_test` tree and drill scripts are the "proves itself usable" half of that
- **Where the documentation repository lives** → Gitee (mirror) <https://gitee.com/kira905/ops-handoff-design>
  ｜ GitHub (primary) <https://github.com/kira905/ops-handoff-design>
  (the documentation repository's component index links back to this repository; the two repositories link to each other and version independently)

> The design documents deliberately contain no concrete repository addresses (hard-coding them would
> create dead links); the implementation index is kept in the documentation repository's component
> index table, and this repository only carries the back-links.

---

## 1. What this tool diagnoses

| Symptom | The questions it answers |
|---|---|
| Service will not open / will not start | Is the supervisor running, is anything listening on the port, is the process alive, what do the tail of the log say |
| UI is frozen / spinning forever | Is this a real server-side fault, or browser-side connection-pool / GPU contention (90% of the time it is the latter) |
| I want to undo something I just changed | What changed in the last few days, is each change's backup still present, which recovery script should run, does it need downtime |
| Data / files were deleted | Which backup media are actually in place, what range is recoverable (**it makes no promise about anything that is not recoverable**) |
| No idea what happened | One-command field check bundle (processes / ports / log tail / recent changes / backup availability / drill status) |

Conversely, it does **not** do these things: it does not roll back for you, it does not restart for you,
it does not guess your environment, and it does not pretend a backup exists when none does.

---

## 2. Directory structure

```
firstaid/
├─ firstaid.mjs            symptom entry (5 symptoms → field report)
├─ timeline.mjs            change timeline (changelog ∩ rollback points ∩ drill records)
├─ drill.mjs               recovery-point drill orchestrator (L1 sandbox / L2 live)
├─ rollback-index.mjs      recovery script index (symptom → script → impact → preconditions → drilled or not)
├─ firstaid-launch.ps1     Windows interactive menu shell (optional; pure CLI users do not need it)
├─ lib/
│   ├─ common.mjs          shared library (process/port/HTTP probing, report rendering, writing to disk)
│   └─ runtime-config.mjs  path and trait resolution layer (**every environment-dependent value comes from here**)
├─ scripts/verify-source.mjs   pre-publish self-check (sanitization scan + injection rules + scanner self-test)
├─ _test/                  unit tests and fixtures (everything runs in a temporary sandbox)
└─ examples/               configuration examples
```

---

## 3. Install (three steps)

**Step 1 · You need Node**

```bash
node --version        # Node 18+ required (this tool uses built-in modules only; no build, no npm install)
```

**Step 2 · Get it locally**

```bash
# Route A (recommended): install from npm (then use firstaid / firstaid-drill / firstaid-timeline / firstaid-rollback-index)
npm install -g @kira905/dsh-firstaid
firstaid --list           # if you see the symptom menu, it is installed

# Route B: clone from git (when you want to edit the source, or avoid a global install)
git clone https://github.com/kira905/dsh-firstaid.git firstaid
# mirror in China: git clone https://gitee.com/kira905/dsh-firstaid.git firstaid
cd firstaid
node firstaid.mjs --list          # if you see the symptom menu, it is installed
```

**Step 3 · Tell it about your environment (optional but strongly recommended)**

By default the tool works with "data root = `~/.dsh`". If that is wrong for you, point it somewhere else
with environment variables:

```bash
# example: data root, workspace, and the port of the service under diagnosis
export FIRSTAID_HOME=/srv/myservice/.data
export FIRSTAID_WORKSPACE=/srv/myservice
export FIRSTAID_PORT=3080
node firstaid.mjs --symptom 1
```

Windows PowerShell:

```powershell
$env:FIRSTAID_HOME = '<drive>:\myservice\.data'
node .\firstaid.mjs --symptom 1
```

If you do not want to set environment variables every time, put them in your own start script — **this
tool reads no private global configuration file**, deliberately so (avoids misdiagnosis caused by
configuration drift).

---

## 4. How to use it

### 4.1 Day to day: run one symptom

```bash
node firstaid.mjs --symptom 1        # will not start
node firstaid.mjs --symptom 3 --days 14   # I want to undo a change (14-day timeline)
node firstaid.mjs --symptom 5 --json # field check bundle (includes a machine-readable JSON section)
```

Reports land in the **log directory** (default `<data root>/logs`), together with a `.log` stream file.
What you see on screen matches the report content (`--quiet` prints only the verdict and the
recommendations).

### 4.2 Before trouble: drill your recovery points

**An un-drilled recovery script is never listed as "one-click executable"** — that rule is the core of
this tool's design, not an option.

```bash
# L1 sandbox tier (the default tier, every recovery point should pass it): it only verifies that
# "the backup source really can restore the target", and hard-asserts that the target file hash is
# identical before and after
node drill.mjs --point "<rollback point directory>" --target "<target file>"

# L2 live tier: really break it → really run the recovery → really verify it is alive → **restore the
# scene either way, success or failure**
node drill.mjs --point "<rollback point directory>" --target "<target file>" --restore "<recovery script.mjs>" --live --yes
```

Drill records `drill-record-<ts>.md/.json` are written **inside the rollback point directory**, and the
timeline and the index pick them up automatically.

### 4.3 Wrap-up: generate the rollback index

```bash
node rollback-index.mjs --write       # generates <landing directory>/README-回滚索引.md
node rollback-index.mjs --check       # inspection: does the index match reality (exit code 3 if not)
node rollback-index.mjs --refs <script name>  # full reference scan before archiving/renaming
```

---

## 5. Configuration reference (CLI > environment variables > defaults)

Data root resolution order: **`FIRSTAID_HOME` > `DSH_HOME` > `~/.dsh`** (an empty string or pure
whitespace always counts as unset, and the chain falls through).

| Purpose | Environment variable | Default |
|---|---|---|
| Data root | `FIRSTAID_HOME` / `DSH_HOME` | `~/.dsh` |
| Workspace (toolchain / documentation tree) | `FIRSTAID_WORKSPACE` / `DSH_WORKSPACE` | unset (it does not guess) |
| Log directory | `FIRSTAID_LOGS` | `<data root>/logs` |
| Changelog directory | `FIRSTAID_CHANGELOG` | `<data root>/changelog` |
| Rollback point root | `FIRSTAID_ARCHIVE_ROOT` | `<data root>/_archive` |
| Recovery script landing directory | `FIRSTAID_LANDING` | `<data root>/landing` |
| Rollback point mirror on cold media (offline media) | `FIRSTAID_ROLLBACK_ROOT` / `ROLLBACK_POINTS_ROOT` | `<data root>/rollback-points` |
| Port of the service under diagnosis | `FIRSTAID_PORT` | `3080` |
| Ports of other local instances (incidental check) | `FIRSTAID_OTHER_PORTS` | empty |
| Supervisor command-line trait (regex string) | `FIRSTAID_GUARD_PATTERN` | `guard` |
| Supervisor state file / log | `FIRSTAID_GUARD_STATE` / `FIRSTAID_GUARD_LOG` | `<data root>/guard/{guard-state.json,guard.log}` |
| Startup log filename pattern (regex string) | `FIRSTAID_LOG_PATTERN` | any `*.log` |
| Cold media target table | `FIRSTAID_COLD_ROOTS` | empty (when unset the report honestly says "not configured" and **does not pretend a backup exists**) |
| Mirror / backup target table | `FIRSTAID_MIRROR_ROOTS` | workspace `backups/` + data root `_archived-sessions/` |
| Backup source list (the suggestion for symptom 4) | `FIRSTAID_BACKUP_SOURCES` | three neutral hints |
| Impact classification rules | `FIRSTAID_IMPACT_RULES` | built-in neutral table (configuration / dependencies / data / startup chain / documentation / toolchain / sessions) |
| Downtime / restart criteria | `FIRSTAID_STOP_PATTERNS` / `FIRSTAID_RESTART_PATTERNS` | built-in neutral defaults |
| Device tag word list (stripped from timeline titles) | `FIRSTAID_DEVICE_TAGS` | empty (only the generic square-bracket prefix and the `device: xxx` form are stripped) |
| Historical clue directory (self-healing reports etc.) | `FIRSTAID_KB_DIR` | `<data root>/repair-knowledge` |

**Multi-value syntax**: the separators `,` `;` `|` are equivalent, for example
`FIRSTAID_COLD_ROOTS='archive=<drive>:\rollback-points;keys=<drive>:\keys'`.
A JSON array form is also accepted (`[{"name":"...","root":"..."}]`).

### 5.1 Timeline input format (the changelog)

The timeline reads **changelog** files: `<changelog directory>/YYYY-MM.md`. The parsing rules are fixed:

- An entry starts at a line beginning with `- <HH:MM>` (`- 09:00 xxx`); continuation lines belong to the previous entry;
- Fields are separated by the full-width vertical bar `｜` or the half-width `|`;
- A path of the form `_archive\<name>\` inside an entry counts as a backup clue;
- A `restore-*.cmd|mjs|ps1` occurrence counts as a rollback entry point.

It works without a changelog too: put the rollback points directly under the rollback point root and the
tool falls back to identifying them by the timestamp in the directory name, labelling them "unregistered
change".

---

## 6. Core discipline (read this once before you act)

1. **Diagnose by default**: apart from writing its own reports and logs, this tool modifies no file. It does not roll back, restart or kill processes.
2. **No drill, no one-click**: if a recovery script has not been drilled (no PASS drill record inside the rollback point) → it is registered only, never listed as one-click.
3. **No backup, no one-click**: if the backup is not on this machine, or only part of it was found → it is flagged red and one-click is disabled (it will not pretend a rollback is possible).
4. **On failure, freeze the scene**: back up before every write action; do not retry a failure indefinitely, and put a "cool-down" note in the report.
5. **Do not guess the environment**: an unconfigured cold media target is "not configured", an unconfigured log directory falls back to the default; **it would rather say "I do not know" than pretend to know**.

---

## 7. Compatibility

| Item | Status | Notes |
|---|---|---|
| **DSH host `0.2.0-rc.2`** | ✅ **Exercised for real on an isolated instance (2026-10-16)** | `node firstaid.mjs --symptom 1` succeeded under a **separate data root** (rc=1: one anomaly found, and a health report plus a log were produced under that data root). ⚠️ This repository is a **standalone CLI tool** (zero third-party dependencies, imports no `@deepseek-ai/dsh-*` package) ⇒ **it declares no `peerDependencies`** — declaring one would falsely imply a version binding to the host; this row only records the **environment actually exercised** |
| Windows 10/11 | ✅ measured | Process enumeration uses PowerShell CIM (falling back to wmic / tasklist), ports use `netstat` |
| macOS | ⚠️ not measured | The path and configuration layers are written portably, but the process/port probes depend on Windows commands and need adaptation |
| Linux | ⚠️ not measured | Same as above |

| Dependency | Requirement |
|---|---|
| Node.js | 18+ (measured on 24.x) |
| npm packages | **zero** (everything uses Node built-in modules; the unit tests carry a runtime interception layer that errors out if a third-party package is loaded) |

---

## 8. Known limitations (listed honestly)

1. **Process/port probes are not implemented on non-Windows platforms**: `tasklist` / `netstat` / PowerShell CIM are all Windows commands; other platforms take the "cannot determine" branch and label it as such (it does not silently treat it as 0).
2. **The fixture dates in the unit tests are fixed**: the fixture entries in `_test/fixtures.mjs` fall near `2026-09-10`; when the timeline is run with the default `--days 7`, if the current date is more than 7 days past the fixture date, the four assertions B17/B18/B21/C19 fail. This is **time brittleness in the test cases**, not a broken criterion (probe in the delivery report: widening the window to 30 days turns it red immediately).
3. **`--run` only pre-checks, it does not execute a rollback**: this version always refuses real execution (red line: read-only diagnosis).
4. **It does not do cross-machine synchronization**: whether a backup is "somewhere else" is answered by your own backup media; the tool only measures targets visible on this machine.
5. **The changelog format is fixed**: a log that does not follow this format cannot be parsed by the timeline (it records a "parse hint", it does not do so silently).
6. **There is no GUI**: on Windows there is an optional interactive menu shell (`firstaid-launch.ps1`); other platforms use the command line.
7. **`rollback-index --refs` is a shallow scan**: by default it only scans the workspace's `docs/`, `tools/` and the data root; it is not a whole-disk search.

---

## 9. Pre-publish self-check

```bash
# syntax + configuration layer + sanitization scan (the injection word list travels only through
# environment variables; not a single character of it is written into the source)
BUILD_MACHINE_NAMES='...' BUILD_USER_NAMES='...' node scripts/verify-source.mjs .

# positive control: deliberately inject a string that must exist, and it has to go red
# (proof that the rule really runs)
node scripts/verify-source.mjs . --positive-control <a string you are certain exists>

# unit tests (all run in the system temporary directory, touching no real data)
node _test/test-firstaid-run.mjs
node _test/test-drill.mjs
node _test/test-rollback-index.mjs
```

> The values in the injection word list **exist only in your command line** (or a CI secret); they are
> never written into the repository.

---

## 10. License

This repository is released under **AGPL-3.0-only plus a commercial license** (dual licensing; full text in `LICENSE`).

- ⚠️ **AGPL-3.0 does not forbid commercial use by itself**: you may use, modify and redistribute it freely (commercial use included), provided that **if you make a modified version available to others over a network, you must offer the corresponding source under the AGPL as well**;
- "+ a commercial license" = **dual licensing**: if you need it in a **closed-source** or **commercial** setting (where AGPL's copyleft obligations do not apply), a **commercial license** is available — this repository has no public contact address yet, so **please reach out by opening an issue**.

> **License history (for transparency)**: `v0.1.0` – `v0.1.2` were released under **MIT**; **from `v0.1.3` onward this repository is `AGPL-3.0-only plus a commercial license`**. Licenses cannot be revoked for versions already published under MIT — a license change only binds **future** versions. All three places (`LICENSE`, this section, and the `license` field of `package.json`) are in sync.

---

## 11. Default differences from the internal build (read this if you derive from it)

| Item | Internal build default | This repository's default | How to restore the internal behaviour |
|---|---|---|---|
| Data root | fixed workspace path | `FIRSTAID_HOME` > `DSH_HOME` > `~/.dsh` | set `DSH_HOME` or `FIRSTAID_HOME` |
| Changelog directory | `<workspace>/docs/变更流水` | `<data root>/changelog` | set `FIRSTAID_CHANGELOG` |
| Recovery script landing directory | a fixed directory on the desktop | `<data root>/landing` | set `FIRSTAID_LANDING` |
| Supervisor state / log | system temporary directory | `<data root>/guard/` | set `FIRSTAID_GUARD_STATE` / `FIRSTAID_GUARD_LOG` |
| Other instance ports | a built-in list of fixed ports | empty | set `FIRSTAID_OTHER_PORTS` |
| Cold media / mirror targets | drive letters hard-coded per host name | empty / derived from home + workspace | set `FIRSTAID_COLD_ROOTS` / `FIRSTAID_MIRROR_ROOTS` |
| Impact classification, downtime criteria, device tags | concrete projects and host names baked in | neutral default tables | inject via `FIRSTAID_IMPACT_RULES` / `FIRSTAID_STOP_PATTERNS` / `FIRSTAID_DEVICE_TAGS` |

**The recovery scripts themselves, the `_archive` directory name, the `restore-*.{cmd,mjs,ps1}` naming
convention and the timeline parsing rules — these are design semantics and were not changed.**

---

## Related components

Sibling components in the same DSH ecosystem — separate repositories, separate versions, separate
licenses. All of them link back to the same documentation repository,
[`ops-handoff-design`](https://github.com/kira905/ops-handoff-design)
(Gitee mirror: <https://gitee.com/kira905/ops-handoff-design>):

| Repository | What it does | How it relates to this one |
|---|---|---|
| `dsh-firstaid` | Zero-dependency incident toolkit: will not start / frozen / undo a change / data deleted | **this repo** |
| [`dsh-ecosystem-panel`](https://github.com/kira905/dsh-ecosystem-panel) | Read-only ecosystem health panel (six checks in one view) | A division of labour between the routine and the emergency: it answers **"how is today going"** (continuous, read-only, three-colour), while this repository answers **"it is broken right now, what do I do next"** (one-shot, a report you can hand over whole) — and **when the panel itself breaks, this repository is its fallback** |
| [`dsh-diagnostic-tools`](https://github.com/kira905/dsh-diagnostic-tools) | Dependency-closure / decoupling checks + chat image attachment reconciliation | Also "diagnose, never act", but a different scenario: it does **offline targeted forensics** (run proactively before and after an upgrade), while this repository does **triage of the four on-site symptoms** (run first, once something has already gone wrong) |
| [`dsh-butler-archive`](https://github.com/kira905/dsh-butler-archive) | Session archiving (list / preview / restore / delete, optional auto-archive) | In this repository's "undo a change / data deleted" scenarios, sessions and archiving are what you most often run into; this repository only **states honestly whether the recovery script has been drilled**, and does not roll back for anyone |
| [`dsh-session-title-live`](https://github.com/kira905/dsh-session-title-live) | Live session titles with running/done state prefixes | This repository's field report has to answer "which recent sessions did not finish", and the title axis is where that list gets its readability |
| [`dsh-task-board-local`](https://github.com/kira905/dsh-task-board-local) | Self-maintained task board (a card = one real session + a human acceptance gate) | Seen the other way round: day-to-day orchestration of a long-running system lives there, and **it can wedge too when something breaks** — this repository's job is to compress that scene into a report you can hand over |

> There are **no code dependencies** between these components and they share no runtime. They point at
> each other because they answer the same batch of questions for the same kind of person (running an
> agent on your own machine for months: install it, find it, see it, diagnose it). Installing one does
> not affect the others.
