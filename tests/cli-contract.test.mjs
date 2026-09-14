/**
 * CLI argv 安全契约套件（I1「删除类默认预览」）+ **尸体测试**。
 *
 * 为什么不是照抄 dsh-search-pro 的 ESM 契约守卫：那是 search-pro 自己的不变量。
 * **dsh-clyan 自己的不变量在 argv 层**——本插件只是 clyan CLI 的 argv 构造层，它唯一能
 * 自主保证的安全性质就是「默认不真删」：
 *   - `dryRun !== false` ⇒ argv 必含 `--dry-run`（**显式 false 才可能真删**，不是「falsy 就真删」）
 *   - `--yes` 出现 ⟺ 调用方显式 `yes: true`（类型不符如 `'true'`/`1` 一律保守不带）
 *
 * 尸体测试（防「空转的守卫」）：用**已知坏 argv** 喂同一个检查器，断言它真的会拦——
 * 否则这些断言可能只是在检查空气。
 *
 * ⚠ 完全离线：只调用纯函数构造 argv，**不执行任何 CLI、不碰真实磁盘**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCleanArgs, buildReclaimArgs } from '../lib/logic.js'

const DESTRUCTIVE = new Set(['clean', 'reclaim'])

/** 检查器 A：删除类动词在未显式要求真删时，必须带 --dry-run */
function assertDryRunPresent(argv) {
  const verb = argv[0]
  assert.ok(DESTRUCTIVE.has(verb), `本检查器只适用于删除类动词，收到：${verb}`)
  assert.ok(argv.includes('--dry-run'), `${verb} 缺少 --dry-run（默认必须预览）：${argv.join(' ')}`)
}

/** 检查器 B：--yes 出现 ⟺ 调用方显式 yes:true */
function assertYesGated(argv, args) {
  assert.equal(
    argv.includes('--yes'),
    args.yes === true,
    `${argv[0]} 的 --yes 与入参 yes=${JSON.stringify(args.yes)} 不一致：${argv.join(' ')}`,
  )
}

// ══════════════ 尸体测试：先证明检查器不空转 ══════════════

test('尸体测试：检查器 A 对「默认已真删」的坏 argv 确实抛错', () => {
  // 已知坏样本：clean 不带 --dry-run（= 在真实 CLI 上就是删文件）
  assert.throws(() => assertDryRunPresent(['clean', '--items', '[]']), /缺少 --dry-run/)
  assert.throws(() => assertDryRunPresent(['reclaim']), /缺少 --dry-run/)
  // 已知好样本：带 --dry-run 必须放行，否则检查器是「恒抛」而非「会拦」
  assert.doesNotThrow(() => assertDryRunPresent(['clean', '--dry-run']))
})

test('尸体测试：检查器 B 对「无授权却带 --yes」的坏 argv 确实抛错', () => {
  assert.throws(() => assertYesGated(['clean', '--yes'], {}), /--yes 与入参/)
  assert.throws(() => assertYesGated(['clean', '--yes'], { yes: 'true' }), /--yes 与入参/)
  assert.doesNotThrow(() => assertYesGated(['clean', '--yes'], { yes: true }))
  assert.doesNotThrow(() => assertYesGated(['clean', '--dry-run'], {}))
})

// ══════════════ I1 不变量：真实构造函数的默认路径 ══════════════

test('I1（clean）：不传 dryRun / 传 dryRun:true ⇒ 必带 --dry-run 且不带 --yes', () => {
  const a = buildCleanArgs({})
  const b = buildCleanArgs({ dryRun: true })
  assert.deepEqual(a, ['clean', '--dry-run'])
  assert.deepEqual(b, a)
  assertDryRunPresent(a)
  assert.equal(a.includes('--yes'), false)
  assertYesGated(a, {})
})

test('I1（clean）：yes:true 但 dryRun 未显式 false ⇒ 仍是预览（--dry-run 与 --yes 并存）', () => {
  // 关键语义：--yes 只是「跳过 CLI 交互确认」，不解除插件的默认预览
  const argv = buildCleanArgs({ yes: true })
  assert.deepEqual(argv, ['clean', '--dry-run', '--yes'])
  assertDryRunPresent(argv)
  assertYesGated(argv, { yes: true })
})

test('I1（reclaim）：同款默认预览语义', () => {
  assert.deepEqual(buildReclaimArgs({}), ['reclaim', '--dry-run'])
  assert.deepEqual(buildReclaimArgs({ dryRun: true }), ['reclaim', '--dry-run'])
  assert.deepEqual(buildReclaimArgs({ yes: true }), ['reclaim', '--dry-run', '--yes'])
  assertDryRunPresent(buildReclaimArgs({ phase: 'none' }))
})

test('I1 真删路径必须双重显式：dryRun:false + yes:true 才同时去掉 --dry-run 并带上 --yes', () => {
  const clean = buildCleanArgs({ dryRun: false, yes: true })
  const reclaim = buildReclaimArgs({ dryRun: false, yes: true })
  assert.equal(clean.includes('--dry-run'), false)
  assert.equal(clean.includes('--yes'), true)
  assert.equal(reclaim.includes('--dry-run'), false)
  assert.equal(reclaim.includes('--yes'), true)
  assertYesGated(clean, { dryRun: false, yes: true })
  assertYesGated(reclaim, { dryRun: false, yes: true })
})

test('I1 类型不符的退化输入一律保守：yes/autoSafe 非严格 true 不带标志', () => {
  // 传入字符串/数字（类型不符）时，`=== true` 判据必须保守拒绝，不得「truthy 即放行」
  for (const bad of ['true', 1, {}, [], 'yes']) {
    const argv = buildCleanArgs({ yes: bad })
    assert.equal(argv.includes('--yes'), false, `yes=${JSON.stringify(bad)} 不应触发 --yes`)
  }
  for (const bad of ['true', 1, 'auto']) {
    assert.equal(buildCleanArgs({ autoSafe: bad }).includes('--auto-safe'), false)
  }
  // dryRun 判据是 `!== false`：undefined/null/0/'' 都仍然预览（不是 falsy 就真删）
  for (const bad of [undefined, null, 0, '', 'false']) {
    assert.ok(buildCleanArgs({ dryRun: bad }).includes('--dry-run'))
    assert.ok(buildReclaimArgs({ dryRun: bad }).includes('--dry-run'))
  }
})

// ══════════════ argv 装配契约（顺序 + 空值忽略 + 边界） ══════════════

test('clean argv 全参数装配顺序锁定（搬家不得改语义）', () => {
  const argv = buildCleanArgs({
    items: '[]', dryRun: false, autoSafe: true, deep: true, strategy: 'safe',
    minConfidence: 90, path: 'C:\\', yes: true, safety: 'safe',
  })
  assert.deepEqual(argv, [
    'clean', '--items', '[]', '--auto-safe', '--deep', '--strategy', 'safe',
    '--min-confidence', '90', '--path', 'C:\\', '--yes', '--safety', 'safe',
  ])
})

test('reclaim argv 全参数装配顺序锁定', () => {
  assert.deepEqual(
    buildReclaimArgs({ phase: 'low', dryRun: false, yes: true, path: 'D:\\' }),
    ['reclaim', '--phase', 'low', '--yes', 'D:\\'],
  )
})

test('空白字符串参数被忽略（不产生空 flag / 空值对）', () => {
  assert.deepEqual(buildCleanArgs({ items: '   ', strategy: '  ', path: ' ', safety: '\t' }), ['clean', '--dry-run'])
  assert.deepEqual(buildReclaimArgs({ phase: '', path: '  ' }), ['reclaim', '--dry-run'])
})

test('边界值：minConfidence=0 是合法入参（不得因 falsy 被丢），phase 前后空格被 trim', () => {
  assert.deepEqual(buildCleanArgs({ minConfidence: 0 }), ['clean', '--dry-run', '--min-confidence', '0'])
  assert.deepEqual(buildReclaimArgs({ phase: ' none ' }), ['reclaim', '--phase', 'none', '--dry-run'])
  assert.deepEqual(buildCleanArgs({ items: ' [{"path":"p"}] ' }), ['clean', '--items', '[{"path":"p"}]', '--dry-run'])
})

test('幂等/无共享状态：重复调用与交叉调用得到相同 argv，且返回值互不影响', () => {
  const first = buildCleanArgs({ path: 'C:\\' })
  const second = buildCleanArgs({ path: 'C:\\' })
  assert.deepEqual(first, second)
  first.push('--污染')
  assert.deepEqual(buildCleanArgs({ path: 'C:\\' }), second)   // 内部无共享数组
  assert.deepEqual(buildCleanArgs({}), ['clean', '--dry-run'])
})

test('clean 与 reclaim 的动词/标志面互不串味（无标志泄漏）', () => {
  const clean = buildCleanArgs({})
  assert.equal(clean[0], 'clean')
  for (const forbidden of ['--phase', '--auto-safe', '--deep', '--safety', '--min-confidence', '--items']) {
    assert.equal(clean.includes(forbidden), false)
  }
  const reclaim = buildReclaimArgs({})
  assert.equal(reclaim[0], 'reclaim')
  for (const forbidden of ['--auto-safe', '--deep', '--strategy', '--items']) {
    assert.equal(reclaim.includes(forbidden), false)
  }
})
