# 语义文档：dsh-clyan（磁盘反射弧 / clyan CLI 工具面）

> 版本 v0.2 · 2026-09-14 · 作者：爱丽丝 · 状态：**draft**
> 开发方式：语义文档优先（先写清「是什么/什么关系/怎么裁决」，再让实现逼近，最后用实践回修）
> 实现落点：`self-plugins/dsh-clyan/src/index.ts`（接线段：IO / 子进程 / 工具注册，16 工具）+ `src/logic.ts`（**纯逻辑层**，2026-09-14 补课从 `apply()` 闭包抽出）+ `src/trace.ts`（**自证轨迹层**：观测纯函数 + 薄 IO，2026-09-14 S4 收尾）；构建产物 `lib/index.js` / `lib/logic.js` / `lib/trace.js`

| 项 | 值 |
|----|----|
| 能力名 | dsh-clyan（插件内 `name = 'clyan'`） |
| 主副本路径 | `self-plugins/dsh-clyan/docs/semantic.md` |
| 实现落点 | `self-plugins/dsh-clyan/src/index.ts`（接线/IO）+ `src/logic.ts`（纯逻辑：argv 构造 / 结果整形 / 容错）+ `src/trace.ts`（自证轨迹：路径解析 / 脱敏 / 清洗账 / 包装器） |
| 测试 | `tests/logic.test.mjs`（31）+ `tests/cli-contract.test.mjs`（13）+ `tests/trace.test.mjs`（43）+ `tests/trace-wiring.test.mjs`（9）＝ **96 例**；跑 **lib 产物**（与运行时同源）；命令 `npm test`（= `node --test "tests/*.test.mjs"`） |
| 版本 | `package.json` = 0.1.0（源码 effect 日志自称 **v0.4**；轨迹 `build` 用 `package.json` 口径，见 U4） |
| 组合行 | `E:\alice\.dsh\profiles\web\cordis.patch.yml` 行 162–164，`id: agent-clyan`，**无 config**（`clyanBin='clyan'` 走 PATH、`defaultPath='C:\'`） |
| 落盘产物 | `<DSH_HOME>/clyan-trace.jsonl`（自证轨迹，见 §4.4；`DSH_CLYAN_TRACE=0` 可关） |
| 状态 | **draft**（实现已上线并挂载；轨迹层 2026-09-14 新增，端到端证据见 §7 A16–A20） |

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
| 自证轨迹 | 侧车证据层：`<DSH_HOME>/clyan-trace.jsonl`，一行一阶段 JSONL，`tail` 即可回答「跑的是哪个构建 / 上游给了什么形状 / 丢了几条 / 断在哪一段」（§4.4） |
| 阶段（phase） | 轨迹行的类型枚举，**只有四个**：`boot` / `cli` / `call` / `scan-shape`（§4.4） |
| 清洗账（shape） | `scan-shape` 行的字段：上游 `details` 各条目的去向（接受/丢弃 + 依据）+ 进入摘要的 item 数——`summarizeScan` 脏数据缺陷的**可见面** |
| 真删标记（destructive） | `call` 行的布尔字段：本次调用**关闭了预览**（= 可能真删）；`clyan_auto_clear` 恒为真（§4.4 判定表） |
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
5. **I5 业务零落盘（2026-09-14 修正）**：本插件对**业务数据**不写任何缓存/状态文件（删除动作全在 CLI 子进程内）。唯一落盘 = **观测侧车轨迹** `<DSH_HOME>/clyan-trace.jsonl`（§4.4）：写入失败一律吞错返回 `false`，**调用方忽略返回值**，业务路径零影响；`DSH_CLYAN_TRACE=0` 可整体关闭。~~原文「零落盘」已不成立（观测层新增，2026-09-14 §9）。~~
6. **I6 外部数据容错（2026-09-14 补课新增）**：**`clyan` 的 JSON 形状不由本插件保证**——遍历其输出前一律归一（`asArray`）或跳过脏条目；**退化数据 → 退化输出，绝不抛**（例：`details.<cat>=null` 不得让 `summarizeScan` 抛 TypeError）。合法输入路径与修正前逐字一致（见 §7 A11、§9）。
7. **I7 摘要层的账目可自证（2026-09-14 S4 新增）**：每次 `summarizeScan` 都落一行 `scan-shape`，其中 `shape.itemsKept` **必须等于** `summarizeScan().total_items`（同一条轨迹行里可对账）——「上游给了什么形状 / 丢了哪几条 / 依据什么」不再需要反解源码（§4.4、§7 A17）。
8. **I8 观测绝不反噬（2026-09-14 S4 新增）**：轨迹 IO 失败只吞（返回 `false`，调用方忽略）；业务异常**原样重抛**（同一异常对象）；返回值**原样透出**（`output.schema` 为 `additionalProperties:false`，绝不混入新字段）。

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
| 插件自身 | `src/index.ts` `apply()` → `reg(defineTool({name:'clyan_*'}))` × 16（`reg` = **唯一注册入口**，`index.ts` 内 `ctx.tools.register.bind(ctx.tools)` + `instrumentTool`） | 装载时注册全部 16 个（**每个都被包装器覆盖**，无绕过路径——§7 A19 静态守卫） |
| 插件自身 | `src/index.ts` `ctx.effect(() => { logger.info('ready v0.4（…16 工具…）') })` | 装载末尾（**宿主 logger 不落盘** → 这正是轨迹层存在的理由） |
| 依赖服务 | `src/index.ts:inject = ['tools']` | cordis 激活门 |
| 子进程 | `spawn(config.clyanBin, ['--json', …argv], { windowsHide:true, shell:false })`（`src/index.ts:57`） | 除 `clyan_space_deep` 外全部工具 |
| 插件内递归 | `scanDeepTree()`（`src/index.ts:162`）+ `summarizeDeep()`（`:203`） | `clyan_space_deep` 专用（**不调 CLI**） |
| 插件内过滤 | `filterSmartCandidates()` + `smartClearPayload()`（`src/logic.ts`；调用点 `src/index.ts` 的 `clyan_smart_clear.execute`） | `clyan_smart_clear` 的**插件侧安全裁决**（三重白名单 + 载荷只带 path/size） |
| 纯逻辑层 | `humanSize` / `cliError` / `collectItems` / `summarizeScan` / `summarizeDeep` / `buildReclaimArgs` / `buildCleanArgs`（`src/logic.ts`） | 全部由 `src/index.ts` import 使用（**调用点单点**：`import { … } from './logic.js'`，行 34–38） |
| 测试（唯一消费方） | `tests/logic.test.mjs` / `tests/cli-contract.test.mjs` → `import … from '../lib/logic.js'`；`tests/trace.test.mjs` → `'../lib/trace.js'`；`tests/trace-wiring.test.mjs` → `'../lib/index.js'`（**挂载 + 假 ctx + 临时 DSH_HOME**） | 跑 **lib 产物**（不跑 src）——与运行时同源；`npm test` |
| 只读 fs | `fsp.readdir` / `fsp.stat`（`src/index.ts` `scanDeepTree`） | 深扫时（**I2：读-only**） |
| 铁律接线 | `clyan_schedule` 的 tool description：**「自主性铁律下爱丽丝不自动创建定时删除，此工具安排供主人使用」** | 工具描述层对 `AGENTS.md §二·2.4`（禁止自动决策机制）的显式落实 |
| 生态盘点 | `E:\alice\docs\semantics\coverage.md:33` 把 clyan 列为 **P3 待补文档**能力 | 本次补课即该条目的执行 |
| 技能（消费方） | **无**——`rg "clyan"` 在 `alice-self-assets/skills/` 命中 0 条（工具面靠会话内直接调用，无技能接线） | — |
| **落盘产物（唯一）** | `<DSH_HOME>/clyan-trace.jsonl`——由 `src/trace.ts` 的 `appendTraceEntry()` 写；**写入点恰 3 处**（均在 `src/index.ts`）：`boot`（装载末尾）/ `cli`（`runCli` 包装器）/ `call`+`scan-shape`（`instrumentTool` 包装体与 `summarizeTraced`） | 每次装载 + 每次工具调用（§4.4；§7 A19 静态守卫锁死「恰 3 处」） |

### 4.4 落盘轨迹契约（`<DSH_HOME>/clyan-trace.jsonl`）`[MUST]`

**为什么存在**：本插件是透传型插件，两处真相原本在插件外不可见——① 外部 CLI 的 JSON 形状 + 摘要层的清洗结果（`summarizeScan` 脏数据缺陷的现场）；② 删除类操作到底是预览还是真删（U2）。宿主 logger 不落盘（`AGENTS.md §5.22` 规则 1），故落侧车轨迹。

| 项 | 契约 |
|----|------|
| 落盘路径 | `<DSH_HOME>/clyan-trace.jsonl`（`DSH_HOME` 环境变量优先，缺省 `<homedir>/.dsh`）。**路径解析单一真源** = `trace.ts` 的 `resolveHome()` + `clyanTracePath()`；`src/index.ts` 内不含任何 `'DSH_HOME'` 字面量（§7 A19 静态守卫） |
| 关闭开关 | `DSH_CLYAN_TRACE=0` → `clyanTrace()` 恒返回 `false`、不落盘（缺省开启：证据层是默认行为） |
| 行格式 | 单行 JSON（JSONL），键序固定，未用字段不出现；坏行/半行/空行由 `parseTraceEntries()` 跳过（不抛） |
| 阶段枚举 | **只有四个**：`boot`（装载自报）/ `cli`（每次子进程调用的上游形状）/ `call`（每次工具调用的入参·耗时·成败）/ `scan-shape`（上游数据 → 摘要层的清洗账） |
| 固定字段 | `atMs`（行首时刻：`boot` = 装载时刻，`cli`/`call`/`scan-shape` = 该次调用的**开始**时刻，配 `durationMs` 可推结束）/ `phase` / `build`（`<package.json version>@<lib/index.js mtime ms>`）/ `pid` / `op`，其余按阶段取用 |
| `boot` 专有 | `tools`（工具面自报，16 个）/ `cfg`（`clyanBin`/`timeoutMs`/`defaultPath`）/ `tracePath` |
| `cli` 专有 | `verb`（`argv[0]`）/ `argv`（脱敏摘要；`--items` 载荷折叠为 `<payload: json[N]>`）/ `argvLen` / `exitOk` / `rawChars`（stdout 字符数）/ `parsed`（`object`/`array`/`null`）/ `degraded`（JSON 退化到正则兜底的启发式指纹）/ `stderrChars` / `error`（stderr 脱敏截断 400） |
| `call` 专有 | `args`（**白名单键 + 黑名单键名双闸 + 脱敏 + 主目录折叠**；`items` 只记形状）/ `destructive?`（真删标记，见下表）/ `ok` / `error?` / `count?`（显式数字字段 `total_items`/`item_count`/`candidates_found`/`count`，**不猜数组**）/ `outKeys?` |
| `scan-shape` 专有 | `shape`（`rawKind`/`detailsKeys`/`detailsOk`/`detailsDropped`/`dropReasons`/`itemsKept`/`itemsUnknown`/`categoriesIsArray`/`categoriesCount`/`categoriesDirty`/`scanTimeSkipped`）+ `summary`（`total_items`/`categories`/`top_items`/`scan_time_ms`） |
| 丢弃依据枚举 | `detail-null` / `detail-not-object` / `items-missing` / `items-not-array`（与 `collectItems` 的接受条件逐条对应） |
| 隐私红线 | 凭据/口令/token 一字不落盘：`args` 与 `argv` 走 `redactText`（键值对/Bearer/`sk-`/`ghp_`/`AKIA`/≥32 位高熵串）+ 主目录折叠 `<home>`；**stdout 内容与 `items` 载荷内容从不落盘**（只记形状/长度/条数） |
| 观测不反噬（I8） | 全部 IO 失败吞错返回 `bool`，**调用方一律忽略返回值**；业务异常原样重抛（同一异常对象）；返回值原样透出 |
| 五问对照 | Q1 构建 → `build`；Q2 谁发起/打向谁 → `op`+`args`+`argv`+`pid`；Q3 断在哪一段 → `phase` 枚举 + `ok`/`error`/`parsed`/`degraded`；Q4 结果质量 → `count`/`outKeys`/`shape`/`summary`；Q5 耗时与预算 → `durationMs`（对 `boot.cfg.timeoutMs`） |

**真删标记判定表（`destructive`，与各工具真实删除语义逐条对应）**：

| 工具 | 判据 | 语义 |
|------|------|------|
| `clyan_clean` / `clyan_reclaim` | `args.dryRun === false` | 预览关闭（**保守判真删**，即使 CLI 会再问一次） |
| `clyan_smart_clear` | `args.dryRun === false && args.yes === true` | 与工具自身 `willExecute` 判据同源 |
| `clyan_auto_clear` | 恒 `true` | 零决策真删（argv 里根本没有 dry-run 开关） |
| 其余 12 个工具 | 恒 `false`（不写该字段） | 无删除语义 |

**一条命令验收**：
```
tail -n 5 "$DSH_HOME/clyan-trace.jsonl"     # 或 jq 过滤：jq -c 'select(.phase=="scan-shape")' …
grep -c '"destructive":true' "$DSH_HOME/clyan-trace.jsonl"    # 真删次数
```

## 5 · 边界与信任

- **能力边界 ≠ 沙箱（本文件最重要的一条）**：`clyan_clean`/`reclaim`/`smart_clear`/`auto_clear` 的工具描述写着「受保护路径强制拦截（fail-closed）」「语义裁决」，**但这些判定全部实现在 clyan CLI 内部**——本插件只做 argv 构造与结果整形，**自身不含任何路径白名单/黑名单逻辑**。（插件内唯一的实质性安全裁决是 `clyan_smart_clear` 的三重过滤：`recovery_cost==='none' && safety==='safe' && confidence>=0.9`。）
  → 推论：**插件的「安全」上限 = CLI 的安全实现**。CLI 被替换/降级（`clyanBin` 指向别的可执行文件）时，插件的安全声明**一起失效**，且插件不会察觉。
- 不越界清单：**业务上**不写文件（除委托 CLI 删除）、不做业务持久化（唯一落盘 = 观测侧车轨迹 §4.4，吞错且可关）、不自动创建定时任务（受 §2.4 约束）、不做恢复（恢复交 `clyan_undo`）、不评估「该不该清」（决策归爱丽丝）。
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
- **AGENTS.md §5.22（插件可维护性纪律）**：本插件的轨迹层即该条的落地——「机制必须自证」（侧车 JSONL 落盘）、「五问一条命令可答」（§4.4 五问对照表）、「观测绝不反噬」（I8）、「判据单一真源」（`resolveHome()` 单点 + 清洗账由测试锁定）。
- **组合变更纪律（§5.11）**：改源码 = 组合变更；改 `clyanBin/defaultPath/timeoutMs` = 配置变更（`plugin_configure`，自带预检 + 哨兵重启）。
- **生效判据（改代码后怎么证明真的生效）**：
  1. 进程级：`self-plugins/dsh-clyan/lib/index.js` mtime 必须早于 3080 监听进程启动时间。本轮实测：lib = `2026-09-06 17:38:04`，web（PID 7080）启动 = `2026-09-14 10:05:47` → **已生效**（本 S4 轨迹层部署后需按新 mtime 重测）。
  2. 环境级：`where clyan`（或 `clyan --version`）在 PATH 中可解析——**组合未钉路径，环境级是硬前提**；解析不到时全部工具返回 `无法启动 clyan：…`（明确报错，不静默）。
  3. 工具级：`clyan_pulse path=C:\` 返回含空闲空间的 `ok:true`（一次调用即判真假）。
  4. **轨迹级（2026-09-14 新增，最省事的一条）**：`tail -n 1 "$DSH_HOME/clyan-trace.jsonl"` 的 `build` 字段（`<version>@<lib/index.js mtime ms>`）与磁盘上 `lib/index.js` 的 mtime 一致 → 进程在跑这份构建；`boot` 行的 `tools.length=16` → 工具面完整。**宿主 logger 不落盘，故这是唯一可从外部证伪的版本判据。**
- **回退（出问题怎么退）**：
  1. **数据级回退（最优先）**：误删 → `clyan_history limit=…` 取操作 id → `clyan_undo id=<id>`（从回收站恢复）；恢复后 `clyan_verify id=<id>` 复核。
  2. 组合级：`plugin_stop dsh-clyan` / 删 patch 行 → 工具面消失（磁盘清理能力回到「手工 + 其它工具」状态）。
  3. 代码级：`git -C E:/alice/self-plugins/dsh-clyan log --oneline` → `git revert <sha>` → `pnpm build` → 预检 → 哨兵重启。
  4. 配置级：`clyanBin` 指向错误二进制 → 改回 `'clyan'`（PATH）或显式绝对路径，走 `plugin_configure`。

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（单测名/命令/日志行/HTTP） | 状态 |
|---|-----------|------------------------------|------|
| A1 | 工具面恰为 16 个（四层） | 会话工具列表 `clyan_` 前缀命中 16；源码 `reg(defineTool({` 计数 = 16（`tests/trace-wiring.test.mjs` A/H 双证） | 已实测（源码计数 + 端到端挂载） |
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
| A15 | 测试**不碰真实磁盘清理语义**（离线/隔离） | `tests/logic.test.mjs` / `tests/cli-contract.test.mjs` 只 import `../lib/logic.js` 纯函数；`tests/trace.test.mjs` 只写临时目录里的轨迹文件；`tests/trace-wiring.test.mjs` 用**临时 DSH_HOME + 临时 root + 假 ctx**，CLI 侧只用「不存在的二进制」或 exit-0 假样本（**绝不执行真实 clyan、绝不删除任何文件**）；96 例耗时 <1s | **已验收（代码审查 + 全绿，2026-09-14）** |
| A16 | **轨迹落盘且路径可预测**（S4 核心） | `tests/trace-wiring.test.mjs` A：`apply()` 后 `<临时 DSH_HOME>/clyan-trace.jsonl` 存在，首行 `phase='boot'`、`build` 匹配 `/^0\.1\.0@\d+$/`、`pid` 为真实 pid、`tools.length=16`、`tracePath` 以 `clyan-trace.jsonl` 结尾。**线上期望路径**：`E:\alice\.dsh\clyan-trace.jsonl`（部署后 `tail` 首行即验，标「待线上验收」） | **已验收（端到端，2026-09-14）** |
| A17 | **I7 摘要层账目可自证**：`shape.itemsKept` 恒等于 `summarizeScan().total_items`，脏条目逐条可归因 | `tests/trace.test.mjs` → 11 条 fixture 的镜像锁定用例（正常/空/null/字符串根/数组根/`details` 全脏/`details` 是数组/`categories` 非数组/嵌套脏 items）+ `dropReasons` 之和 = `detailsDropped`；端到端用例 D：上游给非 JSON → `scan-shape` 行 `rawKind='null'`/`itemsKept=0` | **已验收（单测 11 例 + 端到端）** |
| A18 | **I8 观测绝不反噬**：落盘失败不影响业务；业务异常原样重抛 | `tests/trace.test.mjs` 三条尸体测试（父路径是文件 → `false` 且不抛；不可写路径下返回值照常；抛出的异常**同一对象**重抛）+ 端到端 G（`DSH_HOME` 落在普通文件下 → `clyan_pulse` 照常返回业务错误、`clyan_space_deep` 照常成功） | **已验收（单测 + 端到端）** |
| A19 | **单点收口成立**：16 个工具全部经唯一入口 `reg` 注册；`summarizeScan` 只有一个调用点；`DSH_HOME` 解析只有一处；业务侧零落盘 IO；**包装零损耗** | `tests/trace-wiring.test.mjs` H 静态守卫 7 条断言（`ctx.tools.register(defineTool(` 计数 0、`reg(defineTool({` 计数 16、`summarizeScan(` 计数 1、`clyanTracePath(resolveHome())` 计数 1、业务侧 `'DSH_HOME'` 计数 0、`appendFileSync\|writeFileSync\|createWriteStream` 计数 0、`clyanTrace(` 计数 3）+ A 用例用**宿主自己的校验器**（`@deepseek-ai/dsh-tools` 的 `assertSupportedJsonSchema`/`assertObjectJsonSchema`）逐工具校验包装后的定义，且 `clyan_undo.parameters` 与 `parameterSchemaSpecToJsonSchema(同一份 spec)` 编译结果**逐位相等**（证明未二次编译 schema、`required` 未丢） | **已验收（静态守卫 + 宿主校验器）** |
| A20 | **隐私红线**：凭据/口令/token/用户名主目录/`items` 载荷内容一字不落盘 | `tests/trace.test.mjs` 隐私尸体测试（`password=`/`token=`/`AKIA…`/`ghp_…` + 主目录折叠 + `<payload: json[N]>`）+ **端到端 F**（在真实落盘路径上喂 `clyan_trust --reason 'password=…'` → 读回文件搜不到，且 `password=[redacted]`/`<home>` 在场 = 脱敏确实跑过）；A16 的 boot 行与 D 的上游行都不含 stdout 内容 | **已验收（单测 + 端到端）** |
| A21 | **真删留痕（U2 的落点）**：关闭预览的调用在轨迹里带 `destructive:true`，默认预览不带 | `tests/trace-wiring.test.mjs` E：`clyan_clean {}` → 无该字段；`clyan_clean {dryRun:false,yes:true}` → `destructive:true`；`tests/trace.test.mjs` 判定表 4 组（含 `clyan_auto_clear` 恒真、类型不符保守） | **已验收（单测 + 端到端）** |

## 8 · 与实现的关系

- 主实现：`self-plugins/dsh-clyan/src/index.ts`（唯一文件，891 行；无同语义副本）——**单文件承载 16 工具 + 3 个内部算法**（`summarizeScan` / `scanDeepTree`+`summarizeDeep` / `collectItems`），是生态中最大的单体插件源文件。
- 未实现/未验证部分**显式标注**：
  - **缺口① 头注释陈旧（已实测）**：`src/index.ts:7` 写「四层工具面（14 个）」，而实际注册 **16** 个（`clyan_space`、`clyan_space_deep` 未计入）。effect 日志（`:888`）写的是 16，二者自相矛盾。**以代码注册数为准（16）**。
  - **缺口② `clyanBin` 未在组合中钉住**：与 `dsh-anima-tags`（`tagsBin` 已钉绝对路径）形成反差；`clyan` 一旦离开 PATH，**16 个工具全部失效**（报错明确，但属可预防的环境耦合）。
  - **缺口③ 安全声明的归属未在代码中标注**：§5 那条「拦截在 CLI 内」的事实只能从 effect 日志文案推断，源码无注释说明 → 下一个读者极易误以为插件自带闸门。
  - **缺口④ 无单测 → 已闭环（2026-09-14 补课）**：新增 `tests/logic.test.mjs`（31 例）+ `tests/cli-contract.test.mjs`（13 例）+ `tests/trace.test.mjs`（43 例）+ `tests/trace-wiring.test.mjs`（9 例），`package.json` 暴露 `npm test`；纯逻辑同时从 `apply()` 闭包搬进 `src/logic.ts`（**行为不变，只有一处刻意的容错修正**，见 §9 与 A11）。仍未覆盖：`scanDeepTree` 真扫大目录的耗时行为（端到端 C 只用小样本目录）——**不做真实全盘扫描**是纪律，不是缺口。
  - **缺口⑤ 无侧车轨迹 → 已闭环（2026-09-14 S4 收尾）**：新增 `src/trace.ts` + `<DSH_HOME>/clyan-trace.jsonl`（§4.4），`boot`/`cli`/`call`/`scan-shape` 四阶段落盘；删除类操作的 argv 与真删标记从此可查（U2 关闭），摘要层的清洗账可自证（A17）。**未闭环的残余**见 §10 U6（上游给真 JSON 的线上场景无离线 e2e）。
  - **缺口⑥ 工具 execute 的接线层原先不可测 → 部分闭环**：新增 `tests/trace-wiring.test.mjs` 用「假 ctx + 临时 DSH_HOME + `lib/index.js`」真实挂载并调用 `execute`（A16–A21），接线错误从此有回归。仍待线上：真实 `clyan` 二进制的成功路径（U6）。
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

- **2026-09-14 补课（第三轮 · S4 收尾）：新增自证轨迹层（这是本插件最后一项可维护性缺口）**
  - **做了什么（只加观测，零业务改动）**：新增 `src/trace.ts`（纯函数 + 薄 IO：路径解析 / 脱敏 / 参数摘要 / 清洗账 / 行合成 / 单点包装器）。`src/index.ts` 的**唯一实质改动是三处单点收口**：① `reg` = 工具注册唯一入口（16 处 `ctx.tools.register(defineTool({` → `reg(defineTool({`，一个 `instrumentTool` 包装器覆盖整面，**不在 16 个 execute 里各改一遍**）；② `runCliRaw` → `runCli` 包装器（原函数体**逐行零漂移**，证据：`git show HEAD:src/index.ts` 提取的 `runCli` 体与现 `runCliRaw` 体**机制化 diff 完全一致，35 行**）；③ `summarizeTraced` = 摘要层唯一入口（`summarizeScan` 的两个调用点合流）。另加模块级 `BUILD` 常量 + `apply()` 末尾一行 `boot`。
  - **语义被补充（新增契约）**：§4.4「落盘轨迹契约」——路径 / 开关 / 行格式 / **四阶段枚举** / 各阶段字段 / 丢弃依据枚举 / 隐私红线 / 真删标记判定表 / 一条命令验收；I7（账目可自证）、I8（观测绝不反噬）；§2 术语三条（自证轨迹 / 阶段 / 清洗账 / 真删标记）。
  - **语义被修正**：**I5 原写「本插件零落盘」已不成立** → 改判「**业务**零落盘，唯一落盘 = 观测侧车（吞错、可关）」（§3 I5 保留删除线痕迹）；§4.3 调用点清单的「落盘产物：无」→ 改为轨迹落点 + **三项写入点**；§5 不越界清单同步收紧。
  - **新增测试 52 例**（43 `trace.test.mjs` + 9 `trace-wiring.test.mjs`），全套 **96/96 全绿**（连跑 5 轮一致）。其中 `trace-wiring.test.mjs` 是**接线级证据**：假 ctx + **临时 DSH_HOME** 真实 `apply()` `lib/index.js` 再调 `execute`——纯函数单测盖不到接线（本批次的实测教训），故必须有端到端。
  - **得到的可证伪证据**：A16（轨迹落盘 + 构建自报 + 工具面 16）/ A17（清洗账镜像锁定，11 条 fixture）/ A18（观测不反噬：落盘失败与异常重抛各 3 条尸体测试 + 端到端 G）/ A19（单点收口 7 条静态守卫）/ A20（隐私：两处尸体测试 + 端到端 F）/ A21（真删标记 4 组判定 + 端到端 E）。
  - **教训①（回写技能 `dsh-plugin-testability`）**：**「薄委托」断言要写意图而非逐位**——包装器的时间字段来自真实时钟，任何整对象比对都是定时炸弹；本套件改成「返回值深等 + 落盘行按字段断言」。
  - **教训②**：**单点收口的价值在「漏不掉」**——16 个 `execute` 手改是 16 个漏点；改成 `reg` 后，`tests/trace-wiring.test.mjs` H 用一条 `reg(defineTool({` 计数断言就能锁死「有没有工具绕过观测」。同一守卫还顺手锁死「`summarizeScan` 只有一个调用点」「`DSH_HOME` 解析只有一处」。
  - **教训③（测试分类）**：首跑 2 条红全是**我的预期写错**（`path.join` 会把 `/` 归一为 `\`；注入时钟只被调用两次）——**测试失败先分三类：代码错 / 预期错 / 环境错**，别默认代码错。

## 10 · 未决问题

- **U1 `clyanBin` 是否该在组合中钉绝对路径**：与 anima-tags 对齐（钉住）能消除 PATH 依赖，但会让「clyan 升级换目录」变成配置改动。倾向**钉住**（显式 > 隐式，AGENTS.md 包边界纪律）。需主人裁决。
- **U2 删除类操作的留痕 → 已由 S4 轨迹回答（2026-09-14）**：`<DSH_HOME>/clyan-trace.jsonl` 的 `cli` 行记 argv 摘要、`call` 行记 `destructive`（真删标记，§4.4 判定表），**即使 CLI 没起来也会留痕**（端到端 E 用的正是不存在的二进制）。残余口径差：轨迹记的是 `dryRun === false`（**预览关闭 = 可能真删**，保守），不是「CLI 真的删了 N 个文件」——后者只有 CLI 自己的 `history` 能回答（`clyan_history` 工具即入口）。**本项降级为「口径说明」，不再是缺口。**
- **U3 `clyan_report` 部分失败的可判读性**：`ok:true` 但 `disk`/`cleanable` 可能为 `null`，调用方不细看会误读。倾向：增加 `partial: true` + `failed_parts: [...]` 字段（§5.22「断在哪一段」）。**现状改善**：`report` 的每一次子调用现在都各留一行 `cli`（`pulse`/`scan quick`/`history`），**哪一半失败可从轨迹直接判读**——工具返回体仍缺字段，属待改造项。
- **U4 版本口径**：`package.json 0.1.0` / 源码注释 `v0.2`（文件头）/ effect 日志 `v0.4`——三处不一致。倾向：以 `package.json` 为唯一真源，头注释与日志改为注入版本常量。**现状**：轨迹 `build` 已按 `package.json` 口径落盘（`0.1.0@<mtime>`），**分歧本身因此可被轨迹暴露**（对比 `build` 与 effect 日志即见）。需实现者裁决。
- **U5 `clyan_space_deep` 与 CLI 的能力重叠**：CLI 已有 `scan disk`，插件又自建 DFS（因 CLI 只统计顶层）。长期看是「插件补 CLI 的缺」还是「该推 CLI 修」？倾向：先在 CLI 侧修，插件递归降级为可选——否则同一语义两份实现会漂移（I1 单一真源）。需裁决。
- **U6（新）上游给「可解析 JSON」的线上场景无离线 e2e**：本机没有能吐任意 JSON 的 `.exe` 假样本（探测过 23 个系统程序；`tree.com`/`cmd.exe` 只能给「exit 0 + 非 JSON 文本」）。因此端到端 D 覆盖的是**退化上游**（`parsed=null`），而「真 JSON → 有 items → 清洗账逐条归因」只有**纯函数套件（A17 的 11 条 fixture）**覆盖。**待线上验收**：部署后跑一次 `clyan_scan`，`jq -c 'select(.phase=="scan-shape")' "$DSH_HOME/clyan-trace.jsonl"` 应出现 `itemsKept>0` 且与同屏 `summary.total_items` 相等。**不静默**：本条留在未决清单，部署后第一次真实扫描即闭环。
- **U7（新）`degraded` 是启发式指纹**：`cli` 行的 `degraded` 用「trim 后是否以 `}`/`]` 结尾」判断 JSON 解析是否退化到正则兜底（O(1)，避免二次解析大 stdout）。理论上「尾部有垃圾但兜底截到内层块」这类样本可能误判。倾向：**保持启发式并显式标注**（它只用于分流排查，不作判据真源；真源是 `parsed` + `rawChars` + `stderrChars` 三件套）。需裁决是否值得为确定性付一次 `JSON.parse` 的成本。

**本轮（2026-09-14 S4 收尾）闭环情况**：闭环 **U2**（删除留痕，见上）与 §8 的 **缺口⑤ 无侧车轨迹**；新增 **U6/U7** 两条残余（上游真 JSON 的线上验收 + `degraded` 启发式），**U1/U3/U4/U5 仍未被本次工作回答**（组合配置 / 报告字段 / 版本口径 / 能力重叠——与「加观测层」无因果关系，**不做形式闭环**）。U3、U4 本轮**证据增强**（轨迹让 `report` 的半失败与版本分歧都变成可读数），已在条目内注明。
