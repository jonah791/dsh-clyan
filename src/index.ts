/**
 * dsh-clyan v0.2 — clyan 磁盘反射弧插件（2026-08-20 主人需求 · 重构）
 *
 * 思路：不重复封装 CLI 工具，而是把 clyan 变成爱丽丝的「磁盘反射弧」——
 * 工具做全和准（clyan），AI 做判断和决策（爱丽丝）。
 *
 * 四层工具面（14 个）：
 * ── 感知层（Reflex）：让爱丽丝知道磁盘「此刻有多满、能清什么」
 *   clyan_pulse：磁盘健康检查（<1ms）
 *   clyan_scan：扫描可清理项——默认返回【聚合摘要】而非全量 items（上下文友好），detail 可选
 *   clyan_report：磁盘全景报告——合成 pulse + 扫描聚合 + 历史近况，一次调用拿决策全貌
 *   clyan_app_cache：应用内部缓存扫描（通用 AppData 关键字：cache/tmp/update 等）——专业清理重点
 *   clyan_doctor：系统诊断
 * ── 决策层（Judgement）：让爱丽丝能「安全地清」
 *   clyan_reclaim：完整回收计划（分 cost 阶段）
 *   clyan_clean：清理执行（默认 dry-run 预览）
 *   clyan_smart_clear：智能清理链——扫描 → 只挑 recovery_cost=none & safety=safe & confidence>=0.9
 *                       → 建议集（执行仍需显式确认，删不删归爱丽丝判断）
 *   clyan_auto_clear：零决策自动清理（cost=none，clyan 内置）
 * ── 闭环层（Loop）：清理后验证与追溯
 *   clyan_history：清理历史
 *   clyan_undo：撤销清理
 *   clyan_verify：清理验证——删除前后磁盘状态对比 / 单次操作详情
 * ── 运维层（Ops）：clyan 完整能力补全
 *   clyan_schedule：定时清理任务管理
 *   clyan_trust：可信路径管理
 *
 * 安全约定：所有删除类操作默认预览；执行需显式参数（dryRun=false + yes / autoSafe）。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

export const name = 'clyan'
export const inject = ['tools'] as const

export interface Config {
  /** clyan 可执行文件（PATH 内命令名或绝对路径） */
  clyanBin: string
  /** 子进程超时（ms）——深扫描可能久 */
  timeoutMs: number
  /** 默认扫描路径 */
  defaultPath: string
}
export const Config = z.object({
  clyanBin: z.string().default('clyan'),
  timeoutMs: z.number().default(180000),
  defaultPath: z.string().default('C:\\'),
})

/** 调用 clyan，返回解析后的 JSON（stdout 首 JSON 对象/数组） */
function runCli(config: Config, args: string[], timeoutMs?: number): Promise<{ ok: boolean; data: any; raw: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(config.clyanBin, ['--json', ...args], {
      windowsHide: true,
      shell: false,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, data: null, raw: '', stderr: 'clyan 超时（' + (timeoutMs ?? config.timeoutMs) + 'ms）' })
    }, timeoutMs ?? config.timeoutMs)
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
    child.on('close', (code) => {
      clearTimeout(timer)
      const trimmed = stdout.trim().replace(/^\uFEFF/, '')
      let data: any = null
      try {
        data = JSON.parse(trimmed)
      } catch {
        const objMatch = trimmed.match(/\{[\s\S]*\}/)
        const arrMatch = trimmed.match(/\[[\s\S]*\]/)
        const block = objMatch ?? arrMatch
        if (block !== null) {
          try { data = JSON.parse(block[0]) } catch { data = null }
        }
      }
      resolve({ ok: code === 0 || data !== null, data, raw: trimmed, stderr: stderr.trim() })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, data: null, raw: '', stderr: '无法启动 clyan：' + err.message })
    })
  })
}

/** 从 CLI 结果构建统一错误信息 */
function cliError(r: { ok: boolean; data: any; raw: string; stderr: string }): string | null {
  if (r.ok) return null
  return (r.stderr || r.raw || 'clyan 执行失败').slice(0, 500)
}

/** 收集 scan 结果里的全部 items（details.<cat>.items） */
function collectItems(scan: any): any[] {
  const items: any[] = []
  const details = scan?.details ?? {}
  for (const [cat, det] of Object.entries<any>(details)) {
    if (det && Array.isArray(det.items)) {
      for (const it of det.items) items.push({ ...it, _category: cat })
    }
  }
  return items
}

/** 人类可读大小 */
function humanSize(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return v.toFixed(1) + ' ' + units[i]
}

/** 扫描结果 → 聚合摘要（决策信号，不撑爆上下文） */
function summarizeScan(scan: any, topN: number): any {
  const items = collectItems(scan)
  const categories = (scan?.categories ?? []).map((c: any) => ({
    category: c.category,
    total_size_human: c.total_size_human ?? humanSize(c.total_size ?? 0),
    item_count: c.item_count ?? 0,
  }))
  const bySafety: Record<string, any[]> = {}
  for (const it of items) {
    const s = it.safety ?? 'unknown'
    ;(bySafety[s] ??= []).push(it)
  }
  const safety_distribution = Object.fromEntries(
    Object.entries(bySafety).map(([k, v]) => [k, {
      count: v.length,
      size_human: humanSize(v.reduce((s, it) => s + (it.size ?? 0), 0)),
    }]),
  )
  const top = [...items]
    .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
    .slice(0, topN)
    .map((it) => ({
      path: it.path,
      size_human: it.size_human ?? humanSize(it.size ?? 0),
      safety: it.safety,
      confidence: it.confidence,
      recovery_cost: it.recovery_cost,
      reason: it.reason ? String(it.reason).slice(0, 80) : '',
    }))
  return {
    grand_total_human: scan?.grand_total_human ?? humanSize(scan?.grand_total ?? 0),
    categories,
    safety_distribution,
    top_items: top,
    total_items: items.length,
    scan_time_ms: Object.values<any>(scan?.details ?? {}).reduce((s, d) => s + (d.scan_time_ms ?? 0), 0),
  }
}

/** 深度空间扫描：一次 DFS 计算所有目录大小（每文件只访问一次），收集大目录+大文件 */
interface DeepNode { path: string; size: number; depth: number; children: DeepNode[] }
async function scanDeepTree(
  path: string,
  maxDepth: number,
  dirBytes: number,
  fileBytes: number,
  acc: { dirs: DeepNode[]; files: { path: string; size: number }[] },
  depth = 0,
): Promise<number> {
  let total = 0
  let entries: any[] | null = null
  try {
    entries = (await fsp.readdir(path, { withFileTypes: true })) as unknown as any[]
  } catch {
    return 0
  }
  if (!entries) return 0
  const children: DeepNode[] = []
  for (const e of entries) {
    const full = join(path, e.name)
    try {
      if (e.isDirectory()) {
        const sub = await scanDeepTree(full, maxDepth, dirBytes, fileBytes, acc, depth + 1)
        total += sub
        if (depth < maxDepth && sub >= dirBytes) {
          children.push({ path: full, size: sub, depth: depth + 1, children: [] })
        }
      } else if (e.isFile()) {
        const st = await fsp.stat(full)
        total += st.size
        if (st.size >= fileBytes) acc.files.push({ path: full, size: st.size })
      }
    } catch { /* 跳过无权限/占用文件 */ }
  }
  if (children.length > 0) {
    children.sort((a, b) => b.size - a.size)
    acc.dirs.push({ path, size: total, depth, children: children.slice(0, 10) })
  }
  return total
}

/** 深度扫描结果 → 分层地图（防撑爆上下文） */
function summarizeDeep(acc: { dirs: DeepNode[]; files: { path: string; size: number }[] }, rootTotal: number, topN: number): any {
  const dirs = [...acc.dirs]
    .sort((a, b) => b.size - a.size)
    .slice(0, topN)
    .map((d) => ({
      path: d.path,
      size_human: humanSize(d.size),
      depth: d.depth,
      top_children: d.children.map((c) => ({ name: c.path.split(/[\\/]/).pop(), size_human: humanSize(c.size) })),
    }))
  const files = [...acc.files]
    .sort((a, b) => b.size - a.size)
    .slice(0, 10)
    .map((f) => ({ path: f.path, size_human: humanSize(f.size) }))
  return { root_total_human: humanSize(rootTotal), big_dirs: dirs, big_files: files }
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('dsh-clyan')

  // ══════════════ 感知层 ══════════════

  // ---------- clyan_pulse：磁盘健康检查 ----------
  ctx.tools.register(defineTool({
    name: 'clyan_pulse',
    description: '磁盘健康检查（<1ms 反射，零扫描零 IO）：返回空闲空间。path 缺省用配置默认盘。',
    parameters: {
      path: { type: 'string', description: '盘符/路径（如 C:\\）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          result: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '磁盘：' + JSON.stringify(v.result).slice(0, 200) : '失败：' + String(v.error ?? '').slice(0, 100) }],
    },
    async execute(args: { path?: string }) {
      const cliArgs = ['pulse']
      if (args.path !== undefined && args.path.trim() !== '') cliArgs.push(args.path.trim())
      const r = await runCli(config, cliArgs, 30000)
      const err = cliError(r)
      if (err !== null) return { ok: false, result: null, error: err }
      return { ok: true, result: r.data }
    },
  }))

  // ---------- clyan_scan：扫描（默认聚合摘要） ----------
  ctx.tools.register(defineTool({
    name: 'clyan_scan',
    description: '扫描可清理项。默认返回聚合摘要（分类/安全分布/top 大项），detail=true 才返回全量 items——防撑爆上下文。',
    parameters: {
      mode: { type: 'string', description: '扫描模式：quick/disk/files/packages/system/browsers/duplicates/node-waste 等（缺省 progressive）' },
      phase: { type: 'number', description: '阶段：1=fast <1s，2=garbage 8s，3=deep 30s+（缺省 1）' },
      path: { type: 'string', description: '扫描路径（缺省用配置默认盘）' },
      detail: { type: 'boolean', description: 'true=返回全量 items（可能很大，谨慎用）' },
      topN: { type: 'number', description: '摘要里 top 大项条数（缺省 10）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          result: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '扫描：' + JSON.stringify(v.result).slice(0, 400) : '失败：' + String(v.error ?? '').slice(0, 100) }],
    },
    async execute(args: { mode?: string; phase?: number; path?: string; detail?: boolean; topN?: number }) {
      const cliArgs = ['scan']
      if (args.mode !== undefined && args.mode.trim() !== '') cliArgs.push(args.mode.trim())
      if (args.phase !== undefined) cliArgs.push('--phase', String(args.phase))
      if (args.path !== undefined && args.path.trim() !== '') cliArgs.push('--path', args.path.trim())
      const r = await runCli(config, cliArgs)
      const err = cliError(r)
      if (err !== null) return { ok: false, result: null, error: err }
      if (args.detail === true) return { ok: true, result: r.data }
      return { ok: true, result: summarizeScan(r.data, args.topN ?? 10) }
    },
  }))

  // ---------- clyan_report：磁盘全景报告（合成） ----------
  ctx.tools.register(defineTool({
    name: 'clyan_report',
    description: '磁盘全景报告：合成 pulse + 扫描聚合 + 历史近况 → 一次调用拿决策全貌（磁盘状态/可清理潜力/近期清理）。',
    parameters: {
      path: { type: 'string', description: '盘符/路径（缺省用配置默认盘）' },
      phase: { type: 'number', description: '扫描阶段（缺省 1 快速）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          result: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '报告：' + JSON.stringify(v.result).slice(0, 400) : '失败：' + String(v.error ?? '').slice(0, 100) }],
    },
    async execute(args: { path?: string; phase?: number }) {
      const p = args.path?.trim() || config.defaultPath
      const [pulseR, scanR, histR] = await Promise.all([
        runCli(config, ['pulse', p], 30000),
        runCli(config, ['scan', 'quick', '--phase', String(args.phase ?? 1), '--path', p], 120000),
        runCli(config, ['history', '--limit', '5'], 30000),
      ])
      if (cliError(pulseR) !== null && cliError(scanR) !== null) {
        return { ok: false, result: null, error: 'pulse: ' + (cliError(pulseR) ?? 'ok') + ' / scan: ' + (cliError(scanR) ?? 'ok') }
      }
      const summary = scanR.data ? summarizeScan(scanR.data, 10) : null
      const history = histR.data?.operations ?? []
      const recent = history.slice(0, 5).map((o: any) => ({
        id: o.id,
        action: o.action,
        summary: o.summary,
        total_human: humanSize(o.total_size ?? 0),
        time: o.timestamp,
      }))
      return {
        ok: true,
        result: {
          disk: pulseR.data ?? null,
          cleanable: summary,
          recent_cleanups: recent,
          note: '磁盘状态 + 可清理潜力 + 近期清理历史已合成。决策：由爱丽丝根据 safety/recovery_cost 判断清理范围。',
        },
      }
    },
  }))

  // ---------- clyan_space：磁盘空间占用分析 ----------
  ctx.tools.register(defineTool({
    name: 'clyan_space',
    description: '磁盘空间占用分析（已占用分布）：总/已用/空闲/使用率 + top 大目录逐层展开 + gap 分析（未扫到部分）。回答「磁盘被什么占满了」。',
    parameters: {
      path: { type: 'string', description: '盘符/路径（缺省用配置默认盘）' },
      topN: { type: 'number', description: 'top 目录条数（缺省 10）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          result: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '占用：' + JSON.stringify(v.result).slice(0, 400) : '失败：' + String(v.error ?? '').slice(0, 100) }],
    },
    async execute(args: { path?: string; topN?: number }) {
      const cliArgs = ['scan', 'disk']
      if (args.path !== undefined && args.path.trim() !== '') cliArgs.push('--path', args.path.trim())
      const r = await runCli(config, cliArgs, 180000)
      const err = cliError(r)
      if (err !== null) return { ok: false, result: null, error: err }
      const d = r.data ?? {}
      const topN = args.topN ?? 10
      return {
        ok: true,
        result: {
          disk: d.disk ?? null,
          top_dirs: (d.top_dirs ?? []).slice(0, topN).map((dir: any) => ({
            name: dir.name,
            path: dir.path,
            size_human: dir.size_human ?? humanSize(dir.size ?? 0),
            top_children: (dir.children ?? []).slice(0, 5).map((c: any) => ({ name: c.name, size_human: c.size_human ?? humanSize(c.size ?? 0) })),
          })),
          gap_analysis: d.gap_analysis ?? null,
          note: d.gap_analysis?.full_scan_mode === false
            ? '注意：非全盘完整扫描（gap ' + (d.gap_analysis.gap_human ?? '?') + ' 未计入，含 7 个无权限目录）。如需更全可对重点目录单独深扫。'
            : '全盘完整扫描。',
        },
      }
    },
  }))

  // ---------- clyan_space_deep：深度空间扫描（内建递归，补 clyan 只扫顶层的缺） ----------
  ctx.tools.register(defineTool({
    name: 'clyan_space_deep',
    description: '深度空间扫描（内建递归）：一次 DFS 计算目录树真实大小，回答「磁盘被什么占满」的深层版——clyan scan disk 只统计顶层（如 Users 只报 13GB 实际 226GB），本工具递归摸清。返回分层大目录 + 大文件。全盘可能 2-3 分钟。',
    parameters: {
      path: { type: 'string', description: '扫描根路径（缺省用配置默认盘；建议指定如 C:\\Users\\tr\\AppData 更快）' },
      maxDepth: { type: 'number', description: '目录收集深度（缺省 4；计算深度不限，只限制展示层级）' },
      dirThresholdMB: { type: 'number', description: '大目录阈值 MB（缺省 200）' },
      fileThresholdMB: { type: 'number', description: '大文件阈值 MB（缺省 200）' },
      topN: { type: 'number', description: '返回大目录条数（缺省 20）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          result: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '深扫：' + JSON.stringify(v.result).slice(0, 500) : '失败：' + String(v.error ?? '').slice(0, 100) }],
    },
    async execute(args: { path?: string; maxDepth?: number; dirThresholdMB?: number; fileThresholdMB?: number; topN?: number }) {
      const p = args.path?.trim() || config.defaultPath
      const maxDepth = args.maxDepth ?? 4
      const dirBytes = (args.dirThresholdMB ?? 200) * 1024 * 1024
      const fileBytes = (args.fileThresholdMB ?? 200) * 1024 * 1024
      const acc = { dirs: [] as DeepNode[], files: [] as { path: string; size: number }[] }
      const t0 = Date.now()
      const rootTotal = await scanDeepTree(p, maxDepth, dirBytes, fileBytes, acc)
      const elapsedMs = Date.now() - t0
      return {
        ok: true,
        result: {
          scan_path: p,
          ...summarizeDeep(acc, rootTotal, args.topN ?? 20),
          elapsed_sec: (elapsedMs / 1000).toFixed(1),
          note: '深度扫描（内建递归）。要点：顶层占位只是冰山一角，真正大头常在深层（如 AppData）。',
        },
      }
    },
  }))

  // ---------- clyan_app_cache：应用内部缓存扫描（通用 AppData 关键字） ----------
  ctx.tools.register(defineTool({
    name: 'clyan_app_cache',
    description: '应用内部缓存扫描（通用）：遍历 AppData\\Local+Roaming+LocalLow 各应用目录，递归找 cache/tmp/temp/log/old/backup/update/download 类子目录（>minSizeMB）。返回可清清单（path/size/safety/confidence）+ 聚合统计。这是专业清理工具的重点扫描——应用缓存往往单项几百 MB 到几 GB。',
    parameters: {
      minSizeMB: { type: 'number', description: '最小项大小 MB（缺省 50）' },
      detail: { type: 'boolean', description: 'true=返回全量 items；缺省返回 top 大项摘要' },
      topN: { type: 'number', description: '摘要里 top 大项条数（缺省 15）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          result: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '应用缓存：' + JSON.stringify(v.result).slice(0, 500) : '失败：' + String(v.error ?? '').slice(0, 100) }],
    },
    async execute(args: { minSizeMB?: number; detail?: boolean; topN?: number }) {
      const cliArgs = ['scan', 'app-cache']
      if (args.minSizeMB !== undefined) cliArgs.push('--min-size-mb', String(args.minSizeMB))
      const r = await runCli(config, cliArgs, config.timeoutMs)
      const err = cliError(r)
      if (err !== null) return { ok: false, result: null, error: err }
      const items = r.data?.items ?? []
      const total = items.reduce((s: number, it: any) => s + (it.size ?? 0), 0)
      const bySafety: Record<string, { count: number; bytes: number }> = {}
      for (const it of items) {
        const s = it.safety ?? 'unknown'
        const cur = (bySafety[s] ??= { count: 0, bytes: 0 })
        cur.count++
        cur.bytes += it.size ?? 0
      }
      const bySafetyHuman = Object.fromEntries(
        Object.entries(bySafety).map(([k, v]) => [k, { count: v.count, size_human: humanSize(v.bytes) }]),
      )
      const top = [...items]
        .sort((a: any, b: any) => (b.size ?? 0) - (a.size ?? 0))
        .slice(0, args.topN ?? 15)
        .map((it: any) => ({
          path: it.path,
          label: it.label,
          size_human: it.size_human ?? humanSize(it.size ?? 0),
          safety: it.safety,
          confidence: it.confidence,
        }))
      return {
        ok: true,
        result: {
          item_count: items.length,
          total_size_human: humanSize(total),
          by_safety: bySafetyHuman,
          top_items: top,
          ...(args.detail === true ? { items } : {}),
          note: '应用内部缓存扫描（AppData 通用关键字）。safe 项可再生可删；caution 项（log/old/backup/update/download）删前确认。执行清理走 clyan_clean（--items）。',
        },
      }
    },
  }))

  // ---------- clyan_doctor：系统诊断 ----------
  ctx.tools.register(defineTool({
    name: 'clyan_doctor',
    description: 'Clyan 系统诊断：模块可导入性/数据库/磁盘/56 providers/缓存一致性检查。',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          result: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '诊断：' + JSON.stringify(v.result).slice(0, 300) : '失败：' + String(v.error ?? '').slice(0, 100) }],
    },
    async execute() {
      const r = await runCli(config, ['doctor'], 60000)
      const err = cliError(r)
      if (err !== null) return { ok: false, result: null, error: err }
      return { ok: true, result: r.data }
    },
  }))

  // ══════════════ 决策层 ══════════════

  // ---------- clyan_reclaim：完整回收计划（全量扫描+分阶段） ----------
  ctx.tools.register(defineTool({
    name: 'clyan_reclaim',
    description: '完整回收计划（=全量扫描→去重→按 recovery_cost 分阶段 none/low/medium/high/unknown）。默认返回聚合摘要（各阶段统计+recommendation+top 项），detail=true 才全量。默认 dry-run 不删；执行需 dryRun=false + yes=true。',
    parameters: {
      path: { type: 'string', description: '根路径（缺省用配置默认盘）' },
      phase: { type: 'string', description: '只执行该 cost 阶段：none/low/medium/high' },
      dryRun: { type: 'boolean', description: '只出计划不执行（缺省 true——安全默认）' },
      yes: { type: 'boolean', description: '跳过确认（执行删除时必须显式 true）' },
      detail: { type: 'boolean', description: 'true=返回全量计划 items（可能很大，谨慎用）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          result: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '回收：' + JSON.stringify(v.result).slice(0, 400) : '失败：' + String(v.error ?? '').slice(0, 100) }],
    },
    async execute(args: { path?: string; phase?: string; dryRun?: boolean; yes?: boolean; detail?: boolean }) {
      const cliArgs = ['reclaim']
      if (args.phase !== undefined && args.phase.trim() !== '') cliArgs.push('--phase', args.phase.trim())
      if (args.dryRun !== false) cliArgs.push('--dry-run')
      if (args.yes === true) cliArgs.push('--yes')
      if (args.path !== undefined && args.path.trim() !== '') cliArgs.push(args.path.trim())
      const r = await runCli(config, cliArgs)
      const err = cliError(r)
      if (err !== null) return { ok: false, result: null, error: err }
      const data = r.data ?? {}
      if (args.detail === true) return { ok: true, result: data }
      // 聚合摘要（防撑爆上下文）
      const phases = (data.phases ?? []).map((ph: any) => ({
        cost: ph.cost,
        total_size_human: ph.total_size_human ?? humanSize(ph.total_size ?? 0),
        item_count: ph.item_count ?? 0,
        top_items: (ph.items ?? [])
          .slice()
          .sort((a: any, b: any) => (b.size ?? 0) - (a.size ?? 0))
          .slice(0, 5)
          .map((it: any) => ({ path: it.path, size_human: it.size_human ?? humanSize(it.size ?? 0) })),
      }))
      return {
        ok: true,
        result: {
          path: data.path,
          total_size_human: data.total_size_human ?? humanSize(data.total_size ?? 0),
          total_items: data.total_items ?? 0,
          recommendation: data.recommendation ?? null,
          phases,
          note: 'reclaim = 全量扫描后按 recovery_cost 分阶段：none 零成本最安全（Temp/缓存）→ low/medium 谨慎 → high 高风险勿乱动 → unknown。detail=true 取全量。执行需 dryRun=false + yes=true。',
        },
      }
    },
  }))

  // ---------- clyan_clean：清理执行 ----------
  ctx.tools.register(defineTool({
    name: 'clyan_clean',
    description: '清理执行。安全闸门（fail-closed）：受保护路径 + 非缓存语义路径会被强制拦截（blocked_items），不再仅警告。默认 dry-run 预览（不删）；实际删除需显式：autoSafe=true（仅 confidence>=0.9 且 safety=safe）或 deep=true+yes=true。items 可传 JSON 指定清理项。',
    parameters: {
      items: { type: 'string', description: 'items JSON 字符串或文件路径（来自 scan 结果）' },
      dryRun: { type: 'boolean', description: '只预览不删除（缺省 true）' },
      autoSafe: { type: 'boolean', description: '只删 confidence>=0.90 且 safety=safe 项（显式 true 才启用）' },
      deep: { type: 'boolean', description: '全自动清理循环：扫描→评分→过滤→执行→验证' },
      strategy: { type: 'string', description: 'deep 模式过滤策略：safe/aged/orphan/all（缺省 safe）' },
      minConfidence: { type: 'number', description: 'confidence 阈值 0-100' },
      path: { type: 'string', description: 'deep 扫描根路径' },
      yes: { type: 'boolean', description: '跳过确认（执行删除时必须显式 true）' },
      safety: { type: 'string', description: '最低安全级别：safe/caution/unsafe' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          result: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '清理：' + JSON.stringify(v.result).slice(0, 300) : '失败：' + String(v.error ?? '').slice(0, 100) }],
    },
    async execute(args: { items?: string; dryRun?: boolean; autoSafe?: boolean; deep?: boolean; strategy?: string; minConfidence?: number; path?: string; yes?: boolean; safety?: string }) {
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
      const r = await runCli(config, cliArgs)
      const err = cliError(r)
      if (err !== null) return { ok: false, result: null, error: err }
      return { ok: true, result: r.data }
    },
  }))

  // ---------- clyan_smart_clear：智能清理链（扫描→过滤→建议，执行需确认） ----------
  ctx.tools.register(defineTool({
    name: 'clyan_smart_clear',
    description: '智能清理链：扫描 → 只挑 recovery_cost=none & safety=safe & confidence>=0.9 的安全项 → 返回建议集。执行仍默认预览，需 dryRun=false + yes=true 才删——删不删归爱丽丝判断。',
    parameters: {
      path: { type: 'string', description: '根路径（缺省用配置默认盘）' },
      phase: { type: 'number', description: '扫描阶段（缺省 2：garbage 更全面）' },
      dryRun: { type: 'boolean', description: '只出建议不执行（缺省 true）' },
      yes: { type: 'boolean', description: '执行删除（必须与 dryRun=false 一起显式 true）' },
      minConfidence: { type: 'number', description: 'confidence 阈值 0-1（缺省 0.9）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          result: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '智能清理：' + JSON.stringify(v.result).slice(0, 400) : '失败：' + String(v.error ?? '').slice(0, 100) }],
    },
    async execute(args: { path?: string; phase?: number; dryRun?: boolean; yes?: boolean; minConfidence?: number }) {
      const p = args.path?.trim() || config.defaultPath
      const conf = args.minConfidence ?? 0.9
      const scanR = await runCli(config, ['scan', 'quick', '--phase', String(args.phase ?? 2), '--path', p], config.timeoutMs)
      const scanErr = cliError(scanR)
      if (scanErr !== null) return { ok: false, result: null, error: 'scan: ' + scanErr }
      const candidates = collectItems(scanR.data).filter((it) =>
        it.recovery_cost === 'none' && it.safety === 'safe' && (it.confidence ?? 0) >= conf,
      )
      const total = candidates.reduce((s, it) => s + (it.size ?? 0), 0)
      const willExecute = args.dryRun === false && args.yes === true
      let executed: any = null
      if (willExecute && candidates.length > 0) {
        const payload = candidates.map((it) => ({ path: it.path, size: it.size ?? 0 }))
        const cleanR = await runCli(config, ['clean', '--items', JSON.stringify(payload), '--yes'], config.timeoutMs)
        executed = cleanR.data ?? { error: cleanR.stderr.slice(0, 200) }
      }
      return {
        ok: true,
        result: {
          scan_path: p,
          candidates_found: candidates.length,
          total_reclaim_human: humanSize(total),
          top_candidates: candidates
            .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
            .slice(0, 10)
            .map((it) => ({ path: it.path, size_human: it.size_human ?? humanSize(it.size ?? 0), reason: it.reason ? String(it.reason).slice(0, 80) : '' })),
          executed: executed,
          note: willExecute
            ? '已执行安全清理。'
            : '未执行（默认预览）。要执行请 dryRun=false + yes=true——由爱丽丝确认后调用。',
        },
      }
    },
  }))

  // ---------- clyan_auto_clear：零决策自动清理 ----------
  ctx.tools.register(defineTool({
    name: 'clyan_auto_clear',
    description: '零决策自动清理：只删 recovery_cost=none 项（Temp/npx/缩略图/WER 等）。使用缓存数据优先。实际执行会删文件——调用前确认。',
    parameters: {
      path: { type: 'string', description: '根路径（缺省用配置默认盘）' },
      targetGb: { type: 'number', description: '达到 N GB 后停止' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          result: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '自动清理：' + JSON.stringify(v.result).slice(0, 300) : '失败：' + String(v.error ?? '').slice(0, 100) }],
    },
    async execute(args: { path?: string; targetGb?: number }) {
      const cliArgs = ['auto-clear']
      if (args.targetGb !== undefined) cliArgs.push('--target-gb', String(args.targetGb))
      if (args.path !== undefined && args.path.trim() !== '') cliArgs.push(args.path.trim())
      const r = await runCli(config, cliArgs)
      const err = cliError(r)
      if (err !== null) return { ok: false, result: null, error: err }
      return { ok: true, result: r.data }
    },
  }))

  // ══════════════ 闭环层 ══════════════

  // ---------- clyan_history：清理历史 ----------
  ctx.tools.register(defineTool({
    name: 'clyan_history',
    description: '查看清理历史：最近操作列表，或按 id 查看单次详情。',
    parameters: {
      id: { type: 'string', description: '操作 ID（查看详情）' },
      limit: { type: 'number', description: '条数上限' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          result: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '历史：' + JSON.stringify(v.result).slice(0, 300) : '失败：' + String(v.error ?? '').slice(0, 100) }],
    },
    async execute(args: { id?: string; limit?: number }) {
      const cliArgs = ['history']
      if (args.id !== undefined && args.id.trim() !== '') cliArgs.push('--id', args.id.trim())
      if (args.limit !== undefined) cliArgs.push('--limit', String(args.limit))
      const r = await runCli(config, cliArgs, 30000)
      const err = cliError(r)
      if (err !== null) return { ok: false, result: null, error: err }
      return { ok: true, result: r.data }
    },
  }))

  // ---------- clyan_undo：撤销清理 ----------
  ctx.tools.register(defineTool({
    name: 'clyan_undo',
    description: '撤销一次清理操作（从回收站恢复）。需要操作 ID（来自 history）。',
    parameters: {
      id: { type: 'string', required: true, description: '操作 ID（clyan_history 获取）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          result: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '撤销：' + JSON.stringify(v.result).slice(0, 200) : '失败：' + String(v.error ?? '').slice(0, 100) }],
    },
    async execute(args: { id: string }) {
      const r = await runCli(config, ['undo', args.id.trim()], 60000)
      const err = cliError(r)
      if (err !== null) return { ok: false, result: null, error: err }
      return { ok: true, result: r.data }
    },
  }))

  // ---------- clyan_verify：清理验证 ----------
  ctx.tools.register(defineTool({
    name: 'clyan_verify',
    description: '清理验证：无 id 时对比当前磁盘状态（pulse）与最近清理历史；有 id 时返回单次操作详情（含 before/after free）。闭环确认清理效果。',
    parameters: {
      id: { type: 'string', description: '操作 ID（缺省=最近一次清理的验证）' },
      path: { type: 'string', description: '盘符/路径（缺省用配置默认盘）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          result: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '验证：' + JSON.stringify(v.result).slice(0, 400) : '失败：' + String(v.error ?? '').slice(0, 100) }],
    },
    async execute(args: { id?: string; path?: string }) {
      const p = args.path?.trim() || config.defaultPath
      if (args.id !== undefined && args.id.trim() !== '') {
        const r = await runCli(config, ['history', '--id', args.id.trim()], 30000)
        const err = cliError(r)
        if (err !== null) return { ok: false, result: null, error: err }
        return { ok: true, result: { operation: r.data, current_free_gb: null, last_operation: null, note: null } }
      }
      const [pulseR, histR] = await Promise.all([
        runCli(config, ['pulse', p], 30000),
        runCli(config, ['history', '--limit', '3'], 30000),
      ])
      const ops = histR.data?.operations ?? []
      const last = ops[0] ?? null
      const beforeFree = last?.before_free ?? null
      const afterFree = last?.after_free ?? null
      const nowFree = pulseR.data?.free_gb ?? null
      return {
        ok: true,
        result: {
          operation: null,
          current_free_gb: nowFree,
          last_operation: last ? {
            id: last.id,
            summary: last.summary,
            total_human: humanSize(last.total_size ?? 0),
            before_free_gb: beforeFree !== null ? (beforeFree / 1073741824).toFixed(1) : null,
            after_free_gb: afterFree !== null ? (afterFree / 1073741824).toFixed(1) : null,
          } : null,
          note: last && afterFree !== null && beforeFree !== null
            ? '上次清理释放 ' + humanSize(afterFree - beforeFree)
            : '无对比数据（历史缺失）。',
        },
      }
    },
  }))

  // ══════════════ 运维层 ══════════════

  // ---------- clyan_schedule：定时清理管理 ----------
  ctx.tools.register(defineTool({
    name: 'clyan_schedule',
    description: '定时清理任务管理：create=创建每周定时清理（path/time 可选），remove=移除，缺省=查看。注意：自主性铁律下爱丽丝不自动创建定时删除，此工具供主人安排时使用。',
    parameters: {
      action: { type: 'string', description: 'create/remove/（缺省=查看）' },
      path: { type: 'string', description: '盘符或路径（缺省 C:\\）' },
      time: { type: 'string', description: '运行时间（如 03:00，缺省 3 AM）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          result: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '定时：' + JSON.stringify(v.result).slice(0, 300) : '失败：' + String(v.error ?? '').slice(0, 100) }],
    },
    async execute(args: { action?: string; path?: string; time?: string }) {
      const cliArgs = ['schedule']
      if (args.action === 'create') cliArgs.push('--create')
      else if (args.action === 'remove') cliArgs.push('--remove')
      if (args.path !== undefined && args.path.trim() !== '') cliArgs.push('--path', args.path.trim())
      if (args.time !== undefined && args.time.trim() !== '') cliArgs.push('--time', args.time.trim())
      const r = await runCli(config, cliArgs, 30000)
      const err = cliError(r)
      if (err !== null) return { ok: false, result: null, error: err }
      return { ok: true, result: r.data }
    },
  }))

  // ---------- clyan_trust：可信路径管理（含审计） ----------
  ctx.tools.register(defineTool({
    name: 'clyan_trust',
    description: '可信路径管理：list=查看，add=添加（跳过保护警告），remove=移除，audit=查看 trust 放行审计日志。安全重构后：trust 放行会记录时间/来源/原因（可追溯）。',
    parameters: {
      action: { type: 'string', description: 'list/add/remove/audit' },
      path: { type: 'string', description: '路径（add/remove 时必填）' },
      reason: { type: 'string', description: 'add 时的原因（审计留痕，建议填写）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          result: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '可信路径：' + JSON.stringify(v.result).slice(0, 300) : '失败：' + String(v.error ?? '').slice(0, 100) }],
    },
    async execute(args: { action?: string; path?: string; reason?: string }) {
      const cliArgs = ['trust', args.action ?? 'list']
      if (args.path !== undefined && args.path.trim() !== '') cliArgs.push(args.path.trim())
      if (args.reason !== undefined && args.reason.trim() !== '' && args.action === 'add') {
        cliArgs.push('--reason', args.reason.trim())
      }
      const r = await runCli(config, cliArgs, 30000)
      const err = cliError(r)
      if (err !== null) return { ok: false, result: null, error: err }
      return { ok: true, result: r.data }
    },
  }))

  ctx.effect(() => {
    logger.info('ready v0.4（磁盘反射弧：14 工具；安全重构：execute 强制拦截保护路径 + 语义裁决 fail-closed + trust 审计）')
    return () => { /* 清理 */ }
  })
}
