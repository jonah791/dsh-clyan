# 语义文档：dsh-clyan（磁盘反射弧 / clyan CLI 工具面）

> 版本 v0.1 · 2026-09-14 · 作者：爱丽丝 · 状态：**draft**
> 开发方式：语义文档优先（先写清「是什么/什么关系/怎么裁决」，再让实现逼近，最后用实践回修）
> 实现落点：`self-plugins/dsh-clyan/src/index.ts`（接线段：IO / 子进程 / 工具注册，16 工具）+ `src/logic.ts`（**纯逻辑层**，2026-09-14 补课从 `apply()` 闭包抽出）；构建产物 `lib/index.js` / `lib/logic.js`

| 项 | 值 |
|----|----|
| 能力名 | dsh-clyan（插件内 `name = 'clyan'`） |
| 主副本路径 | `self-plugins/dsh-clyan/docs/semantic.md` |
| 实现落点 | `self-plugins/dsh-clyan/src/index.ts`（接线/IO）+ `src/logic.ts`（纯逻辑：argv 构造 / 结果整形 / 容错，可离线单测） |
| 测试 | `tests/logic.test.mjs`（31 例）+ `tests/cli-contract.test.mjs`（13 例）＝ 44 例；跑 **lib 产物**（与运行时同源）；命令 `npm test`（= `node --test "tests/*.test.mjs"`） |
| 版本 | `package.json` = 0.1.0（源码 effect 日志自称 **v0.4**） |
| 组合行 | `E:\alice\.dsh\profiles\web\cordis.patch.yml` 行 162–164，`id: agent-clyan`，**无 config**（`clyanBin='clyan'` 走 PATH、`defaultPath='C:\'`） |
| 状态 | **draft**（实现已上线并挂载；本文为 2026-09-14 补课产物） |

---

## 1 · 定位与反定位

**定位**：把外部 CLI `clyan`（AI 驱动磁盘清理）封成**四层 16 工具**的「磁盘反射弧」——**工具做全和准（clyan），判断与决策归爱丽丝**（src 头注释原文）。四层：感知（pulse/scan/report/space/space_deep/app_cache/doctor）、决策（reclaim/clean/smart_clear/auto_clear）、闭环（history/undo/verify）、运维（schedule/trust）。

**反定位（本文不管什么）**：
- 不管**清理安全策略的实现**：受保护路径拦截、fail-closed 语义裁决、`blocked_items` 全部在 **clyan CLI 内部**；本插件只是 argv 构造与结果整形层（见 §5）
- 不管**磁盘治理方法论**（量后改/温度分层/旁车索引属技能 `workspace-file-governance`）
- 不管**文件级去重/迁移**（本插件只提供「哪里大」的证据，不做治理动作）
- **不是**回收站实现（`undo` 依赖 CLI 自己的回收机制）
- **不是**定时调度器：`clyan_schedule` 只转发给 CLI 注册 Windows 计划任务

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| 反射弧 | 插件定位隐喻：**快感知（pulse <1ms）+ 归我决策**，不替用户拍板 |
| `recovery_cost` | 删除后的恢复代价分级：`none` / `low` / `medium` / `high` / `unknown`（reclaim 按它分阶段） |
| `safety` | 项的安全级别：`safe` / `caution` / `unsafe`（`safe` 通常可再生） |
| `confidence` | CLI 给出的置信度（0–1；`smart_clear` 阈值 0.9，`clean --min-confidence` 为 0–100 口径） |
| `blocked_items` | CLI 安全闸门拦截的项（**强制拦截而非警告**）——由 CLI 产出，插件透传 |
| `detail=true` | 关闭插件的聚合摘要，返回全量 `items`（可能很大，**撑爆上下文的风险口**） |
| `--json` | 每次调用**恒定前置**的 CLI 参数（`spawn(bin, ['--json', ...args])`） |
| 生效判据 | 「当前 web 进程真的在跑这份构建」的进程级判据（见 §6） |

## 3 · 概念模型

```
爱丽丝（会话内直接调用；本插件无技能接线）
   │
   ├─ 感知层 ─ clyan_pulse ──► clyan pulse [path]                      (timeout 30s)
   │           clyan_scan ───► clyan scan <mode> [--phase n] [--path p] (默认 180s)
   │                          └─ detail≠true → summarizeScan()（分类/安全分布/top N）
   │           clyan_report ─► Promise.all(pulse, scan quick, history --limit 5) → 合成
   │           clyan_space ──► clyan scan disk [--path p]               (180s) → top_dirs + gap_analysis
   │           clyan_space_deep ► **插件内 DFS 递归**（不调 CLI）→ big_dirs + big_files
   │           clyan_app_cache ► clyan scan app-cache --min-size-mb n   → 按 safety 聚合 + top
   │           clyan_doctor ─► clyan doctor                            (60s)
   ├─ 决策层 ─ clyan_reclaim ─► clyan reclaim [--phase cost] [--dry-run] [--yes] [path]
   │           clyan_clean ───► clyan clean [--items …] [--dry-run] [--auto-safe] [--deep] …
   │           clyan_smart_clear ► scan quick phase2 → **插件侧过滤**
   │                                (recovery_cost==='none' && safety==='safe' && confidence>=0.9)
   │                                → 建议集；执行需 dryRun===false && yes===true
   │                                → clyan clean --items '[{path,size}…]' --yes
   │           clyan_auto_clear ► clyan auto-clear [--target-gb n] [path]   ← 零决策，真删
   ├─ 闭环层 ─ clyan_history ─► clyan history [--id x] [--limit n]      (30s)
   │           clyan_undo ────► clyan undo <id>                        (60s)
   │           clyan_verify ──► 无 id：pulse + history --limit 3 → 释放量对比；有 id：history --id
   └─ 运维层 ─ clyan_schedule ► clyan schedule [--create|--remove] [--path] [--time]  (30s)
               clyan_trust ──► clyan trust <list|add|remove|audit> [path] [--reason r] (30s)
   ▼ cliError(r)：ok → null；否则 (stderr || raw || 'clyan 执行失败').slice(0,500)
   ▼ {ok:true, result} | {ok:false, result:null, error}
```

不变量（invariants）：
1. **I1 删除类默认预览**：`reclaim`/`clean`/`smart_clear` 在调用方**未显式传 `dryRun:false`** 时一律追加 `--dry-run`（`args.dryRun !== false` 判据，`src/index.ts:540/602/649`）。
2. **I2 插件自身永不删文件**：插件侧文件系统调用只有 `fsp.readdir` / `fsp.stat`（`scanDeepTree`，只读）；所有删除都发生在 `clyan` 子进程内。
3. **I3 大输出默认降级**：`scan`/`reclaim`/`app_cache` 默认返回聚合摘要，全量 `items` 仅在 `detail:true` 时返回，避免撑爆上下文。
4. **I4 失败闭合**：CLI 失败/超时/无法启动一律返回 `{ok:false, error}`，不返回半截数据当成功（唯一例外见 §5「聚合中的部分容忍」）。
5. **I5 无落地副作用**：本插件不写任何缓存/状态/侧车文件（截图版对照：`dsh-agent-webops` 会落 PNG，本插件**零落盘**）。
6. **I6 外部数据容错（2026-09-14 补课新增）**：**`clyan` 的 JSON 形状不由本插件保证**——遍历其输出前一律归一（`asArray`）或跳过脏条目；**退化数据 → 退化输出，绝不抛**（例：`details.<cat>=null` 不得让 `summarizeScan` 抛 TypeError）。合法输入路径与修正前逐字一致（见 §7 A11、§9）。

## 4 · 契约

### 4.1 配置（`Config`）

| 字段 | 类型 | 默认 | 语义（组合现状） |
|------|------|------|-----------------|
| `clyanBin` | string | `clyan` | **组合未钉住** → 依赖 PATH 解析（见 U1） |
| `timeoutMs` | number | `180000` | 深扫描默认超时；被多数工具复用 |
| `defaultPath` | string | `C:\` | `path` 缺省时的目标盘（**组合未覆盖**） |

### 4.2 工具契约（16 个 / 四层）

| 层 | 工具 | 关键入参 | 语义要点 |
|----|------|---------|---------|
| 感知 | `clyan_pulse` | `path?` | 零扫描零 IO，返回空闲空间（timeout 30s） |
| 感知 | `clyan_scan` | `mode?`/`phase?(1)`/`path?`/`detail?`/`topN?(10)` | 默认聚合摘要 |
| 感知 | `clyan_report` | `path?`/`phase?(1)` | pulse+scan+history 合成决策全貌；**两者皆失败才报错** |
| 感知 | `clyan_space` | `path?`/`topN?(10)` | `scan disk`；带 `gap_analysis`（非全盘扫描时给出提示） |
| 感知 | `clyan_space_deep` | `path?`/`maxDepth?(4)`/`dirThresholdMB?(200)`/`fileThresholdMB?(200)`/`topN?(20)` | **插件内递归**，补 CLI「只统计顶层」的缺 |
| 感知 | `clyan_app_cache` | `minSizeMB?(50)`/`detail?`/`topN?(15)` | `scan app-cache`，AppData 关键字扫描 |
| 感知 | `clyan_doctor` | — | 模块/数据库/磁盘/56 providers/缓存一致性 |
| 决策 | `clyan_reclaim` | `path?`/`phase?(cost)`/`dryRun?(true)`/`yes?`/`detail?` | 按 `recovery_cost` 分阶段 |
| 决策 | `clyan_clean` | `items?`/`dryRun?(true)`/`autoSafe?`/`deep?`/`strategy?(safe)`/`minConfidence?`/`path?`/`yes?`/`safety?` | 安全闸门 **在 CLI**（fail-closed + `blocked_items`） |
| 决策 | `clyan_smart_clear` | `path?`/`phase?(2)`/`dryRun?(true)`/`yes?`/`minConfidence?(0.9)` | **插件侧白名单过滤**（三重条件） |
| 决策 | `clyan_auto_clear` | `path?`/`targetGb?` | **零决策真删**（`recovery_cost=none`），描述明示「调用前确认」 |
| 闭环 | `clyan_history` | `id?`/`limit?` | 列表或单次详情 |
| 闭环 | `clyan_undo` | `id`(必填) | 从回收站恢复 |
| 闭环 | `clyan_verify` | `id?`/`path?` | 无 id → `before_free`/`after_free` 对比 |
| 运维 | `clyan_schedule` | `action?(create/remove)`/`path?`/`time?` | **描述明示受自主性铁律约束**（供主人安排用） |
| 运维 | `clyan_trust` | `action?(list)`/`path?`/`reason?` | `add` 时带 `--reason` 审计留痕 |

### 4.3 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号） | 时机 |
|-------|------------------|------|
| web 组合 | `.dsh/profiles/web/cordis.patch.yml:163`（`id: agent-clyan`，**无 config 块**） | web 启动装载（**唯一挂载点**） |
| 插件自身 | `src/index.ts:220` `apply()` → `ctx.tools.register(defineTool({name:'clyan_*'}))` × 16 | 装载时注册全部 16 个 |
| 插件自身 | `src/index.ts:887` `ctx.effect(() => { logger.info('ready v0.4（磁盘反射弧：16 工具；安全重构：execute 强制拦截保护路径 + 语义裁决 fail-closed + trust 审计）') })` | 装载末尾（**宿主 logger 不落盘**） |
| 依赖服务 | `src/index.ts:inject = ['tools']` | cordis 激活门 |
| 子进程 | `spawn(config.clyanBin, ['--json', …argv], { windowsHide:true, shell:false })`（`src/index.ts:57`） | 除 `clyan_space_deep` 外全部工具 |
| 插件内递归 | `scanDeepTree()`（`src/index.ts:162`）+ `summarizeDeep()`（`:203`） | `clyan_space_deep` 专用（**不调 CLI**） |
| 插件内过滤 | `filterSmartCandidates()` + `smartClearPayload()`（`src/logic.ts`；调用点 `src/index.ts` 的 `clyan_smart_clear.execute`） | `clyan_smart_clear` 的**插件侧安全裁决**（三重白名单 + 载荷只带 path/size） |
| 纯逻辑层 | `humanSize` / `cliError` / `collectItems` / `summarizeScan` / `summarizeDeep` / `buildReclaimArgs` / `buildCleanArgs`（`src/logic.ts`） | 全部由 `src/index.ts` import 使用（**调用点单点**：`import { … } from './logic.js'`，行 34–38） |
| 测试（唯一消费方） | `tests/logic.test.mjs` / `tests/cli-contract.test.mjs` → `import … from '../lib/logic.js'` | 跑 **lib 产物**（不跑 src）——与运行时同源；`npm test` |
| 只读 fs | `fsp.readdir` / `fsp.stat`（`src/index.ts:173/189`） | 深扫时（**I2：读-only**） |
| 铁律接线 | `clyan_schedule` 的 tool description：**「自主性铁律下爱丽丝不自动创建定时删除，此工具供主人安排时使用」**（`src/index.ts:824`） | 工具描述层对 `AGENTS.md §二·2.4`（禁止自动决策机制）的显式落实 |
| 生态盘点 | `E:\alice\docs\semantics\coverage.md:33` 把 clyan 列为 **P3 待补文档**能力 | 本次补课即该条目的执行 |
| 技能（消费方） | **无**——`rg "clyan"` 在 `alice-self-assets/skills/` 命中 0 条（工具面靠会话内直接调用，无技能接线） | — |
| 落盘产物 | **无**（无缓存/状态/侧车轨迹） | — |

## 5 · 边界与信任

- **能力边界 ≠ 沙箱（本文件最重要的一条）**：`clyan_clean`/`reclaim`/`smart_clear`/`auto_clear` 的工具描述写着「受保护路径强制拦截（fail-closed）」「语义裁决」，**但这些判定全部实现在 clyan CLI 内部**——本插件只做 argv 构造与结果整形，**自身不含任何路径白名单/黑名单逻辑**。（插件内唯一的实质性安全裁决是 `clyan_smart_clear` 的三重过滤：`recovery_cost==='none' && safety==='safe' && confidence>=0.9`。）
  → 推论：**插件的「安全」上限 = CLI 的安全实现**。CLI 被替换/降级（`clyanBin` 指向别的可执行文件）时，插件的安全声明**一起失效**，且插件不会察觉。
- 不越界清单：不写文件（除委托 CLI 删除）、不做持久化、不自动创建定时任务（受 §2.4 约束）、不做恢复（恢复交 `clyan_undo`）、不评估「该不该清」（决策归爱丽丝）。
- 失败面：
  - 超时 → `child.kill()` + `{ok:false, error:'clyan 超时（<ms>ms）'}`（拒绝 + 报错）
  - 无法启动（PATH 里没有 clyan）→ `{ok:false, error:'无法启动 clyan：<msg>'}`（拒绝 + 报错）
  - CLI 非 0 退出但有可解析 JSON → `ok = code === 0 || data !== null` → **判为成功**（宽松口径，同 `dsh-anima-tags` 家族）
  - `clyan_report` 的**部分容忍**：pulse 与 scan **两者都失败**才返回 error；只有其一失败时仍返回 `ok:true`（失败的那半为 `null`）——**这是刻意的降级设计，但调用方必须自己检查字段是否为空**（U3）。
  - `clyan_verify` 无对比数据 → `{ok:true, note:'无对比数据（历史缺失）'}`（**「没有」≠「失败」**）
  - JSON 解析失败 → 正则截取首个 `{…}`/`[…]` 兜底；仍失败则 `data=null` → 走 error 分支（拒绝 + 报错）

## 6 · 与既有机制的关系

- **AGENTS.md §二·2.4（自主性铁律）**：`clyan_auto_clear`（零决策删除）与 `clyan_schedule`（定时删除）是**铁律的直接相关面**。铁律禁止「自动决策机制」——因此 `clyan_schedule` 的 description 显式声明「供主人安排时使用」，`auto_clear` 的描述要求「调用前确认」。**语义上：这两个工具存在 ≠ 可被自动调用；调用它们必须有人（主人/爱丽丝）当场的显式决策 + reason 留痕。**
- **AGENTS.md §二·2.2（须请示：删数据）**：批量删除属「删数据（不可逆破坏）」类——`clyan_reclaim`/`clyan_clean`/`auto_clear` 的真实执行（`dryRun:false + yes:true`）在**语义上属于须请示动作**，需有主人的授权或明确的现场决策依据。
- **组合变更纪律（§5.11）**：改源码 = 组合变更；改 `clyanBin/defaultPath/timeoutMs` = 配置变更（`plugin_configure`，自带预检 + 哨兵重启）。
- **生效判据（改代码后怎么证明真的生效）**：
  1. 进程级：`self-plugins/dsh-clyan/lib/index.js` mtime 必须早于 3080 监听进程启动时间。本轮实测：lib = `2026-09-06 17:38:04`，web（PID 7080）启动 = `2026-09-14 10:05:47` → **已生效**。
  2. 环境级：`where clyan`（或 `clyan --version`）在 PATH 中可解析——**组合未钉路径，环境级是硬前提**；解析不到时全部工具返回 `无法启动 clyan：…`（明确报错，不静默）。
  3. 工具级：`clyan_pulse path=C:\` 返回含空闲空间的 `ok:true`（一次调用即判真假）。
  4. 版本级：装载日志自称 `ready v0.4（…16 工具…）`——但**宿主 logger 不落盘**，只能靠会话内观察。
- **回退（出问题怎么退）**：
  1. **数据级回退（最优先）**：误删 → `clyan_history limit=…` 取操作 id → `clyan_undo id=<id>`（从回收站恢复）；恢复后 `clyan_verify id=<id>` 复核。
  2. 组合级：`plugin_stop dsh-clyan` / 删 patch 行 → 工具面消失（磁盘清理能力回到「手工 + 其它工具」状态）。
  3. 代码级：`git -C E:/alice/self-plugins/dsh-clyan log --oneline` → `git revert <sha>` → `pnpm build` → 预检 → 哨兵重启。
  4. 配置级：`clyanBin` 指向错误二进制 → 改回 `'clyan'`（PATH）或显式绝对路径，走 `plugin_configure`。

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（单测名/命令/日志行/HTTP） | 状态 |
|---|-----------|------------------------------|------|
| A1 | 工具面恰为 16 个（四层） | 会话工具列表 `clyan_` 前缀命中 16；源码 `ctx.tools.register` 计数 = 16 | 已实测（源码计数） |
| A2 | **文件头注释的「14 个」是陈旧的** | `src/index.ts:7` 写「四层工具面（14 个）」，实际注册 16 个（含 `clyan_space`/`clyan_space_deep`） | 已实测（不一致，见 §8 缺口①） |
| A3 | 删除类默认预览（I1） | **`npm test` → `tests/cli-contract.test.mjs`**：`buildCleanArgs({})` 与 `buildReclaimArgs({})` 必含 `--dry-run`；`yes:true` 单独出现时仍保留 `--dry-run`；去掉 `--dry-run` 必须 `dryRun:false` **且** `yes:true`；含**尸体测试**证明检查器不空转 | **已验收（单测，2026-09-14）** |
| A4 | 插件自身不删文件（I2） | 调用 `clyan_space_deep` 前后，目标盘文件数/mtime 不变 | **待验收** |
| A5 | 大输出默认降级（I3） | `clyan_scan`（不带 detail）返回体含 `categories`/`safety_distribution`/`top_items`，**不含** `details.<cat>.items` | **待验收** |
| A6 | `smart_clear` 三重过滤 | **插件侧过滤**已离线验收（见 A12）；端到端（`executed:null` + note 提示需 `dryRun=false + yes=true`）**待线上验收** | 部分验收（离线部分已完成 2026-09-14） |
| A7 | 无 CLI 即失败 | 临时把 `clyanBin` 指向不存在路径 → `'无法启动 clyan：…'`（非空成功） | **待验收** |
| A8 | 当前进程加载最新构建 | lib mtime `2026-09-06 17:38:04` < web PID 7080 启动 `2026-09-14 10:05:47` | 已实测（2026-09-14 读数） |
| A9 | 挂载行唯一且无 config | `grep -n "dsh-clyan" cordis.patch.yml` → 1 命中（行 164），相邻无 `config:` 块 | 已实测 |
| A10 | 无技能接线 | `rg "clyan" alice-self-assets/skills/` → 0 命中 | 已实测（2026-09-14） |
| A11 | **容错（I6）：损坏的 CLI 数据不得让摘要抛异常** | `npm test` → `summarizeScan: 脏数据（损坏的 details 条目）不再抛 TypeError` + `summarizeDeep: 退化输入…不抛` + `collectItems: 脏数据容错…不整体崩`。**修前证伪**：`node -e "Object.values({junk:null}).reduce((s,d)=>s+d.scan_time_ms,0)"` → `TypeError: Cannot read properties of null (reading 'scan_time_ms')`；`categories:5` → `5.map is not a function` | **已验收（单测 + 修前证伪，2026-09-14）** |
| A12 | `smart_clear` 三重白名单可离线复现（插件唯一实质安全裁决） | `tests/logic.test.mjs` → `filterSmartCandidates:*` 5 例：命中 / 单条件失败即拒 / 阈值边界（恰 0.9 入选、0.9000001 拒绝）/ 脏数据全拒 / 幂等；`smartClearPayload` 不泄漏 confidence·safety | **已验收（单测，2026-09-14）** |
| A13 | 失败面文案：`cliError` = `stderr > raw > 兜底`，截断 500，`ok:true` 恒 `null` | `tests/logic.test.mjs` → `cliError:*` 5 例（含纯空白 stderr、缺字段损坏对象） | **已验收（单测，2026-09-14）** |
| A14 | 摘要不含全量 `items`（I3） | `tests/logic.test.mjs` → `summarizeScan: 摘要字段不含全量 items`（断言返回体无 `details`/`items` 键） | **已验收（单测，2026-09-14）** |
| A15 | 测试**完全离线**（不对真实磁盘跑扫描/删除） | `tests/*.test.mjs` 只 import `../lib/logic.js` 纯函数；无 `child_process`/`node:fs` 调用、假数据全为构造对象；44 例耗时 <150ms | **已验收（代码审查 + 全绿，2026-09-14）** |

## 8 · 与实现的关系

- 主实现：`self-plugins/dsh-clyan/src/index.ts`（唯一文件，891 行；无同语义副本）——**单文件承载 16 工具 + 3 个内部算法**（`summarizeScan` / `scanDeepTree`+`summarizeDeep` / `collectItems`），是生态中最大的单体插件源文件。
- 未实现/未验证部分**显式标注**：
  - **缺口① 头注释陈旧（已实测）**：`src/index.ts:7` 写「四层工具面（14 个）」，而实际注册 **16** 个（`clyan_space`、`clyan_space_deep` 未计入）。effect 日志（`:888`）写的是 16，二者自相矛盾。**以代码注册数为准（16）**。
  - **缺口② `clyanBin` 未在组合中钉住**：与 `dsh-anima-tags`（`tagsBin` 已钉绝对路径）形成反差；`clyan` 一旦离开 PATH，**16 个工具全部失效**（报错明确，但属可预防的环境耦合）。
  - **缺口③ 安全声明的归属未在代码中标注**：§5 那条「拦截在 CLI 内」的事实只能从 effect 日志文案推断，源码无注释说明 → 下一个读者极易误以为插件自带闸门。
  - **缺口④ 无单测 → 已闭环（2026-09-14 补课）**：新增 `tests/logic.test.mjs`（31 例）+ `tests/cli-contract.test.mjs`（13 例），`package.json` 暴露 `npm test`；纯逻辑同时从 `apply()` 闭包搬进 `src/logic.ts`（**行为不变，只有一处刻意的容错修正**，见 §9 与 A11）。仍未覆盖：`scanDeepTree`（真扫磁盘的 IO 递归）与 16 个 `execute` 的接线层——测试纪律要求**离线且不碰真实磁盘**，这两处只能靠线上验收（A4/A5/A7）。
  - **缺口⑤ 无侧车轨迹**：零落盘 → 「实际 argv / 耗时 / 断在哪一段」事后全不可查（§5.22 五问中的三问）；且**删除类操作的 argv 不留痕**，事后只能靠 CLI 自己的 `history` 反查。
  - `package.json` 版本 `0.1.0` 与源码自称 `v0.4` 不一致（版本口径待归口）。

## 9 · 实践修订记录

- **2026-09-14 补课：本插件此前无语义文档（可维护性工程）**
  - 语义**被确认**：四层 16 工具结构；「工具做全和准、决策归爱丽丝」的定位；I1 默认预览；I2 插件自身只读；I3 大输出降级；`--json` 恒定前置。
  - 语义**被补充**：**安全闸门的真实归属在 CLI 而非插件**（§5，本文件最重要的补充）；`clyan_schedule` 描述对 §2.4 自主性铁律的显式落实；`clyan_report` 的部分容忍口径；组合挂载点无 config 导致的环境耦合。
  - 语义**被修正**：头注释「14 个工具」→ 实测 **16 个**；version `0.1.0` vs effect 日志 `v0.4`（登记不一致，未裁决）。
  - 教训（同时回写技能 `semantic-doc-first`）：**透传型插件的「安全」必须写明出处**——文档若只抄工具描述里的「fail-closed/强制拦截」，读者会以为防护在本插件内；真实防护在被封装的二进制里，二者降级不会同步。

- **2026-09-14 补课（第二轮）：补测试 + 覆盖失败路径（可维护性体检 S3/S6）**
  - **做了什么（移动为主，改动最小化）**：把 `humanSize` / `cliError` / `collectItems` / `summarizeScan` / `summarizeDeep` 从 `src/index.ts` 的顶层搬进新模块 `src/logic.ts`（纯函数：无 IO、无 ctx、无时钟），并把两个删除类工具的 **argv 构造**（`buildReclaimArgs` / `buildCleanArgs`）与 **smart_clear 三重过滤**（`filterSmartCandidates` / `smartClearPayload`）也从 `execute` 闭包里抽出来——它们此前**完全不可测**，正是 I1 与「插件唯一实质安全裁决」的落点。接线层（`runCli` / `scanDeepTree` / 16 个 `execute`）留在 `index.ts`，一行未改。
  - **新增测试**：`tests/logic.test.mjs`（31 例：单位换算与 NaN/负数/Infinity、错误文案优先级与截断、items 汇总容错、摘要排序/topN/分布、深树摘要 basename 与边界、白名单阈值与脏数据、幂等/不改写输入）+ `tests/cli-contract.test.mjs`（13 例：I1 默认预览、`--yes` 门控、argv 顺序锁定、空白/越界参数、**尸体测试**——用已知坏 argv 证明检查器真的会拦）。合计 **44/44 全绿**（`npm test`，<150ms）。
  - **修前证伪的真缺陷（唯一行为改动，已显式声明）**：`summarizeScan` 的 `Object.values(scan.details).reduce((s,d) => s + (d.scan_time_ms ?? 0))` 在 `details.<cat>` 为 `null` 时抛 `TypeError: Cannot read properties of null`；`(scan.categories ?? []).map` 在 `categories` 非数组时抛 `x.map is not a function`——即 **CLI 输出一旦退化成脏数据，`clyan_scan`/`clyan_report` 的摘要层整体崩**，而这恰是本插件「防撑爆上下文」的关键路径。修法：引入 `asArray()` 归一 + 跳过 null 条目（**退化数据 → 退化输出，绝不抛**，见 I6）。**合法输入下的输出与修正前逐字一致**（搬家版对同一 `SCAN_SAMPLE` 的摘要断言即锁）。
  - 语义**被补充**：I6（外部数据容错）；`tests/*.test.mjs` 与 `lib/logic.js` 的消费关系进入 §4.3 调用点清单。
  - 语义**被修正**：本文原写「唯一源文件 891 行」→ 现为 `index.ts`（接线）+ `logic.ts`（纯逻辑）双文件；A3 由**待验收**转**已验收（单测）**，A6 转「部分验收（离线部分已验收）」。
  - 教训：**「不可测」往往不是逻辑复杂，而是位置错了**——I1 安全默认曾藏在 `execute` 里，只能靠「跑一次真 CLI 看有没有删东西」验证（危险且昂贵）；搬到纯函数后，**危险语义变成了 12 行断言**。

## 10 · 未决问题

- **U1 `clyanBin` 是否该在组合中钉绝对路径**：与 anima-tags 对齐（钉住）能消除 PATH 依赖，但会让「clyan 升级换目录」变成配置改动。倾向**钉住**（显式 > 隐式，AGENTS.md 包边界纪律）。需主人裁决。
- **U2 删除类操作的留痕**：目前插件侧零留痕，删除的 argv 事后不可查。倾向：补 `<DSH_HOME>/clyan-trace.jsonl`（吞错，一行一调用：atMs/argv/dryRun/exitCode/blockedCount），并把「真实执行（非 dry-run）」单独标一行。需主人确认是否新增落盘面。
- **U3 `clyan_report` 部分失败的可判读性**：`ok:true` 但 `disk`/`cleanable` 可能为 `null`，调用方不细看会误读。倾向：增加 `partial: true` + `failed_parts: [...]` 字段（§5.22「断在哪一段」）。
- **U4 版本口径**：`package.json 0.1.0` / 源码注释 `v0.2`（文件头）/ effect 日志 `v0.4`——三处不一致。倾向：以 `package.json` 为唯一真源，头注释与日志改为注入版本常量。需实现者裁决。
- **U5 `clyan_space_deep` 与 CLI 的能力重叠**：CLI 已有 `scan disk`，插件又自建 DFS（因 CLI 只统计顶层）。长期看是「插件补 CLI 的缺」还是「该推 CLI 修」？倾向：先在 CLI 侧修，插件递归降级为可选——否则同一语义两份实现会漂移（I1 单一真源）。需裁决。

**本轮（2026-09-14 补课：补测试 + 失败路径）闭环情况**：U1–U5 **均未被本次工作回答**（组合配置 / 留痕面 / 报告可判读性 / 版本口径 / 能力重叠——与「补测试」无因果关系，**不做形式闭环**）。本轮闭环的是 §8 的 **缺口④ 无单测**（→ 已闭环，见 §9）。U2（删除类留痕）在本轮取证中**证据增强**：argv 现在可离线单测，但**线上实际 argv 仍零留痕**——U2 优先级因此上调（它拦住的正是「测试绿了、线上跑的却是哪条 argv 仍不可查」）。
