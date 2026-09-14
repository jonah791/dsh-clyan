/**
 * trace.ts 套件（**完全离线**：零真实磁盘扫描、零真实清理；唯一 IO 是临时目录里的轨迹文件）。
 *
 * 覆盖四类：
 *  ① 纯函数正常路径（路径解析 / 构建自证 / 脱敏 / 参数摘要 / 判定 / 清洗账 / 序列化）；
 *  ② **退化路径**（坏行/半行/空行/缺失文件/不可写路径/脏上游数据——一律不抛）；
 *  ③ **尸体测试**（不可写路径 → `false` 且不抛；业务异常原样重抛）；
 *  ④ **隐私尸体测试**（凭据 / 口令 / token / 用户名主目录 / items 载荷内容 → 一个字都不落盘）。
 *
 * 关键不变量（可证伪）：`analyzeScanShape` 是 `summarizeScan` 的**镜像账**——
 * 逐条 fixture 断言 `shape.itemsKept === summarizeScan(raw, N).total_items`（判据单一真源，
 * 镜像一旦漂移测试立刻红）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { summarizeScan } from '../lib/logic.js'
import {
  REDACTED, argDigest, appendTraceEntry, argsDigest, argvDigest, analyzeScanShape,
  buildStamp, clyanTrace, clyanTracePath, composeBootEntry, composeCallEntry, composeCliEntry,
  composeScanShapeEntry, countOf, degradedParse, errorOf, homePathVariants, instrumentTool,
  isDestructiveCall, kindOf, mtimeOf, outKeysOf, parseTraceEntries, payloadFold,
  readPackageVersion, readTraceEntries, redactHome, redactText, resolveHome, resultOk,
  serializeTraceEntry, summaryShapeOf, traceEnabled, truncate, valueDigest, wrapToolExecute,
} from '../lib/trace.js'

const tmp = mkdtempSync(join(tmpdir(), 'clyan-trace-test-'))
const BASE = { build: '0.1.0@42', pid: 777 }

// ══════════════ 路径与构建自证 ══════════════

test('resolveHome: DSH_HOME 优先（含空白回退）；clyanTracePath 锚定单文件名', () => {
  assert.equal(resolveHome({ DSH_HOME: 'E:/alice/.dsh' }, '/home/x'), 'E:/alice/.dsh')
  assert.equal(resolveHome({ DSH_HOME: ' ' }, '/home/x'), join('/home/x', '.dsh'))
  assert.equal(resolveHome({}, '/home/x'), join('/home/x', '.dsh'))
  assert.equal(clyanTracePath('/h/.dsh'), join('/h/.dsh', 'clyan-trace.jsonl'))
  // 路径可预测 = 永远落在 <DSH_HOME> 根下，不随 cwd 漂移（注意 join 会做平台分隔符归一）
  assert.equal(clyanTracePath('E:/alice/.dsh'), join('E:/alice/.dsh', 'clyan-trace.jsonl'))
})

test('traceEnabled: 缺省开启；DSH_CLYAN_TRACE=0 关闭', () => {
  assert.equal(traceEnabled({}), true)
  assert.equal(traceEnabled({ DSH_CLYAN_TRACE: '0' }), false)
  assert.equal(traceEnabled({ DSH_CLYAN_TRACE: '1' }), true)
})

test('构建自证：buildStamp/readPackageVersion/mtimeOf（缺失文件退化为 unknown@0）', () => {
  const root = join(tmp, 'pkg')
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }), 'utf8')
  const self = join(root, 'lib', 'index.js')
  writeFileSync(self, '// x', 'utf8')
  assert.equal(readPackageVersion(self), '9.9.9')
  assert.ok(mtimeOf(self) > 0)
  assert.equal(buildStamp(self, '9.9.9'), '9.9.9@' + String(mtimeOf(self)))
  assert.equal(buildStamp(join(root, 'missing.js'), ''), 'unknown@0')
  assert.equal(readPackageVersion(join(root, 'missing.js')), '')
})

// ══════════════ 脱敏（隐私红线） ══════════════

test('redactText: 键值对/Bearer/厂商前缀/高熵串一律擦除，业务文本保留', () => {
  assert.ok(redactText('password=hunter2').includes('password=[redacted]'))
  assert.ok(redactText('token: abcdefg').includes('[redacted]'))
  assert.ok(redactText('Authorization: Bearer xyz.abc').includes('[redacted]'))
  assert.ok(redactText('key=sk-abcdefghijkl').includes('[redacted]'))
  assert.ok(redactText('AKIAIOSFODNN7EXAMPLE').includes('[redacted]'))
  assert.ok(redactText('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789').includes('[redacted]'))
  assert.ok(redactText('github_pat_ABCDEFGHIJKLMNOPQRSTUV').includes('[redacted]'))
  assert.ok(redactText('x'.repeat(64)).includes('[redacted]'))
  // 业务文本不得被误伤（排障要看）
  assert.equal(redactText('C:\\Temp\\a.tmp'), 'C:\\Temp\\a.tmp')
  assert.equal(redactText('scan quick --phase 2'), 'scan quick --phase 2')
})

test('redactHome: Windows/POSIX/WSL 三形态折叠为 <home>（用户名不落盘）', () => {
  assert.equal(redactHome('C:\\Users\\tr\\AppData', 'C:\\Users\\tr'), '<home>\\AppData')
  assert.equal(redactHome('C:/Users/tr/AppData', 'C:\\Users\\tr'), '<home>/AppData')
  assert.equal(redactHome('/mnt/c/Users/tr/AppData', 'C:\\Users\\tr'), '<home>/AppData')
  assert.equal(redactHome('/home/alice/x', '/home/alice'), '<home>/x')
  // 空 home 不做任何替换（不制造假证据）
  assert.equal(redactHome('C:\\x', ''), 'C:\\x')
  assert.deepEqual(homePathVariants(''), [])
  assert.equal(homePathVariants('C:\\Users\\tr').length, 3)
})

// ══════════════ 参数摘要（白名单 + 黑名单双闸） ══════════════

test('argDigest: 黑名单键名整键丢弃（连长度都不记）；白名单键保留', () => {
  assert.equal(argDigest('apiKey', 'whatever'), null)
  assert.equal(argDigest('token', 'whatever'), null)
  assert.equal(argDigest('password', 'whatever'), null)
  assert.equal(argDigest('sessionId', 'whatever'), null)
  assert.equal(argDigest('phase', 2), 'phase=2')
  assert.equal(argDigest('dryRun', false), 'dryRun=false')
  assert.equal(argDigest('yes', true), 'yes=true')
  assert.equal(argDigest('path', 'C:\\'), 'path=C:\\')
})

test('argDigest/argsDigest: 白名单外的键一律不记；键序稳定；折叠主目录', () => {
  const digest = argsDigest({ path: 'C:\\Users\\tr\\Temp', mode: 'quick', 秘: 'x', extra: 'y' })
  assert.equal(digest, 'path=<home>\\Temp; mode=quick')
  assert.equal(argsDigest(null), '')
  assert.equal(argsDigest('str'), '')
  assert.equal(argsDigest({}), '')
  // 顺序由白名单决定（与入参书写顺序无关）
  assert.equal(argsDigest({ yes: true, dryRun: false }), 'dryRun=false; yes=true')
})

test('payloadFold: items 载荷只记形状与条数，不记内容', () => {
  assert.equal(payloadFold('[{"path":"C:\\\\a"},{"path":"C:\\\\b"}]'), '<payload: json[2]>')
  assert.equal(payloadFold('{"a":1}'), '<payload: json:object>')
  assert.equal(payloadFold('C:\\items.json'), '<payload: 13 chars>')
  assert.equal(payloadFold(''), '<payload: empty>')
  assert.equal(payloadFold(undefined), '<payload: empty>')
  // 载荷内容不得出现在摘要里
  assert.equal(argsDigest({ items: '[{"path":"C:\\\\Secret\\\\x","why":"leak-me"}]' }), 'items=<payload: json[1]>')
})

test('argvDigest: --items 的值折叠；其余元素脱敏 + 折叠主目录', () => {
  assert.equal(
    argvDigest(['clean', '--items', '[{"path":"a"},{"path":"b"},{"path":"c"}]', '--dry-run']),
    'clean --items <payload: json[3]> --dry-run',
  )
  assert.equal(argvDigest(['scan', 'quick', '--path', 'C:\\Users\\tr']), 'scan quick --path <home>')
  // --items 在末尾（无值）不得吞掉后续/越界
  assert.equal(argvDigest(['clean', '--items']), 'clean --items')
  assert.equal(argvDigest([]), '')
  assert.equal(argvDigest([truncate('x'.repeat(400), 120)]).length <= 300, true)
})

test('valueDigest/truncate/kindOf: 容器形状占位、越界截断、形态名', () => {
  assert.equal(valueDigest([1, 'a', { b: 1 }, null]), '1|a|{…}|null')
  assert.equal(valueDigest({ a: 1 }), '{…}')
  assert.equal(valueDigest(null), 'null')
  assert.equal(valueDigest(5), '5')
  assert.equal(truncate('abcdef', 3), 'abc…')
  assert.equal(truncate('abc', 3), 'abc')
  assert.equal(kindOf(undefined), 'undefined')
  assert.equal(kindOf(null), 'null')
  assert.equal(kindOf([]), 'array')
  assert.equal(kindOf({}), 'object')
  assert.equal(kindOf('s'), 'string')
})

// ══════════════ 判定（纯函数） ══════════════

test('isDestructiveCall: 与各工具真实删除语义逐条对应（U2 的落点）', () => {
  // clean/reclaim：dryRun !== false 恒预览；只有显式 false 才算「关闭预览」
  assert.equal(isDestructiveCall('clyan_clean', {}), false)
  assert.equal(isDestructiveCall('clyan_clean', { dryRun: true }), false)
  assert.equal(isDestructiveCall('clyan_clean', { dryRun: false }), true)
  assert.equal(isDestructiveCall('clyan_reclaim', { dryRun: false, yes: true }), true)
  assert.equal(isDestructiveCall('clyan_reclaim', { yes: true }), false)
  // smart_clear：只有 dryRun=false && yes=true 才真调 clean
  assert.equal(isDestructiveCall('clyan_smart_clear', { dryRun: false }), false)
  assert.equal(isDestructiveCall('clyan_smart_clear', { dryRun: false, yes: true }), true)
  // auto_clear：零决策恒真删
  assert.equal(isDestructiveCall('clyan_auto_clear', {}), true)
  assert.equal(isDestructiveCall('clyan_auto_clear', undefined), true)
  // 无删除语义的工具
  for (const op of ['clyan_pulse', 'clyan_scan', 'clyan_report', 'clyan_history', 'clyan_undo', 'clyan_verify']) {
    assert.equal(isDestructiveCall(op, { dryRun: false, yes: true }), false, op)
  }
  // 类型不符保守：'false' / 1 不算「显式关闭预览」
  assert.equal(isDestructiveCall('clyan_clean', { dryRun: 'false' }), false)
  assert.equal(isDestructiveCall('clyan_clean', { dryRun: 0 }), false)
  assert.equal(isDestructiveCall('clyan_smart_clear', { dryRun: false, yes: 'true' }), false)
})

test('countOf/outKeysOf/resultOk/errorOf/degradedParse: 脏数据一律不抛', () => {
  assert.equal(countOf({ result: { total_items: 7 } }), 7)
  assert.equal(countOf({ result: { item_count: 3 } }), 3)
  assert.equal(countOf({ result: { candidates_found: 2 } }), 2)
  assert.equal(countOf({ total_items: 1 }), 1)
  assert.equal(countOf({ result: { big_dirs: [1, 2] } }), undefined)  // 不猜数组
  assert.equal(countOf(null), undefined)
  assert.equal(countOf('x'), undefined)
  assert.equal(outKeysOf({ result: { a: 1, b: 2 } }), 'a,b')
  assert.equal(outKeysOf({ ok: true, result: null }), 'ok,result')
  assert.equal(outKeysOf(null), '')
  assert.equal(resultOk({ ok: true }), true)
  assert.equal(resultOk({ ok: false }), false)
  assert.equal(resultOk({ ok: true, error: 'x' }), false)
  assert.equal(resultOk(null), false)
  assert.equal(errorOf({ ok: false, error: 'boom' }), 'boom')
  assert.equal(errorOf({ ok: true }), undefined)
  assert.ok(errorOf(undefined, new Error('thrown')).startsWith('抛错: thrown'))
  assert.ok(errorOf(undefined, 'plain string').includes('plain string'))
  // JSON 退化指纹：完整解析的 JSON 必以 } / ] 结尾
  assert.equal(degradedParse('{"a":1}', { a: 1 }), false)
  assert.equal(degradedParse('[1,2] ', [1, 2]), false)
  assert.equal(degradedParse('garbage {x} tail', { x: 1 }), true)
  assert.equal(degradedParse('', { x: 1 }), true)
  assert.equal(degradedParse('garbage', null), false)   // 没解析出东西就不算退化
})

// ══════════════ 摘要层清洗账（镜像 summarizeScan） ══════════════

const SCAN_SAMPLE = {
  grand_total: 6 * 1024 * 1024,
  categories: [{ category: 'temp', total_size: 6 * 1024 * 1024, item_count: 3 }],
  details: {
    temp: {
      scan_time_ms: 120,
      items: [
        { path: 'C:\\Temp\\small', size: 1024, safety: 'safe', confidence: 0.95, recovery_cost: 'none' },
        { path: 'C:\\Temp\\big', size: 5 * 1024 * 1024, safety: 'safe', confidence: 0.9, recovery_cost: 'none' },
      ],
    },
    cache: { scan_time_ms: 30, items: [] },
    junk: null,
  },
}

/** 镜像锁定语料：含正常、空、脏、类型全错的上游样本（每一条都必须与 summarizeScan 对齐）。 */
const SHAPE_CORPUS = [
  ['正常样本', SCAN_SAMPLE],
  ['空对象', {}],
  ['details 为空', { details: {} }],
  ['null 根', null],
  ['undefined 根', undefined],
  ['字符串根（CLI 吐了半截文本）', 'Too many parameters - scan'],
  ['数字根', 5],
  ['数组根', [{ items: [{ path: 'p', size: 1 }] }]],
  ['details 全脏（null/数字/字符串/缺 items/items 非数组）', {
    details: { a: null, b: 5, c: 'str', d: {}, e: { items: 'x' }, f: { items: [] }, g: { items: [null, 5, { path: 'z', size: 3 }] } },
  }],
  ['details 是数组', { details: [{ items: [{ path: 'q', size: 2 }] }] }],
  ['categories 非数组', { categories: 42, details: { x: { items: [{ path: 'p', size: 1 }] } } }],
]

for (const [name, raw] of SHAPE_CORPUS) {
  test(`analyzeScanShape 镜像锁定：${name} → itemsKept 必须等于 summarizeScan().total_items`, () => {
    const shape = analyzeScanShape(raw)
    const summary = summarizeScan(raw, 10)
    assert.equal(shape.itemsKept, summary.total_items, 'itemsKept 与 summarizeScan 的账必须一致')
    assert.equal(
      Object.values(shape.dropReasons).reduce((s, n) => s + n, 0),
      shape.detailsDropped,
      '丢弃依据分布之和必须等于丢弃条目数（逐条可归因）',
    )
    assert.equal(shape.detailsOk + shape.detailsDropped, shape.detailsKeys)
    assert.equal(shape.itemsUnknown, shape.detailsDropped)
    assert.equal(shape.rawKind, kindOf(raw))
  })
}

test('analyzeScanShape: 脏数据的丢失去向与依据逐条可见（真缺陷的可见面）', () => {
  const shape = analyzeScanShape({
    details: { a: null, b: 5, c: { items: 'x' }, d: { items: [{ size: 1 }] } },
    categories: 'not-an-array',
  })
  assert.equal(shape.detailsKeys, 4)
  assert.equal(shape.detailsOk, 1)
  assert.equal(shape.detailsDropped, 3)
  assert.deepEqual(shape.dropReasons, { 'detail-null': 1, 'detail-not-object': 1, 'items-not-array': 1 })
  assert.equal(shape.itemsKept, 1)
  assert.equal(shape.scanTimeSkipped, 1)          // 只有 null/undefined 会被求和静默跳过
  assert.equal(shape.categoriesIsArray, false)
  assert.equal(shape.categoriesCount, 0)
  assert.equal(shape.categoriesDirty, 0)
})

test('analyzeScanShape: categories 数组但元素脏 → 计数可见（分类名取不到）', () => {
  const shape = analyzeScanShape({ categories: [null, { category: 'x' }, 5], details: {} })
  assert.equal(shape.categoriesIsArray, true)
  assert.equal(shape.categoriesCount, 3)
  assert.equal(shape.categoriesDirty, 2)
})

test('analyzeScanShape: 幂等且不改写输入（观测层不得有副作用）', () => {
  const raw = { details: { a: null, b: { items: [{ size: 1 }], scan_time_ms: 5 } }, categories: [{ category: 'c' }] }
  const snapshot = JSON.stringify(raw)
  const first = analyzeScanShape(raw)
  const second = analyzeScanShape(raw)
  assert.deepEqual(first, second)
  assert.equal(JSON.stringify(raw), snapshot)
})

test('summaryShapeOf: 从摘要产出取 Q4 读数（脏数据 → 0，不抛）', () => {
  const s = summarizeScan(SCAN_SAMPLE, 1)
  const shape = summaryShapeOf(s)
  assert.equal(shape.total_items, 2)
  assert.equal(shape.categories, 1)
  assert.equal(shape.top_items, 1)
  assert.equal(shape.scan_time_ms, 150)
  assert.deepEqual(summaryShapeOf(null), { total_items: 0, categories: 0, top_items: 0, scan_time_ms: 0 })
  assert.deepEqual(summaryShapeOf('x'), { total_items: 0, categories: 0, top_items: 0, scan_time_ms: 0 })
})

// ══════════════ 轨迹行合成 / 序列化 / 解析 / 落盘 ══════════════

test('composeCallEntry: 五问齐备（op/args/duration/ok/count/outKeys），destructive 只在关闭预览时出现', () => {
  const entry = composeCallEntry({
    now: 1, ...BASE, op: 'clyan_scan', args: { mode: 'quick' }, durationMs: 12,
    result: { ok: true, result: { total_items: 3, top_items: [] } },
  })
  assert.equal(entry.phase, 'call')
  assert.equal(entry.args, 'mode=quick')
  assert.equal(entry.durationMs, 12)
  assert.equal(entry.ok, true)
  assert.equal(entry.count, 3)
  assert.equal(entry.outKeys, 'total_items,top_items')
  assert.equal('destructive' in entry, false)
  const dry = composeCallEntry({
    now: 1, ...BASE, op: 'clyan_clean', args: { dryRun: false, yes: true }, durationMs: 1, result: { ok: true },
  })
  assert.equal(dry.destructive, true)
  const preview = composeCallEntry({
    now: 1, ...BASE, op: 'clyan_clean', args: {}, durationMs: 1, result: { ok: true },
  })
  assert.equal('destructive' in preview, false)
})

test('composeCliEntry: 记上游形状（verb/argv/字符数/解析形态/退化/耗时），不记 stdout 内容', () => {
  const entry = composeCliEntry({
    now: 1, ...BASE, argv: ['scan', 'quick', '--path', 'C:\\'],
    durationMs: 900, result: { ok: true, data: { a: 1 }, raw: '{"a":1}', stderr: '' },
  })
  assert.equal(entry.verb, 'scan')
  assert.equal(entry.argvLen, 4)
  assert.equal(entry.exitOk, true)
  assert.equal(entry.rawChars, 7)
  assert.equal(entry.parsed, 'object')
  assert.equal(entry.degraded, false)
  assert.equal(entry.stderrChars, 0)
  assert.equal('error' in entry, false)
  // stdout 内容不得进轨迹
  assert.equal(serializeTraceEntry(entry).includes('"a":1'), false)
  // 失败路径：stderr 进 error（脱敏 + 截断）
  const bad = composeCliEntry({
    now: 1, ...BASE, argv: ['pulse'], durationMs: 5,
    result: { ok: false, data: null, raw: '', stderr: 'password=hunter2 boom' },
  })
  assert.ok(bad.error.includes('password=[redacted]'))
  assert.equal(bad.parsed, 'null')
})

test('composeBootEntry: 版本构建自报 + 配置 + 工具面（主目录折叠）', () => {
  const entry = composeBootEntry({
    now: 1, ...BASE, path: 'C:\\Users\\tr\\.dsh\\clyan-trace.jsonl',
    cfg: { clyanBin: 'C:\\Users\\tr\\bin\\clyan.exe', timeoutMs: 180000, defaultPath: 'C:\\', tools: ['a', 'b'] },
    home: 'C:\\Users\\tr',
  })
  assert.equal(entry.phase, 'boot')
  assert.equal(entry.tools.length, 2)
  assert.equal(entry.cfg.defaultPath, 'C:\\')
  assert.equal(entry.cfg.timeoutMs, 180000)
  assert.ok(entry.cfg.clyanBin.startsWith('<home>'))
  assert.ok(entry.tracePath.startsWith('<home>'))
  assert.equal(entry.durationMs, 0)
})

test('composeScanShapeEntry: 清洗账 + 摘要产出同屏（Q4 一眼可读）', () => {
  const summary = summarizeScan(SCAN_SAMPLE, 10)
  const entry = composeScanShapeEntry({ now: 1, ...BASE, op: 'clyan_scan', raw: SCAN_SAMPLE, summary, durationMs: 3 })
  assert.equal(entry.shape.itemsKept, 2)
  assert.equal(entry.shape.detailsDropped, 1)
  assert.deepEqual(entry.shape.dropReasons, { 'detail-null': 1 })
  assert.equal(entry.summary.total_items, 2)
  assert.equal(entry.summary.scan_time_ms, 150)
})

test('serializeTraceEntry: 单行 + 键序固定 + 未用字段不出现', () => {
  const line = serializeTraceEntry(composeCallEntry({
    now: 1, ...BASE, op: 'clyan_pulse', args: {}, durationMs: 0, result: { ok: true },
  }))
  assert.equal(line.includes('\n'), false)
  assert.deepEqual(Object.keys(JSON.parse(line)), [
    'atMs', 'phase', 'build', 'pid', 'op', 'args', 'durationMs', 'ok', 'outKeys',
  ])
})

test('parseTraceEntries: 坏行/半行/空行/null/数字一律跳过；readTraceEntries 缺失/误读返回空数组', () => {
  const good = serializeTraceEntry(composeCallEntry({ now: 1, ...BASE, op: 'x', args: {}, durationMs: 0, result: { ok: true } }))
  const text = ['', good, '   ', '{"atMs":1,"phase":"call"', '{"phase":"call"}', 'null', '0', 'nope', '[]'].join('\n')
  const parsed = parseTraceEntries(text)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].op, 'x')
  assert.deepEqual(readTraceEntries(join(tmp, 'nope', 'clyan-trace.jsonl')), [])
  assert.deepEqual(readTraceEntries(tmp), [])            // 目录当文件读 → 空数组
  assert.deepEqual(parseTraceEntries(''), [])
})

test('appendTraceEntry/clyanTrace: 追加可回读；enabled=false 不写；路径缺省锚定 home', () => {
  const home = join(tmp, 'home')
  const path = clyanTracePath(home)
  assert.equal(clyanTrace(composeCallEntry({ now: 1, ...BASE, op: 'a', args: {}, durationMs: 1, result: { ok: true } }), { home }), true)
  assert.equal(clyanTrace(composeCallEntry({ now: 2, ...BASE, op: 'b', args: {}, durationMs: 2, result: { ok: true } }), { home }), true)
  assert.equal(clyanTrace(composeCallEntry({ now: 3, ...BASE, op: 'c', args: {}, durationMs: 3, result: { ok: true } }), { home, enabled: false }), false)
  const back = readTraceEntries(path)
  assert.deepEqual(back.map((e) => e.op), ['a', 'b'])
  assert.deepEqual(back.map((e) => e.atMs), [1, 2])       // now 可注入 → 断言确定
  // 目录自动创建（首次写入也能落盘）
  assert.equal(readTraceEntries(join(tmp, 'fresh', 'deep', 'clyan-trace.jsonl')).length, 0)
  assert.equal(appendTraceEntry(join(tmp, 'fresh', 'deep', 'clyan-trace.jsonl'), back[0]), true)
  assert.equal(readTraceEntries(join(tmp, 'fresh', 'deep', 'clyan-trace.jsonl')).length, 1)
})

test('尸体测试：父路径是普通文件 → appendTraceEntry/clyanTrace 返回 false 且不抛', () => {
  const blocker = join(tmp, 'blocker')
  writeFileSync(blocker, 'not a dir', 'utf8')
  const path = join(blocker, 'clyan-trace.jsonl')
  assert.doesNotThrow(() => {
    assert.equal(appendTraceEntry(path, composeCallEntry({ now: 1, ...BASE, op: 'x', args: {}, durationMs: 0, result: { ok: true } })), false)
    assert.equal(clyanTrace(composeCallEntry({ now: 1, ...BASE, op: 'x', args: {}, durationMs: 0, result: { ok: true } }), { path }), false)
  })
  // 观测失败不得产生任何半截产物
  assert.equal(readTraceEntries(path).length, 0)
})

// ══════════════ 隐私尸体测试（喂凭据 → 断言一个字都没落盘） ══════════════

test('隐私尸体测试：凭据/口令/token/用户名主目录/items 载荷内容 一个字都不许落盘', () => {
  const path = join(tmp, 'privacy', 'clyan-trace.jsonl')
  const home = 'C:\\Users\\alice-secret-user'
  const secrets = [
    'hunter2-must-not-land',
    'tok-must-not-land',
    'AKIAIOSFODNN7EXAMPLE',
    'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    'alice-secret-user',
    'leak-me-payload',
  ]
  const args = {
    path: home + '\\AppData\\Local\\Temp',
    reason: 'password=hunter2-must-not-land token=tok-must-not-land AKIAIOSFODNN7EXAMPLE ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    items: '[{"path":"C:\\\\x","why":"leak-me-payload"}]',
    password: 'must-not-land-either',
    apiKey: 'must-not-land-either-2',
  }
  assert.equal(clyanTrace(composeCallEntry({ now: 1, ...BASE, op: 'clyan_trust', args, durationMs: 1, result: { ok: true }, home }), { path }), true)
  assert.equal(clyanTrace(composeCliEntry({
    now: 2, ...BASE, argv: ['trust', 'add', home + '\\x', '--reason', args.reason], durationMs: 1,
    result: { ok: false, data: null, raw: '', stderr: 'auth failed: password=hunter2-must-not-land' },
    home,
  }), { path }), true)
  const raw = readFileSync(path, 'utf8')
  for (const secret of secrets) {
    assert.equal(raw.includes(secret), false, secret + ' 泄漏进了轨迹！')
  }
  // 反面证据：脱敏确实**跑过**（否则上面可能只是「整键没记」造成的假通过）
  assert.ok(raw.includes('password=[redacted]'))
  assert.ok(raw.includes('<home>'))
  assert.ok(raw.includes('<payload: json[1]>'))          // items 只留形状
  // 业务参数保留（排障要看）
  assert.ok(raw.includes('reason='))
})

test('隐私：主目录真实前缀在任何字段里都不出现（含 JSON 转义形态）', () => {
  const path = join(tmp, 'privacy2', 'clyan-trace.jsonl')
  const realHome = homedir()
  clyanTrace(composeCallEntry({
    now: 1, ...BASE, op: 'clyan_scan', args: { path: join(realHome, 'secret-dir') }, durationMs: 1, result: { ok: true },
  }), { path })
  clyanTrace(composeBootEntry({
    now: 1, ...BASE, path, cfg: { clyanBin: join(realHome, 'bin', 'clyan.exe'), timeoutMs: 1000, defaultPath: realHome, tools: [] },
  }), { path })
  const raw = readFileSync(path, 'utf8')
  const escaped = JSON.stringify(realHome).slice(1, -1)   // JSON 里的转义形态（Windows 双反斜杠）
  assert.equal(raw.includes(escaped), false, '主目录前缀泄漏：' + escaped)
  assert.ok(raw.includes('<home>'))
})

// ══════════════ 单点收口：包装器 ══════════════

test('wrapToolExecute 正常路径：返回值原样透出 + 落一行 call（注入时钟）', async () => {
  const path = join(tmp, 'wrap', 'clyan-trace.jsonl')
  // 注入时钟：包装体调用 now() **恰好两次**（startedAtMs / durationMs）；atMs 直接取 startedAtMs
  const times = [100, 350]
  const wrapped = wrapToolExecute('clyan_scan', async (args) => ({ ok: true, result: { total_items: args?.n ?? 0 } }), {
    path, build: 'b@1', pid: 9, now: () => times.shift() ?? 350,
  })
  const result = await wrapped({ n: 2 }, {})
  assert.deepEqual(result, { ok: true, result: { total_items: 2 } })
  const lines = readTraceEntries(path)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].phase, 'call')
  assert.equal(lines[0].op, 'clyan_scan')
  assert.equal(lines[0].durationMs, 250)                  // 350 - 100
  assert.equal(lines[0].ok, true)
  assert.equal(lines[0].count, 2)
  assert.equal(lines[0].pid, 9)
  assert.equal(lines[0].build, 'b@1')
})

test('wrapToolExecute 失败路径：只记一行 + 业务异常原样重抛（类型与文案不变）', async () => {
  const path = join(tmp, 'wrap-fail', 'clyan-trace.jsonl')
  const boom = new TypeError('cannot read properties of null')
  const wrapped = wrapToolExecute('clyan_clean', async () => { throw boom }, { path, build: 'b@1', pid: 9, now: () => 1 })
  await assert.rejects(() => wrapped({ dryRun: false, yes: true }, {}), (err) => {
    assert.equal(err, boom, '必须重抛**同一个**异常对象（不得换类型/新实例）')
    assert.equal(err instanceof TypeError, true)
    assert.equal(err.message, 'cannot read properties of null')
    return true
  })
  const lines = readTraceEntries(path)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].ok, false)
  assert.equal(lines[0].destructive, true)
  assert.ok(lines[0].error.includes('cannot read properties of null'))
})

test('wrapToolExecute 尸体测试：不可写路径下返回值照常、不抛、不改写结果', async () => {
  const blocker = join(tmp, 'blocker')
  const wrapped = wrapToolExecute('clyan_pulse', async () => ({ ok: true, result: { free_gb: 1 } }), {
    path: join(blocker, 'clyan-trace.jsonl'), build: 'b@1', now: () => 1,
  })
  assert.deepEqual(await wrapped({}, {}), { ok: true, result: { free_gb: 1 } })
  const missing = wrapToolExecute('clyan_pulse', undefined, { path: join(tmp, 'x.jsonl'), build: 'b@1', now: () => 1 })
  assert.equal(await missing({}, {}), undefined)          // 无 execute 的退化输入不抛
})

test('instrumentTool: 只替换 execute，其余字段（含 required 参数 schema）原样透传', () => {
  const path = join(tmp, 'instrument', 'clyan-trace.jsonl')
  const original = {
    name: 'clyan_undo',
    description: 'd',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    output: { schema: { type: 'object' }, render: () => [] },
    async execute(args) { return { ok: true, echoed: args?.id } },
  }
  const wrapped = instrumentTool(original, { path, build: 'b@1', pid: 3, now: () => 7 })
  assert.deepEqual(wrapped.parameters, original.parameters, '参数 schema 必须原样（不得二次编译丢失 required）')
  assert.equal(wrapped.output, original.output)
  assert.equal(wrapped.name, 'clyan_undo')
  assert.equal(wrapped.description, 'd')
  assert.notEqual(wrapped.execute, original.execute)
  assert.equal(original.execute === wrapped.execute, false)
})

test('instrumentTool: 包装体真实记录一次调用（结构相同 = 薄委托，不逐位比对时钟）', async () => {
  const path = join(tmp, 'instrument2', 'clyan-trace.jsonl')
  const wrapped = instrumentTool({
    name: 'clyan_pulse',
    output: { schema: {}, render: () => [] },
    async execute(args) { return { ok: true, got: args } },
  }, { path, build: 'b@1', pid: 3 })
  const out = await wrapped.execute({ path: 'C:\\' }, {})
  assert.deepEqual(out, { ok: true, got: { path: 'C:\\' } })
  const lines = readTraceEntries(path)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].op, 'clyan_pulse')
  assert.ok(Number.isFinite(lines[0].atMs) && lines[0].atMs > 0)   // 真实时钟：只断言「是个数」，不做整对象比对
  assert.equal(lines[0].build, 'b@1')
})

test('cleanup', () => {
  rmSync(tmp, { recursive: true, force: true })
})
