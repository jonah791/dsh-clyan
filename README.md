<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 封装 clyan CLI（磁盘清理引擎）为 DSH 工具面：健康反射/扫描/空间分析/应用缓存/回收计划/清理/自动清理/历史/撤销/诊断/可信路径（16 工具）
  inject: 'tools'
  tools: clyan_pulse,clyan_scan,clyan_report,clyan_space,clyan_space_deep,clyan_app_cache,clyan_doctor,clyan_reclaim,clyan_clean,clyan_smart_clear,clyan_auto_clear,clyan_history,clyan_undo,clyan_verify,clyan_schedule,clyan_trust
  runtime: host-only
  envDeps: clyan CLI（Python 包，默认从 PATH 找 `clyan`）+ Windows 文件系统（AppData/回收站语义）
  boundary: 含**破坏性操作**（clyan_clean/clyan_auto_clear 真删文件）：默认 dry-run；安全闸门 fail-closed；删除属「须请示」类动作——工具给了能力，决策与授权仍归调用方
  compat: cordis ^4.0.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-clyan

<p align="center">
  <a href="https://github.com/jonah791/dsh-clyan"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-96%20(total%2C%2094%20pass%20on%20WSL)-brightgreen" alt="tests">
</p>

**一句话**：把 `clyan` 磁盘清理 CLI 包成 **16 个工具**——从「<1ms 的空闲空间反射」到「全盘递归查真凶」，再到「分阶段回收计划 + 带 fail-closed 闸门的清理执行」。

**为什么值得用**：磁盘问题的难点从来不是删不掉，而是**不敢删**。本插件把「看清（占了什么）+ 定性（能不能删）+ 留痕（删了什么、能不能撤回）」拆成可分开调用的步骤：先用 `clyan_report` / `clyan_space_deep` 决策，再用 `clyan_smart_clear` 预览，最后才 `clyan_clean` 落地，并且每一步都能用 `clyan_history` / `clyan_undo` 回溯。

> ⚠ **含破坏性操作**：`clyan_clean`（`autoSafe`/`deep+yes`）、`clyan_auto_clear` 会真删文件。默认一律 dry-run 预览；实际删除需显式参数。删除属「须请示」类动作——**授权与判断归人**。

## 能力

| 工具 | 用途 |
|------|------|
| `clyan_pulse` | 磁盘健康检查（<1ms 反射，零扫描零 IO）：返回空闲空间。`path` 缺省用配置默认盘 |
| `clyan_scan` | 扫描可清理项。默认返回聚合摘要（分类/安全分布/top 大项），`detail=true` 才返回全量 items——防撑爆上下文 |
| `clyan_report` | 磁盘全景报告：合成 pulse + 扫描聚合 + 历史近况 → 一次调用拿决策全貌 |
| `clyan_space` | 磁盘空间占用分析：总/已用/空闲/使用率 + top 大目录逐层展开 + gap 分析（未扫到部分） |
| `clyan_space_deep` | 深度空间扫描（内建递归）：一次 DFS 计算目录树真实大小，回答「磁盘被什么占满」的深层版——`clyan scan disk` 只统计顶层（如 Users 只报 13GB 实际 226GB）。全盘可能 2–3 分钟 |
| `clyan_app_cache` | 应用内部缓存扫描（通用）：递归找 `AppData\Local`+`Roaming`+`LocalLow` 下 cache/tmp/temp/log/old/backup/update/download 类子目录（>`minSizeMB`） |
| `clyan_doctor` | Clyan 系统诊断：模块可导入性/数据库/磁盘/providers/缓存一致性检查 |
| `clyan_reclaim` | 完整回收计划（=全量扫描→去重→按 `recovery_cost` 分阶段 `none/low/medium/high/unknown`）。默认聚合摘要；默认 dry-run |
| `clyan_clean` | 清理执行。安全闸门（**fail-closed**）：受保护路径 + 非缓存语义路径会被**强制拦截**（`blocked_items`），不再仅警告。默认 dry-run；实际删除需 `autoSafe=true`（仅 `confidence>=0.9` 且 `safety=safe`）或 `deep=true`+`yes=true` |
| `clyan_smart_clear` | 智能清理链：扫描 → 只挑 `recovery_cost=none` & `safety=safe` & `confidence>=0.9` 的安全项 → 返回建议集。执行仍默认预览 |
| `clyan_auto_clear` | 零决策自动清理：只删 `recovery_cost=none` 项（Temp/npx/缩略图/WER 等）。**实际执行会删文件——调用前确认** |
| `clyan_history` | 查看清理历史：最近操作列表，或按 id 查看单次详情 |
| `clyan_undo` | 撤销一次清理操作（从回收站恢复）。需要操作 ID（来自 history） |
| `clyan_verify` | 清理验证：无 id 时对比当前磁盘状态（pulse）与最近清理历史；有 id 时返回单次详情（含 before/after free） |
| `clyan_schedule` | 定时清理任务管理：`create`=创建每周定时清理，`remove`=移除，缺省=查看。**注意：自主性铁律下不自动创建定时删除**，此工具供主人安排时使用 |
| `clyan_trust` | 可信路径管理：`list`=查看，`add`=添加（跳过保护警告），`remove`=移除，`audit`=查看 trust 放行审计日志（记录时间/来源/原因，可追溯） |

## 快速开始

**1) 装依赖**：

```jsonc
"dsh-clyan": "link:<工作区>/self-plugins/dsh-clyan"
```

**2) 挂组合**（`clyanBin` 指向目标环境里的 CLI；`defaultPath` 是缺省盘）：

```yaml
- id: clyan
  name: dsh-clyan
  config:
    clyanBin: clyan
    defaultPath: 'C:\'
    timeoutMs: 180000
```

**3) 30 秒验证**（只读，零风险）：

```text
clyan_pulse {}                      → 期望返回空闲空间（<1ms 级别）
clyan_reclaim { detail: false }     → 期望返回分阶段聚合摘要 + recommendation，且默认 dry-run 不删任何东西
```

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| `clyanBin` | `clyan` | CLI 命令名或绝对路径（默认按 PATH 查找） |
| `timeoutMs` | `180000` | 单次调用超时（全盘深度扫描可能数分钟，故较宽） |
| `defaultPath` | `C:\` | 未显式传 `path` 时的默认盘 |

## 落盘与自证（出问题时先看这里）

每次调用落一行 JSONL 到 **`<DSH_HOME>/clyan-trace.jsonl`**（设 `DSH_CLYAN_TRACE=0` 可静默关闭）：

| 阶段 | 含义 |
|------|------|
| `boot` | 插件装载（含 `pid`、`build`、注册的**全部工具名列表**、配置快照） |
| `cli` | CLI 子进程调用（参数摘要经脱敏、退出码、stdout/stderr 量级） |
| `call` | 工具调用收口（工具名、耗时、结果规模） |
| `scan-shape` | 扫描结果形状（items 数、分类分布）——**只记形状不记路径正文** |

**一条命令答五问**：

```bash
tail -3 "$DSH_HOME/clyan-trace.jsonl"
# ① 跑的是哪个构建   → build = "<版本>@<模块 mtime ms>"；boot 行还有 pid 与工具清单
# ② 谁发起/调了什么   → phase + op（哪个 clyan_* 工具）+ 脱敏后的参数摘要
# ③ 断在哪一段       → phase 枚举（boot/cli/call/scan-shape）；cli 行的退出码/stderr 即失败点
# ④ 结果质量         → scan-shape 的 items 数与分类分布（形状对不上 = 解析或 CLI 版本问题）
# ⑤ 耗时与预算       → call/cli 行的 durationMs vs 配置 timeoutMs
```

写盘失败一律吞错返回 `false`，**绝不影响清理流程**。

## 生效判据与回退

**生效判据**（三选一，按可靠性排序）：
1. `tail -1 "$DSH_HOME/clyan-trace.jsonl"` 里 `build` 的 mtime **等于** `lib/index.js` 的 mtime ⇒ 进程在跑当前构建；
2. 生态级：`plugin_boot_status`（`dsh-plugin-bootreport`）返回 `liveNow` 含本插件 ⇒ 同上；
3. 行为级：`boot` 行里的 `tools` 列表包含 16 个 `clyan_*`，且 `clyan_pulse` 能返回空闲空间（**CLI 不可用时工具在但必失败**）。

> 注意：**重新构建 ≠ 生效**——产物 mtime 新只证明「构建过」，进程启动时间晚于产物 mtime 才算「在跑它」。

**回退**（三档）：
- 源码级：`git -C self-plugins/dsh-clyan revert <commit>` → 重新构建 → 预检 → 重启；
- 组合级：预设里给 `clyan` 行加 `disabled: true`（或移除该行）→ 哨兵重启；
- 运行期：误删走 `clyan_undo`（回收站恢复）；轨迹文件可随时删除。**本插件自身无持久业务状态**（状态都在 clyan 侧）。

## 测试

```bash
npm test        # = node --test "tests/*.test.mjs"
```

**96 例**（`tests/cli-contract.test.mjs` / `logic.test.mjs` / `trace.test.mjs` / `trace-wiring.test.mjs`），覆盖：CLI 契约（参数拼装与 JSON 解析）、聚合摘要与 `scan-shape` 形状计算、脱敏（白名单外的键一律不记、键序稳定）、轨迹容错与尸体测试、工具注册接线。

**本机实测（WSL 侧）**：`# pass 94 / # fail 2` —— 失败的两例是 `argDigest`/`argvDigest` 的**主目录折叠**断言（期望把 `C:\Users\<你>` 折叠为 `<home>`；在 Linux 主目录下不成立，故断言不过）。这是**测试的环境依赖**，不是运行期缺陷；未在 Windows 侧复跑，故不下「Windows 侧全绿」的结论。

**真实外部依赖**：跑通业务需要 `clyan` CLI（Python 包）与 Windows 文件系统语义（AppData/回收站）；测试不需要（子进程以桩替代）。

## 设计要点

- **fail-closed 安全闸门**：`clyan_clean` 对受保护路径 + 非缓存语义路径**强制拦截**（`blocked_items`），不是「警告后照删」——闸门失效时的默认方向是拒绝。
- **默认 dry-run**：所有清理类工具的默认行为是**预览**；真删需要显式参数（`autoSafe=true` 或 `deep=true`+`yes=true`）。一次误调用不会造成破坏。
- **摘要优先，`detail` 才全量**：`clyan_scan`/`clyan_reclaim` 默认返回聚合摘要——全量 items 可能上万条，先要形状再要明细，避免一次调用淹掉上下文。
- **`recovery_cost` 分级是分阶段清理的依据**：`none`（Temp/npx/缩略图/WER）可零决策清理；`low/medium/high/unknown` 必须人判断。
- **可信路径有审计**：`clyan_trust` 的放行记录时间/来源/原因——「放行」本身也要留痕，否则保护策略会被静默绕过。
- **自主性铁律落到工具层**：`clyan_schedule` **不自动创建**定时删除，只在主人安排时使用；删数据永远走显式授权。
- **观测单点落笔 + 只记形状**：所有工具经同一 CLI 入口与同一观测出口；轨迹记参数摘要与结果形状，**不记被扫路径正文**（磁盘路径常含用户名等隐私）。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语、概念模型与不变量、契约（含调用点清单）、边界与信任、可证伪验收清单、实践修订记录、未决问题 |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `workspace-file-governance` | 工作空间分层治理：先量后改、温度分层、可回滚操作（清理决策的上游方法论） |
| 技能 `plugin-maintainability` | 插件可维护性工程（自证轨迹 / 五问可取 / 观测不反噬） |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。
