/**
 * logic.ts 纯函数套件（**完全离线**：零 IO、零子进程、零真实磁盘扫描）。
 *
 * ⚠ 本插件是磁盘清理工具——测试**只用构造的假数据**，绝不对真实磁盘跑扫描/删除类操作。
 *
 * 覆盖：正常路径 + 失败/退化路径（空值 / 非法类型 / 缺字段的损坏对象 / 边界值 / 幂等性）——
 * 后者是 S6 判据「测试是否锁住失败路径」的实体证据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  asArray, humanSize, cliError, collectItems, summarizeScan, summarizeDeep,
  filterSmartCandidates, smartClearPayload,
} from '../lib/logic.js'

// ══════════════ humanSize ══════════════

test('humanSize: 单位换算（B/KB/MB/GB/TB）', () => {
  assert.equal(humanSize(0), '0 B')
  assert.equal(humanSize(512), '512.0 B')
  assert.equal(humanSize(1024), '1.0 KB')
  assert.equal(humanSize(1536), '1.5 KB')
  assert.equal(humanSize(1024 * 1024), '1.0 MB')
  assert.equal(humanSize(1024 ** 3), '1.0 GB')
  assert.equal(humanSize(1024 ** 4), '1.0 TB')
  // 越界：超过 TB 不再进位，数值继续增长（真实语义，不是 bug）
  assert.equal(humanSize(1024 ** 5), '1024.0 TB')
})

test('humanSize: 退化输入（NaN / null / undefined / 负数 / Infinity）不抛', () => {
  // NaN 与 null/undefined 都是 falsy → 走 `!bytes` 分支 → '0 B'
  assert.equal(humanSize(NaN), '0 B')
  assert.equal(humanSize(null), '0 B')
  assert.equal(humanSize(undefined), '0 B')
  // 负数：不进循环 → 原样带符号输出（**如实记录**：曾误以为会抛或归零）
  assert.equal(humanSize(-2048), '-2048.0 B')
  // Infinity：循环被 i<4 截住 → 输出 'Infinity TB'（不抛、不挂死）
  assert.equal(humanSize(Infinity), 'Infinity TB')
})

// ══════════════ cliError ══════════════

test('cliError: ok=true 恒为 null（即使 stderr 有噪音）', () => {
  assert.equal(cliError({ ok: true, data: { x: 1 }, raw: '{}', stderr: 'warning: noisy' }), null)
})

test('cliError: 失败路径——stderr 优先，其次 raw，最后兜底文案', () => {
  assert.equal(cliError({ ok: false, data: null, raw: '{"err":1}', stderr: 'boom' }), 'boom')
  assert.equal(cliError({ ok: false, data: null, raw: '<html>502</html>', stderr: '' }), '<html>502</html>')
  assert.equal(cliError({ ok: false, data: null, raw: '', stderr: '' }), 'clyan 执行失败')
})

test('cliError: 超长错误被截断到 500 字符（防污染上下文）', () => {
  const long = 'x'.repeat(600)
  const msg = cliError({ ok: false, data: null, raw: '', stderr: long })
  assert.equal(msg.length, 500)
  assert.equal(msg, 'x'.repeat(500))
})

test('cliError: 边界——纯空白 stderr 视为「有内容」（只判空串，不 trim）', () => {
  assert.equal(cliError({ ok: false, data: null, raw: 'raw-fallback', stderr: '   ' }), '   ')
})

test('cliError: 损坏输入（缺字段的对象）走兜底分支，不抛', () => {
  assert.equal(cliError({ ok: false }), 'clyan 执行失败')
  assert.equal(cliError({ ok: false, data: null, raw: null, stderr: null }), 'clyan 执行失败')
})

// ══════════════ collectItems ══════════════

test('collectItems: 汇总 details.<cat>.items 并打上 _category', () => {
  const scan = {
    details: {
      temp: { items: [{ path: 'C:\\Temp\\a.tmp', size: 2048 }] },
      cache: { items: [{ path: 'C:\\Cache\\b', size: 4096 }, { path: 'C:\\Cache\\c', size: 1 }] },
    },
  }
  const items = collectItems(scan)
  assert.equal(items.length, 3)
  assert.deepEqual(items[0], { path: 'C:\\Temp\\a.tmp', size: 2048, _category: 'temp' })
  assert.equal(items[1]._category, 'cache')
  assert.equal(items[2]._category, 'cache')
})

test('collectItems: 退化输入（null / {} / details 非对象 / 分类缺 items）一律空数组且不抛', () => {
  assert.deepEqual(collectItems(null), [])
  assert.deepEqual(collectItems(undefined), [])
  assert.deepEqual(collectItems({}), [])
  assert.deepEqual(collectItems({ details: null }), [])
  assert.deepEqual(collectItems({ details: 'junk' }), [])
  assert.deepEqual(collectItems({ details: { temp: {} } }), [])
  assert.deepEqual(collectItems({ details: { temp: { items: 'not-an-array' } } }), [])
})

test('collectItems: 脏数据容错——分类值为 null/非法时跳过，不整体崩', () => {
  const scan = { details: { good: { items: [{ path: 'x', size: 1 }] }, junk: null, alsoJunk: 42 } }
  const items = collectItems(scan)
  assert.equal(items.length, 1)
  assert.equal(items[0]._category, 'good')
})

test('collectItems: 纯函数语义——不修改输入项，且 _category 覆盖输入自带值', () => {
  const original = { path: 'p', size: 8, _category: 'fake' }
  const items = collectItems({ details: { real: { items: [original] } } })
  assert.equal(original._category, 'fake')      // 输入未被就地改写
  assert.equal(items[0]._category, 'real')      // 输出以真实分类覆盖
  assert.notEqual(items[0], original)           // 是新对象（浅拷贝）
})

// ══════════════ summarizeScan ══════════════

const SCAN_SAMPLE = {
  grand_total: 6 * 1024 * 1024,
  categories: [{ category: 'temp', total_size: 6 * 1024 * 1024, item_count: 3 }],
  details: {
    temp: {
      scan_time_ms: 120,
      items: [
        { path: 'C:\\Temp\\small', size: 1024, safety: 'safe', confidence: 0.95, recovery_cost: 'none', reason: 'temp 目录' },
        { path: 'C:\\Temp\\big', size: 5 * 1024 * 1024, safety: 'safe', confidence: 0.9, recovery_cost: 'none' },
        { path: 'C:\\Temp\\risky', size: 1024 * 1024, safety: 'caution', confidence: 0.5, recovery_cost: 'high' },
      ],
    },
    cache: { scan_time_ms: 30, items: [] },
  },
}

test('summarizeScan: 正常路径——总数/分类/安全分布/top 排序与截断', () => {
  const s = summarizeScan(SCAN_SAMPLE, 2)
  assert.equal(s.grand_total_human, '6.0 MB')
  assert.equal(s.total_items, 3)
  assert.equal(s.scan_time_ms, 150)                       // details.<cat>.scan_time_ms 求和
  assert.deepEqual(s.categories, [{ category: 'temp', total_size_human: '6.0 MB', item_count: 3 }])
  assert.deepEqual(s.safety_distribution, {
    safe: { count: 2, size_human: '5.0 MB' },
    caution: { count: 1, size_human: '1.0 MB' },
  })
  assert.equal(s.top_items.length, 2)                     // topN=2 截断
  assert.equal(s.top_items[0].path, 'C:\\Temp\\big')      // 按 size 降序
  assert.equal(s.top_items[1].path, 'C:\\Temp\\risky')
  assert.equal(s.top_items[1].recovery_cost, 'high')
  assert.equal(s.top_items[0].reason, '')                 // 缺 reason → 空串
})

test('summarizeScan: 摘要字段不含全量 items（I3 大输出降级）', () => {
  const s = summarizeScan(SCAN_SAMPLE, 10)
  assert.equal('details' in s, false)
  assert.equal('items' in s, false)
})

test('summarizeScan: 退化路径——空数组/空对象/纯 null 输入都返回零值摘要且不抛', () => {
  for (const bad of [null, undefined, {}, { details: {} }, { details: { temp: { items: [] } } }]) {
    const s = summarizeScan(bad, 10)
    assert.equal(s.total_items, 0)
    assert.equal(s.grand_total_human, '0 B')
    assert.deepEqual(s.categories, [])
    assert.deepEqual(s.safety_distribution, {})
    assert.deepEqual(s.top_items, [])
    assert.equal(s.scan_time_ms, 0)
  }
})

test('summarizeScan: 脏数据（损坏的 details 条目）不再抛 TypeError——本次修正的行为', () => {
  // 修正前：Object.values(details).reduce((s,d) => s + d.scan_time_ms) 在 d===null 时抛
  // TypeError: Cannot read properties of null。修正后：跳过脏条目，合法条目照常求和。
  const s = summarizeScan({ details: { junk: null, ok: { items: [], scan_time_ms: 7 } }, categories: null }, 3)
  assert.equal(s.scan_time_ms, 7)
  assert.deepEqual(s.categories, [])
})

test('summarizeScan: 越界/类型不符参数——topN=0、categories 非数组、缺 safety 桶', () => {
  const s0 = summarizeScan(SCAN_SAMPLE, 0)
  assert.deepEqual(s0.top_items, [])                       // topN=0 边界
  const sBad = summarizeScan({ categories: 42, details: {} }, 5)
  assert.deepEqual(sBad.categories, [])                    // 修正前此处抛 .map is not a function
  const sNoSafety = summarizeScan({ details: { x: { items: [{ path: 'p', size: 10 }] } } }, 5)
  assert.deepEqual(sNoSafety.safety_distribution, { unknown: { count: 1, size_human: '10.0 B' } })
})

test('summarizeScan: reason 超长截断到 80 字符、非字符串 reason 被 String() 归一', () => {
  const s = summarizeScan({ details: { x: { items: [
    { path: 'a', size: 3, reason: 'r'.repeat(200) },
    { path: 'b', size: 2, reason: 12345 },
    { path: 'c', size: 1, reason: 0 },
  ] } } }, 5)
  assert.equal(s.top_items[0].reason.length, 80)
  assert.equal(s.top_items[1].reason, '12345')
  assert.equal(s.top_items[2].reason, '')                  // 0 是 falsy → 空串
})

test('summarizeScan: 幂等——同一输入重复调用结果恒等且不改写输入', () => {
  const before = JSON.stringify(SCAN_SAMPLE)
  const a = summarizeScan(SCAN_SAMPLE, 3)
  const b = summarizeScan(SCAN_SAMPLE, 3)
  assert.deepEqual(a, b)
  assert.equal(JSON.stringify(SCAN_SAMPLE), before)
})

// ══════════════ summarizeDeep ══════════════

const DEEP_ACC = {
  dirs: [
    { path: 'C:\\Users\\tr\\AppData\\Local', size: 226 * 1024 ** 3, depth: 3, children: [
      { path: 'C:\\Users\\tr\\AppData\\Local\\PackageCache', size: 80 * 1024 ** 3, depth: 4, children: [] },
    ] },
    { path: 'C:\\Windows', size: 40 * 1024 ** 3, depth: 1, children: [] },
    { path: 'C:\\Temp', size: 1024, depth: 1, children: [] },
  ],
  files: [
    { path: 'C:\\big.iso', size: 9 * 1024 ** 3 },
    { path: 'C:\\small.log', size: 1024 },
  ],
}

test('summarizeDeep: 正常路径——大目录降序 + topN 截断 + 子目录 basename + 大文件 top10', () => {
  const s = summarizeDeep(DEEP_ACC, 300 * 1024 ** 3, 2)
  assert.equal(s.root_total_human, '300.0 GB')
  assert.equal(s.big_dirs.length, 2)
  assert.equal(s.big_dirs[0].path, 'C:\\Users\\tr\\AppData\\Local')
  assert.equal(s.big_dirs[0].size_human, '226.0 GB')
  assert.equal(s.big_dirs[0].depth, 3)
  assert.deepEqual(s.big_dirs[0].top_children, [{ name: 'PackageCache', size_human: '80.0 GB' }])
  assert.equal(s.big_files[0].path, 'C:\\big.iso')
  assert.equal(s.big_files[1].size_human, '1.0 KB')
})

test('summarizeDeep: 退化输入（空 acc / 空值 / 损坏对象）不抛，返回空地图', () => {
  const empty = summarizeDeep({ dirs: [], files: [] }, 0, 10)
  assert.deepEqual(empty, { root_total_human: '0 B', big_dirs: [], big_files: [] })
  assert.deepEqual(summarizeDeep(undefined, 0, 10).big_dirs, [])       // acc 缺失（修正前抛）
  assert.deepEqual(summarizeDeep({ dirs: null, files: 'junk' }, 0, 10).big_files, [])
})

test('summarizeDeep: 脏 children（缺字段 / null）退化为空子列表，不抛', () => {
  const s = summarizeDeep({ dirs: [{ path: 'C:\\x', size: 10, depth: 1 }], files: [] }, 10, 5)
  assert.deepEqual(s.big_dirs[0].top_children, [])
})

test('summarizeDeep: topN 边界——0 与负数（slice 语义：负数从尾部截）', () => {
  assert.equal(summarizeDeep(DEEP_ACC, 0, 0).big_dirs.length, 0)
  assert.equal(summarizeDeep(DEEP_ACC, 0, -1).big_dirs.length, 2)      // 3 个里砍掉最后一个
  assert.equal(summarizeDeep(DEEP_ACC, 0, 99).big_dirs.length, 3)      // 越界不报错
})

test('summarizeDeep: basename 提取兼容 Windows 与 POSIX 分隔符', () => {
  const s = summarizeDeep({ dirs: [
    { path: 'a', size: 3, depth: 0, children: [{ path: 'C:\\x\\win', size: 2, depth: 1, children: [] }] },
    { path: 'b', size: 2, depth: 0, children: [{ path: '/mnt/e/posix', size: 1, depth: 1, children: [] }] },
    { path: 'c', size: 1, depth: 0, children: [{ path: 'bare', size: 1, depth: 1, children: [] }] },
  ], files: [] }, 6, 5)
  assert.equal(s.big_dirs[0].top_children[0].name, 'win')
  assert.equal(s.big_dirs[1].top_children[0].name, 'posix')
  assert.equal(s.big_dirs[2].top_children[0].name, 'bare')
})

// ══════════════ filterSmartCandidates（插件唯一的实质安全裁决） ══════════════

test('filterSmartCandidates: 三重白名单命中（none + safe + confidence>=0.9）', () => {
  const items = [
    { path: 'a', size: 1, recovery_cost: 'none', safety: 'safe', confidence: 0.9 },
    { path: 'b', size: 2, recovery_cost: 'none', safety: 'safe', confidence: 0.99 },
  ]
  assert.deepEqual(filterSmartCandidates(items, 0.9).map((i) => i.path), ['a', 'b'])
})

test('filterSmartCandidates: 失败路径——任一条件不满足即保守拒绝', () => {
  const items = [
    { path: 'cost', recovery_cost: 'low', safety: 'safe', confidence: 1 },
    { path: 'safety', recovery_cost: 'none', safety: 'caution', confidence: 1 },
    { path: 'conf-low', recovery_cost: 'none', safety: 'safe', confidence: 0.89 },
    { path: 'conf-missing', recovery_cost: 'none', safety: 'safe' },
    { path: 'unknown-cost', recovery_cost: 'unknown', safety: 'safe', confidence: 1 },
  ]
  assert.deepEqual(filterSmartCandidates(items, 0.9), [])
})

test('filterSmartCandidates: 边界阈值——恰好 0.9 入选，0.9 以下拒绝；阈值 0 放行全部安全项', () => {
  const items = [{ path: 'x', size: 1, recovery_cost: 'none', safety: 'safe', confidence: 0.9 }]
  assert.equal(filterSmartCandidates(items, 0.9).length, 1)
  assert.equal(filterSmartCandidates(items, 0.9000001).length, 0)
  assert.equal(filterSmartCandidates(items, 0).length, 1)
})

test('filterSmartCandidates: 脏数据（null / 非对象 / 空数组 / 非数组）一律不入选且不抛', () => {
  assert.deepEqual(filterSmartCandidates([null, undefined, 42, 'x', {}], 0.9), [])
  assert.deepEqual(filterSmartCandidates([], 0.9), [])
  assert.deepEqual(filterSmartCandidates(null, 0.9), [])
  assert.deepEqual(filterSmartCandidates({ 0: { recovery_cost: 'none', safety: 'safe', confidence: 1 } }, 0.9), [])
})

test('filterSmartCandidates: 幂等且不改写输入（顺序保持原样）', () => {
  const items = [
    { path: 'second', size: 1, recovery_cost: 'none', safety: 'safe', confidence: 0.95 },
    { path: 'first', size: 9, recovery_cost: 'none', safety: 'safe', confidence: 0.95 },
  ]
  const snapshot = JSON.stringify(items)
  const a = filterSmartCandidates(items, 0.9)
  const b = filterSmartCandidates(items, 0.9)
  assert.deepEqual(a, b)
  assert.equal(a[0].path, 'second')            // 过滤不排序（排序是调用方的事）
  assert.equal(JSON.stringify(items), snapshot)
})

// ══════════════ smartClearPayload ══════════════

test('smartClearPayload: 只带 path/size，不泄漏判断字段（confidence/safety 不外传）', () => {
  const payload = smartClearPayload([
    { path: 'C:\\Temp\\a', size: 2048, safety: 'safe', confidence: 0.95, reason: 'x' },
  ])
  assert.deepEqual(payload, [{ path: 'C:\\Temp\\a', size: 2048 }])
})

test('smartClearPayload: 退化输入——缺 size 归零，空/非数组得空载荷', () => {
  assert.deepEqual(smartClearPayload([{ path: 'p' }]), [{ path: 'p', size: 0 }])
  assert.deepEqual(smartClearPayload([]), [])
  assert.deepEqual(smartClearPayload(null), [])
})

// ══════════════ asArray ══════════════

test('asArray: 数组原样（同引用），非数组一律空数组', () => {
  const arr = [1, 2]
  assert.equal(asArray(arr), arr)
  for (const bad of [null, undefined, 0, '', 'abc', {}, { length: 0 }, NaN]) {
    assert.deepEqual(asArray(bad), [])
  }
})
