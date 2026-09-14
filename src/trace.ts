/**
 * dsh-clyan 磁盘反射弧自证轨迹（可维护性 S4 证据层 · 2026-09-14 收尾批次）。
 *
 * 动机：本插件是**透传型**插件——16 个工具把 argv 交给外部 CLI `clyan`，再把它的 JSON 整形回
 * 上下文。这条链路的两处真相**在插件外完全不可见**（宿主 `ctx.logger` 不落盘，AGENTS.md §5.22 规则 1）：
 *   ① `summarizeScan` 曾对 CLI 脏数据不设防（`details.<cat> = null` → TypeError；
 *      `categories` 非数组 → `5.map is not a function`）——**上游给了什么形状、摘要层丢了什么**
 *      当时只能反解源码；修完之后同样只有「结果条数」，丢没丢、丢几条依旧看不见。
 *   ② 删除类操作的 argv **零留痕**（语义文档 §10 U2）——「这次是预览还是真删」事后只能靠 CLI 自己的
 *      `history` 反查，而 CLI 可能压根没跑起来（此时连反查都没有）。
 *
 * 修法：把每次调用的经过落成一行 JSONL 侧车——`<DSH_HOME>/clyan-trace.jsonl`。
 * 阶段枚举（`PHASES`）：
 *   `boot`（进程级构建自报）→ `cli`（每次子进程调用的**上游形状**）→ `call`（每次工具调用的入参/耗时/成败）
 *   → `scan-shape`（上游数据 → 摘要层的**清洗依据**）。
 *
 * 轨迹回答的五问：
 *   Q1 线上跑的是哪个构建 → `build`（`<version>@<lib/index.js mtime ms>`）
 *   Q2 谁发起 / 打向谁     → `op`（16 工具名之一 / `apply` / `runCli` / `summarizeScan`）
 *                          + `args`（白名单键 + 脱敏 + 主目录折叠）+ `argv`（同款脱敏）
 *   Q3 断在哪一段         → `phase` 枚举 + `ok`/`error`/`parsed`/`degraded`（JSON 退化到正则兜底）
 *   Q4 结果质量           → `count`/`outKeys`（工具层）+ `summary`/`shape`（摘要层：**丢了几条、依据什么**）
 *   Q5 耗时与预算         → `durationMs`（配合 boot 行的 `cfg.timeoutMs` 判超时占比）
 *
 * 隐私红线：`args` 走**白名单 + 黑名单双闸** + `redactText`；自由文本（如 `reason`）同样过脱敏；
 * `items`（JSON 载荷，内含文件路径）**只记形状与条数，不记内容**；路径类值折叠主目录前缀为 `<home>`。
 * 凭据/口令/token 一字不落盘（`tests/trace.test.mjs` 有隐私尸体测试，`tests/trace-wiring.test.mjs`
 * 在**真实落盘路径**上再证一次）。
 *
 * 观测绝不反噬主流程（§5.22 规则 3）：全部 IO 失败吞错并返回 `false`，**调用方一律忽略返回值**；
 * 业务异常由 `wrapToolExecute` **原样重抛**（类型与文案不变）。
 *
 * @module dsh-clyan/trace
 */
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { asArray } from './logic.js'

/** 阶段枚举：一次进程从 `boot` 起，每次子进程/工具调用各落一行，摘要层落 `scan-shape`。 */
export type ClyanTracePhase = 'boot' | 'cli' | 'call' | 'scan-shape'

/** 阶段枚举的运行时可见清单（文档 §4 与测试共用的单一真源）。 */
export const PHASES: readonly ClyanTracePhase[] = ['boot', 'cli', 'call', 'scan-shape']

/** 脱敏占位符（测试与文档共用，避免判据漂移）。 */
export const REDACTED = '<redacted>'

/** 用户主目录前缀的折叠占位符。 */
export const HOME_TOKEN = '<home>'

/**
 * 上游数据 → 摘要层的清洗账（Q4 的「丢了几条、依据什么」）。
 *
 * 逐条镜像 `summarizeScan`/`collectItems`/`sumScanTimeMs` 的容忍规则
 * （`src/logic.ts`）：**与 `summarizeScan().total_items` 的等值由测试锁定**
 * （判据单一真源不靠「两处代码长得像」，靠一条可证伪的断言）。
 */
export interface ScanShape {
  /** 上游根值的 JSON 形态（`object`/`array`/`null`/`string`/`number`/`boolean`/`undefined`）。 */
  rawKind: string
  /** `details` 是否为容器（**数组也算**——摘要层用的是 `Object.entries(details)`）。 */
  detailsIsObject: boolean
  /** `details` 的键数（= 摘要层实际遍历的条目数）。 */
  detailsKeys: number
  /** 被摘要层接受为「可用」的条目数（`Array.isArray(det.items)` 成立）。 */
  detailsOk: number
  /** 被判为脏、因而**丢掉的条目数**（= `detailsKeys − detailsOk`，逐条可归因）。 */
  detailsDropped: number
  /** 丢弃依据分布（可 grep：`detail-null`/`detail-not-object`/`items-missing`/`items-not-array`）。 */
  dropReasons: Record<string, number>
  /** 进入摘要的 item 条数（**锁定等于 `summarizeScan().total_items`**）。 */
  itemsKept: number
  /** items 形状不可用的条目数——「丢了几条」**不可知**（不是 0，是不知道）。 */
  itemsUnknown: number
  /** `categories` 是否为数组（非数组 → 摘要里的分类列表整体退化为空）。 */
  categoriesIsArray: boolean
  /** `categories` 元素数（非数组记 0）。 */
  categoriesCount: number
  /** `categories` 里的脏元素数（非对象 → `c.category` 取不到）。 */
  categoriesDirty: number
  /** `sumScanTimeMs` 静默跳过的 `null`/`undefined` details 条目数（耗时统计的缺口）。 */
  scanTimeSkipped: number
}

/** 摘要层产出（Q4 的「结果质量」——与 `summarizeScan` 的返回字段同名同义）。 */
export interface SummaryShape {
  /** 进入摘要的 item 总数。 */
  total_items: number
  /** 整形后的分类条数。 */
  categories: number
  /** 摘要里 top 项条数。 */
  top_items: number
  /** 各分类 `scan_time_ms` 之和。 */
  scan_time_ms: number
}

/** boot 行自报的运行面（Q1/Q5 的判据背景）。 */
export interface TraceConfig {
  /** 生效的 CLI 二进制（config.clyanBin；路径折叠主目录）。 */
  clyanBin: string
  /** 生效的子进程超时（ms）——判「耗时是否逼近预算」的分母。 */
  timeoutMs: number
  /** 生效的默认扫描盘（config.defaultPath；折叠主目录）。 */
  defaultPath: string
  /** 注册的工具名清单（工具面自报：判「线上挂的是哪几个」）。 */
  tools: string[]
}

/** 一行 clyan 轨迹。字段按阶段取用，未用的省略（`serializeTraceEntry` 固定键序）。 */
export interface ClyanTraceEntry {
  /** 写入时刻（ms epoch）。 */
  atMs: number
  phase: ClyanTracePhase
  /** 构建标识 `<version>@<lib/index.js mtime ms>`（Q1）。 */
  build: string
  /** 进程 pid。 */
  pid: number
  /** 发生者：工具名 / `apply` / `runCli` / `summarizeScan`（Q2）。 */
  op: string
  /** 工具入参摘要（白名单键 + 脱敏 + 截断；Q2）。 */
  args?: string
  /** 本次调用是否**关闭了预览**（= 可能真删；`auto_clear` 恒为真）——U2 的落点。 */
  destructive?: boolean
  /** CLI 子命令（argv[0]；Q2）。 */
  verb?: string
  /** CLI argv 摘要（脱敏；`--items` 载荷折叠为形状，Q2）。 */
  argv?: string
  /** argv 元素数（判「有没有悄悄多带标志」）。 */
  argvLen?: number
  /** CLI 结果成败（`code === 0 || 解析出 JSON`）。 */
  exitOk?: boolean
  /** stdout 字符数（上游给了多少；Q3/Q4）。 */
  rawChars?: number
  /** 解析结果形态（`object`/`array`/`null`；Q3）。 */
  parsed?: string
  /** 是否只能来自正则兜底截取（JSON 退化的指纹；Q3）。 */
  degraded?: boolean
  /** stderr 字符数（失败时的第一手线索）。 */
  stderrChars?: number
  /** 阶段耗时（ms；`boot` = 0）。 */
  durationMs: number
  /** 工具返回值是否判为成功（`ok===false` 或有非空 `error` → false）。 */
  ok?: boolean
  /** 失败原因（脱敏 + 截断 400）。 */
  error?: string
  /** 结果条数（显式数字字段：`total_items`/`item_count`/`candidates_found`/`count`）。 */
  count?: number
  /** 工具返回体 `result` 的顶层键（逗号分隔，最多 12 个）。 */
  outKeys?: string
  /** 摘要层清洗账（仅 `scan-shape`）。 */
  shape?: ScanShape
  /** 摘要层产出（仅 `scan-shape`）。 */
  summary?: SummaryShape
  /** 工具面清单（仅 `boot`）。 */
  tools?: string[]
  /** 生效配置（仅 `boot`）。 */
  cfg?: TraceConfig
  /** 轨迹文件自身路径（仅 `boot`；折叠主目录，便于回答「证据落在哪」）。 */
  tracePath?: string
}

// ══════════════ 路径与构建自证（薄 IO） ══════════════

/** 解析 DSH_HOME：环境变量优先，缺省 `<homedir>/.dsh`（**单一真源**——不要在多处各写一份）。 */
export function resolveHome(
  env: Record<string, string | undefined> = process.env,
  fallback = homedir(),
): string {
  const raw = env['DSH_HOME']
  return raw !== undefined && raw.trim() !== '' ? raw : join(fallback, '.dsh')
}

/** 轨迹文件路径（纯函数；锚定 `<DSH_HOME>/clyan-trace.jsonl`）。 */
export function clyanTracePath(home: string): string {
  return join(home, 'clyan-trace.jsonl')
}

/** 文件 mtime（ms；不可得为 0）。 */
export function mtimeOf(file: string): number {
  try {
    return Math.round(statSync(file).mtimeMs)
  } catch {
    return 0
  }
}

/** 从 `<file>` 所在包的 package.json 读版本（读不到返回空串——尽力而为，不抛）。 */
export function readPackageVersion(file: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(file), '..', 'package.json'), 'utf8')) as {
      version?: string
    }
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
}

/** 构建标识 `<version>@<模块 mtime ms>`（版本缺失退化为 `unknown@<mtime>`）。 */
export function buildStamp(file: string, version = ''): string {
  return version !== '' ? `${version}@${String(mtimeOf(file))}` : `unknown@${String(mtimeOf(file))}`
}

/** 是否启用轨迹（`DSH_CLYAN_TRACE=0` 关闭；缺省开启——证据层是默认行为，不是可选项）。 */
export function traceEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env['DSH_CLYAN_TRACE'] !== '0'
}

// ══════════════ 脱敏（隐私红线） ══════════════

/** 文本截断（摘要用；超长补省略号）。 */
export function truncate(text: string, max = 200): string {
  return text.length <= max ? text : text.slice(0, max) + '…'
}

/**
 * 凭据脱敏（纯函数）：值层面按形状擦除。
 * 覆盖：显式键值对、`Bearer`、厂商前缀（`sk-`/`ghp_`/`github_pat_`/`AKIA`）、≥32 位高熵串。
 */
export function redactText(text: string): string {
  return text
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(?<![A-Za-z0-9])(api[_-]?key|token|secret|password|passwd|passphrase|authorization)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, '[redacted]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}/g, '[redacted]')
    .replace(/\bAKIA[0-9A-Z]{12,}/g, '[redacted]')
    .replace(/[A-Za-z0-9+/=_-]{32,}/g, '[redacted]')
}

/** 主目录三形态（Windows / POSIX / WSL `/mnt/<drive>`；长的优先替换）。 */
export function homePathVariants(home: string): string[] {
  const trimmed = home.replace(/[\\/]+$/, '')
  if (trimmed === '') return []
  const variants = new Set<string>([trimmed, trimmed.replace(/\\/g, '/')])
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(trimmed)
  if (drive !== null) {
    variants.add(`/mnt/${(drive[1] ?? '').toLowerCase()}/${(drive[2] ?? '').replace(/\\/g, '/')}`)
  }
  return [...variants].filter((v) => v !== '').sort((a, b) => b.length - a.length)
}

/** 折叠用户主目录前缀为 `<home>`（用户名不落盘）。 */
export function redactHome(text: string, home = homedir()): string {
  let out = text
  for (const variant of homePathVariants(home)) out = out.split(variant).join(HOME_TOKEN)
  return out
}

/** 参数摘要白名单：**只有这些键**才会进轨迹（其余一律不记，无需判断是否敏感）。 */
export const ARG_KEYS: readonly string[] = [
  'path', 'mode', 'phase', 'detail', 'topN', 'items', 'dryRun', 'autoSafe', 'deep',
  'strategy', 'minConfidence', 'yes', 'safety', 'id', 'limit', 'action', 'time',
  'reason', 'targetGb', 'maxDepth', 'dirThresholdMB', 'fileThresholdMB', 'minSizeMB',
]

/** 凭据键名黑名单：命中即**整键丢弃**（连长度都不记）——与白名单是双保险。 */
export const SECRET_KEY_RE = /pass|pwd|secret|token|key|cookie|auth|credential|session|nonce|signature/i

/** 单值 → 摘要片段（数组按 `|` 连；对象记类型占位，不递归展开）。 */
export function valueDigest(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'object' && v !== null ? '{…}' : String(v))).join('|')
  }
  if (value === null) return 'null'
  if (typeof value === 'object') return '{…}'
  return String(value)
}

/**
 * JSON 载荷的**形状**摘要（不记内容）：`<payload: json[3]>` / `<payload: 128 chars>`。
 * `items` 是「文件路径数组」的 JSON 文本——路径本身可诊断，但载荷也可能很大，
 * 且语义上属于调用方的自由数据，故只落形状与条数。
 */
export function payloadFold(value: unknown): string {
  const text = typeof value === 'string' ? value : ''
  if (text === '') return '<payload: empty>'
  try {
    const parsed: unknown = JSON.parse(text)
    if (Array.isArray(parsed)) return `<payload: json[${String(parsed.length)}]>`
    return `<payload: json:${typeof parsed}>`
  } catch {
    return `<payload: ${String(text.length)} chars>`
  }
}

/** 单个参数 → `key=value` 片段（黑名单整键丢弃；items 折叠为形状；其余脱敏 + 折叠主目录）。 */
export function argDigest(key: string, value: unknown, home = homedir()): string | null {
  if (SECRET_KEY_RE.test(key)) return null
  if (value === undefined) return null
  if (key === 'items') return `${key}=${payloadFold(value)}`
  return `${key}=${truncate(redactHome(redactText(valueDigest(value)), home), 120)}`
}

/**
 * 工具入参摘要（Q2 的输入侧）：白名单键 + 黑名单键名双闸 + 值脱敏 + 折叠主目录 + 总量截断 300。
 * 键序按白名单序（稳定，便于 diff 轨迹行）。
 */
export function argsDigest(args: unknown, home = homedir(), maxLen = 300): string {
  if (args === null || typeof args !== 'object') return ''
  const src = args as Record<string, unknown>
  const parts: string[] = []
  for (const key of ARG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue
    const piece = argDigest(key, src[key], home)
    if (piece !== null) parts.push(piece)
  }
  return truncate(parts.join('; '), maxLen)
}

/**
 * CLI argv 摘要（Q2）：逐个元素脱敏 + 折叠主目录；`--items` 的值折叠为载荷形状（不记内容）。
 */
export function argvDigest(argv: readonly string[], home = homedir(), maxLen = 300): string {
  const parts: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i] ?? ''
    if (item === '--items') {
      parts.push(item)
      const value = argv[i + 1]
      if (value !== undefined) {
        parts.push(payloadFold(value))
        i++
      }
      continue
    }
    parts.push(truncate(redactHome(redactText(item), home), 120))
  }
  return truncate(parts.join(' '), maxLen)
}

// ══════════════ 判定（纯函数） ══════════════

/** JSON 值的形态名（脏数据不抛）。 */
export function kindOf(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * 「本次调用是否关闭了预览」——**与各工具真实的删除语义逐条对应**（U2 的落点）：
 * `clyan_clean`/`clyan_reclaim`：`dryRun !== false` ⇒ 带 `--dry-run`（预览）；`dryRun === false` ⇒ 预览关闭（**保守判真删**，
 * 即使 CLI 会再问一次）；`clyan_smart_clear`：只有 `dryRun === false && yes === true` 才真调 `clean --items --yes`；
 * `clyan_auto_clear`：**零决策恒真删**（argv 里根本没有 dry-run 开关）。其余工具无删除语义 → `false`。
 */
export function isDestructiveCall(op: string, args: unknown): boolean {
  const a = (args !== null && typeof args === 'object' ? args : {}) as Record<string, unknown>
  switch (op) {
    case 'clyan_clean':
    case 'clyan_reclaim':
      return a['dryRun'] === false
    case 'clyan_smart_clear':
      return a['dryRun'] === false && a['yes'] === true
    case 'clyan_auto_clear':
      return true
    default:
      return false
  }
}

/** 结果条数（Q4）：只认**显式数字字段**——不猜数组（search-pro 的教训：元数据数组会被误报成结果数）。 */
export const COUNT_FIELDS: readonly string[] = ['total_items', 'item_count', 'candidates_found', 'count']

/** 从工具返回值里取「结果条数」（脏数据 → undefined，不抛）。 */
export function countOf(result: unknown): number | undefined {
  if (result === null || typeof result !== 'object') {
    return Array.isArray(result) ? result.length : undefined
  }
  const r = result as Record<string, unknown>
  const inner = r['result']
  for (const holder of [inner, r]) {
    if (holder === null || typeof holder !== 'object') continue
    for (const field of COUNT_FIELDS) {
      const value = (holder as Record<string, unknown>)[field]
      if (typeof value === 'number' && Number.isFinite(value)) return value
    }
  }
  return undefined
}

/** 结果体顶层键（最多 12 个，逗号分隔；`result` 优先）——回答「这次返回的是哪种整形」。 */
export function outKeysOf(result: unknown, max = 12): string {
  if (result === null || typeof result !== 'object') return ''
  const r = result as Record<string, unknown>
  const inner = r['result']
  const holder = inner !== null && typeof inner === 'object' && !Array.isArray(inner)
    ? (inner as Record<string, unknown>)
    : r
  return Object.keys(holder).slice(0, max).join(',')
}

/** 成败判定（Q3）：`ok === false` 或非空 `error` → 失败；其余成功。 */
export function resultOk(result: unknown): boolean {
  if (result === null || typeof result !== 'object') return false
  const r = result as Record<string, unknown>
  if (r['ok'] === false) return false
  if (typeof r['error'] === 'string' && r['error'] !== '') return false
  return true
}

/** 失败文案提取（脱敏 + 截断 400）。 */
export function errorOf(result: unknown, thrown?: unknown): string | undefined {
  if (thrown !== null && thrown !== undefined) {
    const msg = thrown instanceof Error ? thrown.message : String(thrown)
    return redactText(truncate('抛错: ' + msg, 400))
  }
  if (result === null || typeof result !== 'object') return undefined
  const error = (result as Record<string, unknown>)['error']
  if (typeof error !== 'string' || error === '') return undefined
  return redactText(truncate(error, 400))
}

/**
 * JSON 解析是否退化到正则兜底（Q3 的断点指纹，**启发式**，非判据真源）：
 * 完整解析成功的对象/数组，trim 后必然以 `}` / `]` 结尾；否则 `data !== null` 只能来自兜底截取。
 */
export function degradedParse(raw: string, data: unknown): boolean {
  if (data === null || data === undefined) return false
  const t = raw.trim()
  if (t === '') return true
  return !(t.endsWith('}') || t.endsWith(']'))
}

// ══════════════ 摘要层清洗账（镜像 summarizeScan 的容忍规则） ══════════════

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1
}

/**
 * 上游扫描数据 → 清洗账（纯函数，**永不抛**）。
 *
 * 镜像对象是 `src/logic.ts` 的三个函数：`collectItems`（哪些 details 条目被接受）、
 * `summarizeScan`（`categories` 的数组归一）、`sumScanTimeMs`（哪些条目被静默跳过）。
 * 语义与它们**逐条对应**，并由 `tests/trace.test.mjs` 的等值断言锁定
 * （`shape.itemsKept === summarizeScan(raw, N).total_items`）——镜像一旦漂移，测试立刻红。
 */
export function analyzeScanShape(raw: unknown): ScanShape {
  const scan = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined
  const detailsRaw = scan === undefined ? undefined : scan['details']
  const detailsIsObject = detailsRaw !== null && typeof detailsRaw === 'object'
  const entries: [string, unknown][] = detailsIsObject ? Object.entries(detailsRaw as object) : []

  const dropReasons: Record<string, number> = {}
  let detailsOk = 0
  let itemsKept = 0
  let scanTimeSkipped = 0
  for (const [, det] of entries) {
    if (det === null || det === undefined) {
      bump(dropReasons, 'detail-null')
      scanTimeSkipped++
      continue
    }
    if (typeof det !== 'object') {
      bump(dropReasons, 'detail-not-object')
      continue
    }
    const items = (det as Record<string, unknown>)['items']
    if (items === undefined) {
      bump(dropReasons, 'items-missing')
      continue
    }
    if (!Array.isArray(items)) {
      bump(dropReasons, 'items-not-array')
      continue
    }
    detailsOk++
    itemsKept += items.length
  }

  const categoriesRaw = scan === undefined ? undefined : scan['categories']
  const categoriesIsArray = Array.isArray(categoriesRaw)
  const categories = asArray<unknown>(categoriesRaw)
  const categoriesDirty = categories.filter((c) => c === null || typeof c !== 'object').length

  return {
    rawKind: kindOf(raw),
    detailsIsObject,
    detailsKeys: entries.length,
    detailsOk,
    detailsDropped: entries.length - detailsOk,
    dropReasons,
    itemsKept,
    itemsUnknown: entries.length - detailsOk,
    categoriesIsArray,
    categoriesCount: categories.length,
    categoriesDirty,
    scanTimeSkipped,
  }
}

/** 从 `summarizeScan` 的产出里取 Q4 读数（脏数据 → 0，不抛）。 */
export function summaryShapeOf(summary: unknown): SummaryShape {
  const s = (summary !== null && typeof summary === 'object' ? summary : {}) as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    total_items: num(s['total_items']),
    categories: asArray<unknown>(s['categories']).length,
    top_items: asArray<unknown>(s['top_items']).length,
    scan_time_ms: num(s['scan_time_ms']),
  }
}

// ══════════════ 轨迹行合成（实现与测试共用的单一真源） ══════════════

/** `composeCallEntry` 的入参（执行体只提供 `op`/`args`/返回值，其余由包装器提供）。 */
export interface CallComposeInput {
  now: number
  build: string
  op: string
  args: unknown
  durationMs: number
  result?: unknown
  thrown?: unknown
  home?: string
  pid?: number
}

/** 工具调用行合成（Q2/Q3/Q4/Q5）——隐私保证在此成立：`args` 走 `argsDigest`，`error` 走 `errorOf`。 */
export function composeCallEntry(input: CallComposeInput): ClyanTraceEntry {
  const thrown = input.thrown === null || input.thrown === undefined ? undefined : input.thrown
  const error = errorOf(input.result, thrown)
  const count = thrown === undefined ? countOf(input.result) : undefined
  const keys = thrown === undefined ? outKeysOf(input.result) : ''
  return {
    atMs: input.now,
    phase: 'call',
    build: input.build,
    pid: input.pid ?? process.pid,
    op: input.op,
    args: argsDigest(input.args, input.home ?? homedir()),
    ...(isDestructiveCall(input.op, input.args) ? { destructive: true } : {}),
    durationMs: input.durationMs,
    ok: thrown === undefined && resultOk(input.result),
    ...(error !== undefined ? { error } : {}),
    ...(count !== undefined ? { count } : {}),
    ...(keys !== '' ? { outKeys: keys } : {}),
  }
}

/** `composeCliEntry` 的入参（上游形状，Q3）。 */
export interface CliComposeInput {
  now: number
  build: string
  argv: readonly string[]
  durationMs: number
  result: { ok: boolean; data: unknown; raw: string; stderr: string }
  home?: string
  pid?: number
}

/** CLI 调用行合成（Q2/Q3/Q5）：记**上游形状**，不记 stdout 内容。 */
export function composeCliEntry(input: CliComposeInput): ClyanTraceEntry {
  const { result } = input
  return {
    atMs: input.now,
    phase: 'cli',
    build: input.build,
    pid: input.pid ?? process.pid,
    op: 'runCli',
    verb: input.argv[0] ?? '',
    argv: argvDigest(input.argv, input.home ?? homedir()),
    argvLen: input.argv.length,
    exitOk: result.ok,
    rawChars: result.raw.length,
    parsed: kindOf(result.data),
    degraded: degradedParse(result.raw, result.data),
    stderrChars: result.stderr.length,
    durationMs: input.durationMs,
    ...(result.stderr !== '' ? { error: redactText(truncate(result.stderr, 400)) } : {}),
  }
}

/** `composeScanShapeEntry` 的入参（上游 → 摘要层的清洗账，Q4）。 */
export interface ScanShapeComposeInput {
  now: number
  build: string
  op: string
  raw: unknown
  summary: unknown
  durationMs: number
  pid?: number
}

/** 摘要层清洗行合成（Q4 的「丢了几条、依据什么」）。 */
export function composeScanShapeEntry(input: ScanShapeComposeInput): ClyanTraceEntry {
  return {
    atMs: input.now,
    phase: 'scan-shape',
    build: input.build,
    pid: input.pid ?? process.pid,
    op: input.op,
    shape: analyzeScanShape(input.raw),
    summary: summaryShapeOf(input.summary),
    durationMs: input.durationMs,
  }
}

/** boot 行合成（Q1 + 配置背景）。 */
export function composeBootEntry(input: {
  now: number
  build: string
  path: string
  cfg: { clyanBin: string; timeoutMs: number; defaultPath: string; tools: readonly string[] }
  home?: string
  pid?: number
}): ClyanTraceEntry {
  const home = input.home ?? homedir()
  return {
    atMs: input.now,
    phase: 'boot',
    build: input.build,
    pid: input.pid ?? process.pid,
    op: 'apply',
    durationMs: 0,
    tools: [...input.cfg.tools],
    cfg: {
      clyanBin: truncate(redactHome(redactText(input.cfg.clyanBin), home), 160),
      timeoutMs: input.cfg.timeoutMs,
      defaultPath: truncate(redactHome(redactText(input.cfg.defaultPath), home), 160),
      tools: [...input.cfg.tools],
    },
    tracePath: truncate(redactHome(input.path, home), 240),
  }
}

// ══════════════ 序列化 / 解析 / 落盘（薄 IO） ══════════════

/** 稳定序列化（键序固定 + 单行 JSON，便于 `tail`/`grep`）。 */
export function serializeTraceEntry(entry: ClyanTraceEntry): string {
  const ordered: Record<string, unknown> = {
    atMs: entry.atMs,
    phase: entry.phase,
    build: entry.build,
    pid: entry.pid,
    op: entry.op,
  }
  const optional: readonly (keyof ClyanTraceEntry)[] = [
    'args', 'destructive', 'verb', 'argv', 'argvLen', 'exitOk', 'rawChars', 'parsed',
    'degraded', 'stderrChars', 'durationMs', 'ok', 'error', 'count', 'outKeys',
    'shape', 'summary', 'tools', 'cfg', 'tracePath',
  ]
  for (const key of optional) {
    if (entry[key] !== undefined) ordered[key] = entry[key]
  }
  return JSON.stringify(ordered)
}

/** 容错解析：坏行/半行/空行跳过，不抛（轨迹是证据，不是契约校验器）。 */
export function parseTraceEntries(text: string): ClyanTraceEntry[] {
  const out: ClyanTraceEntry[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    try {
      const parsed = JSON.parse(line) as ClyanTraceEntry
      if (typeof parsed.atMs === 'number' && typeof parsed.phase === 'string') out.push(parsed)
    } catch {
      continue
    }
  }
  return out
}

/** 读轨迹文件；缺失/不可读返回空数组（诊断的安全入口）。 */
export function readTraceEntries(path: string): ClyanTraceEntry[] {
  try {
    return parseTraceEntries(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
}

/** 追加一行（失败即吞并返回 `false`：轨迹是观测，绝不因写不进去而影响清理动作）。 */
export function appendTraceEntry(path: string, entry: ClyanTraceEntry): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, serializeTraceEntry(entry) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

/** 记一笔 clyan 轨迹（薄接线：路径缺省 `<DSH_HOME>/clyan-trace.jsonl`；`DSH_CLYAN_TRACE=0` 时静默不写）。 */
export function clyanTrace(
  entry: Omit<ClyanTraceEntry, 'atMs' | 'pid' | 'build'> & Partial<Pick<ClyanTraceEntry, 'atMs' | 'pid' | 'build'>>,
  opts: { path?: string; home?: string; now?: number; pid?: number; build?: string; enabled?: boolean } = {},
): boolean {
  if (!(opts.enabled ?? traceEnabled())) return false
  const path = opts.path ?? clyanTracePath(opts.home ?? resolveHome())
  return appendTraceEntry(path, {
    ...entry,
    atMs: opts.now ?? entry.atMs ?? Date.now(),
    pid: opts.pid ?? entry.pid ?? process.pid,
    build: opts.build ?? entry.build ?? 'unknown@0',
  })
}

// ══════════════ 单点收口：工具执行包装器 ══════════════

/**
 * 把任一工具的 `execute` 包成「先跑原实现，后落一行 `call`」。
 *
 * 契约（**零业务影响**）：
 * - 返回值**原样透出**（`output.schema` 为 `additionalProperties: false`，绝不混入新字段）；
 * - 业务异常**原样重抛**（不换类型、不改文案——观测层不得成为新的失败源）；
 * - 落盘失败只吞（`clyanTrace` 返回 `false`，此处**忽略返回值**）。
 *
 * @param op 工具名（轨迹的 `op` 字段）
 * @param inner 原始 `execute`（已绑定自身）
 * @param opts 轨迹落点（测试注入 `path`/`now`）
 * @returns 包装后的 `execute`
 */
export function wrapToolExecute(
  op: string,
  inner: ((...args: any[]) => any) | undefined,
  opts: { path?: string; home?: string; build?: string; pid?: number; now?: () => number; enabled?: boolean } = {},
): (...args: any[]) => Promise<any> {
  const now = opts.now ?? ((): number => Date.now())
  return async (...callArgs: any[]): Promise<any> => {
    const startedAtMs = now()
    let result: any
    let thrown: unknown
    try {
      result = inner ? await inner(...callArgs) : undefined
    } catch (err) {
      thrown = err
    }
    clyanTrace(composeCallEntry({
      now: startedAtMs,
      build: opts.build ?? 'unknown@0',
      op,
      args: callArgs[0],
      durationMs: now() - startedAtMs,
      result,
      thrown,
      ...(opts.home !== undefined ? { home: opts.home } : {}),
      ...(opts.pid !== undefined ? { pid: opts.pid } : {}),
    }), {
      ...(opts.path !== undefined ? { path: opts.path } : {}),
      ...(opts.enabled !== undefined ? { enabled: opts.enabled } : {}),
      now: startedAtMs,
      ...(opts.build !== undefined ? { build: opts.build } : {}),
      ...(opts.pid !== undefined ? { pid: opts.pid } : {}),
    })
    if (thrown !== undefined) throw thrown
    return result
  }
}

/**
 * 把「定义好的工具对象」换成注册用的包装体（`reg` 的唯一实现）。
 * **只替换 `execute`**，其余字段（`name`/`description`/`parameters`/`output`/`timeoutMs`）原样透传——
 * 结构化对象即可注册（宿主 `register()` 只读 `name`/`output`/`timeoutMs`/`execute`），
 * 因此**不二次调用 `defineTool`**（避免参数 schema 二次编译的任何损失，见 `clyan_undo.id` 的 `required`）。
 */
export function instrumentTool<T extends { name?: string; execute?: (...args: any[]) => any }>(
  tool: T,
  opts: { path?: string; home?: string; build?: string; pid?: number; now?: () => number; enabled?: boolean } = {},
): T {
  const op = String(tool?.name ?? 'unknown')
  const inner = typeof tool?.execute === 'function' ? tool.execute.bind(tool) : undefined
  return { ...tool, execute: wrapToolExecute(op, inner, opts) }
}
