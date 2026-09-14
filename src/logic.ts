/**
 * dsh-clyan · 纯逻辑层（无 IO / 无 ctx / 无时钟 / 无副作用）
 *
 * 本文件是 `src/index.ts` 的「可测化搬家」产物：把 argv 构造、CLI 结果解析与容错、
 * 摘要整形从 `apply()` 闭包里搬出来，使它们能离线单测（`tests/*.test.mjs` 跑 lib 产物）。
 *
 * **搬家纪律：语义逐字保持不变**，唯一例外是一处刻意修正（见下「容错不变量」），
 * 该修正由失败测试先证伪再实施（tests/cli-contract.test.mjs 的脏数据套件）。
 *
 * 容错不变量（I6）：**外部 CLI 的 JSON 结构不可信**——`clyan` 是独立进程，其输出形状
 * 不由本插件保证。搬家前 `details.<cat> = null` 或 `categories` 非数组会让摘要抛
 * TypeError（工具调用整体失败）；现在一律归一为「跳过该脏条目 / 空数组」，即
 * **退化数据 → 退化输出，绝不抛**。合法输入下路径与搬家前完全一致。
 */
/** `runCli` 的统一结果形状 */
export interface CliResult {
  ok: boolean
  data: any
  raw: string
  stderr: string
}

/** 外部来源的数组归一：非数组（含 null/undefined/对象/字符串）一律退化为空数组 */
export function asArray<T = any>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

/** 人类可读大小（B/KB/MB/GB/TB；0/NaN/null 视作 0） */
export function humanSize(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return v.toFixed(1) + ' ' + units[i]
}

/** 从 CLI 结果构建统一错误信息（ok=true → null；否则 stderr || raw || 兜底文案，截断 500） */
export function cliError(r: CliResult): string | null {
  if (r.ok) return null
  return (r.stderr || r.raw || 'clyan 执行失败').slice(0, 500)
}

/** 收集 scan 结果里的全部 items（details.<cat>.items），并打上 _category 标记 */
export function collectItems(scan: any): any[] {
  const items: any[] = []
  const details = scan?.details ?? {}
  for (const [cat, det] of Object.entries<any>(details)) {
    if (det && Array.isArray(det.items)) {
      for (const it of det.items) items.push({ ...it, _category: cat })
    }
  }
  return items
}

/**
 * 各 category 的 scan_time_ms 求和。
 * 脏数据容忍：`details.<cat>` 为 null/undefined 时跳过（原实现在此处抛 TypeError）。
 * 其余类型保持原语义（`d.scan_time_ms ?? 0` 直接相加，不做类型强转）。
 */
function sumScanTimeMs(details: any): number {
  let total = 0
  for (const d of Object.values<any>(details ?? {})) {
    if (d === null || d === undefined) continue
    total += d.scan_time_ms ?? 0
  }
  return total
}

/** 扫描结果 → 聚合摘要（决策信号，不撑爆上下文） */
export function summarizeScan(scan: any, topN: number): any {
  const items = collectItems(scan)
  const categories = asArray<any>(scan?.categories).map((c: any) => ({
    category: c?.category,
    total_size_human: c?.total_size_human ?? humanSize(c?.total_size ?? 0),
    item_count: c?.item_count ?? 0,
  }))
  const bySafety: Record<string, any[]> = {}
  for (const it of items) {
    const s = it?.safety ?? 'unknown'
    ;(bySafety[s] ??= []).push(it)
  }
  const safety_distribution = Object.fromEntries(
    Object.entries(bySafety).map(([k, v]) => [k, {
      count: v.length,
      size_human: humanSize(v.reduce((s, it) => s + (it?.size ?? 0), 0)),
    }]),
  )
  const top = [...items]
    .sort((a, b) => (b?.size ?? 0) - (a?.size ?? 0))
    .slice(0, topN)
    .map((it) => ({
      path: it?.path,
      size_human: it?.size_human ?? humanSize(it?.size ?? 0),
      safety: it?.safety,
      confidence: it?.confidence,
      recovery_cost: it?.recovery_cost,
      reason: it?.reason ? String(it.reason).slice(0, 80) : '',
    }))
  return {
    grand_total_human: scan?.grand_total_human ?? humanSize(scan?.grand_total ?? 0),
    categories,
    safety_distribution,
    top_items: top,
    total_items: items.length,
    scan_time_ms: sumScanTimeMs(scan?.details),
  }
}

/** 深度空间扫描节点（与 index.ts 的 scanDeepTree 共用类型） */
export interface DeepNode { path: string; size: number; depth: number; children: DeepNode[] }

/** 深度扫描结果 → 分层地图（防撑爆上下文）；脏 acc（dirs/files 非数组）退化为空 */
export function summarizeDeep(
  acc: { dirs: DeepNode[]; files: { path: string; size: number }[] },
  rootTotal: number,
  topN: number,
): any {
  const dirs = [...asArray<DeepNode>(acc?.dirs)]
    .sort((a, b) => b.size - a.size)
    .slice(0, topN)
    .map((d) => ({
      path: d.path,
      size_human: humanSize(d.size),
      depth: d.depth,
      top_children: asArray<DeepNode>(d?.children).map((c) => ({ name: c.path.split(/[\\/]/).pop(), size_human: humanSize(c.size) })),
    }))
  const files = [...asArray<{ path: string; size: number }>(acc?.files)]
    .sort((a, b) => b.size - a.size)
    .slice(0, 10)
    .map((f) => ({ path: f.path, size_human: humanSize(f.size) }))
  return { root_total_human: humanSize(rootTotal), big_dirs: dirs, big_files: files }
}

// ══════════════ CLI argv 构造（安全默认集中地） ══════════════
//
// I1「删除类默认预览」就落在这两个构造函数里：`dryRun !== false` ⇒ 必带 `--dry-run`；
// `--yes` 只在 `yes === true` 时出现。索引/顺序与搬家前逐字一致（有测试锁住）。

/** clyan_reclaim 的 argv */
export function buildReclaimArgs(args: { path?: string; phase?: string; dryRun?: boolean; yes?: boolean }): string[] {
  const cliArgs = ['reclaim']
  if (args.phase !== undefined && args.phase.trim() !== '') cliArgs.push('--phase', args.phase.trim())
  if (args.dryRun !== false) cliArgs.push('--dry-run')
  if (args.yes === true) cliArgs.push('--yes')
  if (args.path !== undefined && args.path.trim() !== '') cliArgs.push(args.path.trim())
  return cliArgs
}

/** clyan_clean 的 argv（参数最多，含 --items/--auto-safe/--deep/--strategy/--min-confidence/--safety） */
export function buildCleanArgs(args: {
  items?: string
  dryRun?: boolean
  autoSafe?: boolean
  deep?: boolean
  strategy?: string
  minConfidence?: number
  path?: string
  yes?: boolean
  safety?: string
}): string[] {
  const cliArgs = ['clean']
  if (args.items !== undefined && args.items.trim() !== '') cliArgs.push('--items', args.items.trim())
  if (args.dryRun !== false) cliArgs.push('--dry-run')
  if (args.autoSafe === true) cliArgs.push('--auto-safe')
  if (args.deep === true) cliArgs.push('--deep')
  if (args.strategy !== undefined && args.strategy.trim() !== '') cliArgs.push('--strategy', args.strategy.trim())
  if (args.minConfidence !== undefined) cliArgs.push('--min-confidence', String(args.minConfidence))
  if (args.path !== undefined && args.path.trim() !== '') cliArgs.push('--path', args.path.trim())
  if (args.yes === true) cliArgs.push('--yes')
  if (args.safety !== undefined && args.safety.trim() !== '') cliArgs.push('--safety', args.safety.trim())
  return cliArgs
}

// ══════════════ 插件侧安全裁决（本插件唯一的实质安全决定） ══════════════

/**
 * clyan_smart_clear 的三重白名单过滤：
 * `recovery_cost === 'none'` 且 `safety === 'safe'` 且 `confidence >= minConfidence`。
 * 脏数据（item 为 null / 缺字段）→ 不入选（保守拒绝，绝不因数据脏而放行）。
 */
export function filterSmartCandidates(items: any[], minConfidence: number): any[] {
  return asArray<any>(items).filter((it) =>
    it?.recovery_cost === 'none' && it?.safety === 'safe' && (it?.confidence ?? 0) >= minConfidence,
  )
}

/** smart_clear 提交给 `clyan clean --items` 的载荷（只带 path/size，不带判断字段） */
export function smartClearPayload(candidates: any[]): { path: any; size: number }[] {
  return asArray<any>(candidates).map((it) => ({ path: it?.path, size: it?.size ?? 0 }))
}
