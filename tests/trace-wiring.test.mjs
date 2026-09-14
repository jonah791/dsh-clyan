/**
 * 接线级证据测试（S4）：证明**真实调用路径**（挂载 `lib/index.js` → `reg`/`runCli`/`summarizeTraced`
 * → `trace.ts` → `<DSH_HOME>/clyan-trace.jsonl`）会落盘，而不是只有纯函数单测通过。
 *
 * 手法：用**临时 `DSH_HOME`** + 假 `ctx`（只实现 `tools.register` / `logger` / `effect`，并镜像宿主
 * `register()` 的前置校验）真实 `apply()` 本插件，然后调用工具定义里的 `execute`。
 * 全部写进临时目录，**不触碰真实 `.dsh`**，也不真删任何东西（CLI 假样本/不存在的二进制）。
 *
 * 覆盖：
 *   A 挂载 + boot 行 + 工具面契约（16 工具 / `required` 未被包装器弄丢）
 *   B 失败路径：CLI 不存在 → `cli` + `call` 两行，错误可判读
 *   C 成功路径（不依赖 CLI）：`clyan_space_deep` 的插件内 DFS
 *   D 摘要层清洗账（真缺陷的可见面）：上游给非 JSON → `scan-shape` 行
 *   E 真删标记：`clyan_clean dryRun=false + yes=true` → `destructive:true`
 *   F 隐私：真实落盘路径上喂凭据 → 一个字都不落盘
 *   G 尸体测试：轨迹不可写 → 业务照常、不抛
 *   H 静态守卫：单点收口（16 个 `reg` / 摘要层唯一入口 / DSH_HOME 单一真源）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { assertObjectJsonSchema, assertSupportedJsonSchema, parameterSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools'
import { apply } from '../lib/index.js'
import { readTraceEntries } from '../lib/trace.js'

const HERE = import.meta.dirname

/** 挂载插件（假 ctx：只实现本插件真正用到的三个面，并镜像宿主 register() 的校验）。 */
function mount(config) {
  const tools = []
  const ctx = {
    tools: {
      register(def) {
        assert.equal(typeof def?.name, 'string', 'register: name 必须是字符串')
        assert.equal(typeof def?.execute, 'function', String(def?.name) + ' 缺 execute（包装器丢了字段）')
        assert.equal(typeof def?.output?.render, 'function', String(def?.name) + ' 缺 output.render')
        assert.ok(def?.output?.schema !== undefined, String(def?.name) + ' 缺 output.schema')
        assert.equal(def?.parameters?.type, 'object', String(def?.name) + ' 参数 schema 不是 object 根')
        assert.equal(Array.isArray(def.parameters.required) || def.parameters.required === undefined, true)
        tools.push(def)
        return () => {}
      },
    },
    logger: () => ({ info() {}, warn() {}, error() {} }),
    effect(fn) { return fn() },
  }
  apply(ctx, { clyanBin: 'clyan', timeoutMs: 180000, defaultPath: 'C:\\', ...config })
  return { tools, byName: new Map(tools.map((t) => [t.name, t])) }
}

/** 每个场景：独立临时 root + 独立临时 DSH_HOME（互不污染）。 */
async function scenario(name, cfg, fn) {
  const root = mkdtempSync(join(tmpdir(), 'clyan-wire-' + name + '-'))
  const home = join(root, 'home')
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const mounted = mount({ defaultPath: root, ...cfg })
    await fn({ ...mounted, root, home, tracePath: join(home, 'clyan-trace.jsonl') })
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    rmSync(root, { recursive: true, force: true })
  }
}

/** 假 CLI：忽略未知参数且 **exit 0** 的可执行文件（Windows 用 tree.com 副本；POSIX 用 true）。 */
function makeStub() {
  if (process.platform !== 'win32') return '/bin/true'
  const src = 'C:/Windows/System32/tree.com'
  if (!existsSync(src)) return null
  const dir = mkdtempSync(join(tmpdir(), 'clyan-stub-'))
  const dst = join(dir, 'clyan-stub.exe')
  try {
    copyFileSync(src, dst)
    return dst
  } catch {
    return null
  }
}

const STUB = makeStub()
const MISSING = 'clyan-definitely-missing-xyz'

test('A 端到端：挂载 lib/index.js → boot 行落盘 + 工具面契约完整（16 工具 / required 未丢）', async () => {
  await scenario('boot', {}, async ({ tools, byName, tracePath }) => {
    const lines = readTraceEntries(tracePath)
    assert.equal(lines.length, 1)
    const boot = lines[0]
    assert.equal(boot.phase, 'boot')
    assert.match(boot.build, /^0\.1\.0@\d+$/)                    // Q1：进程级构建自报
    assert.equal(boot.pid, process.pid)                          // Q2：哪个进程
    assert.equal(boot.op, 'apply')
    assert.equal(boot.durationMs, 0)
    assert.equal(boot.tools.length, 16)                          // 工具面自报
    assert.equal(boot.cfg.timeoutMs, 180000)
    assert.equal(boot.cfg.defaultPath.endsWith('clyan-wire-boot-') === false, true)
    assert.equal(boot.tracePath.endsWith('clyan-trace.jsonl'), true)
    // 工具面契约（包装器必须原样透传字段）
    assert.equal(tools.length, 16)
    assert.deepEqual([...byName.get('clyan_undo').parameters.required], ['id'])
    assert.deepEqual(Object.keys(byName.get('clyan_scan').parameters.properties).sort(),
      ['detail', 'mode', 'path', 'phase', 'topN'])
    assert.deepEqual(Object.keys(byName.get('clyan_clean').parameters.properties).sort(),
      ['autoSafe', 'deep', 'dryRun', 'items', 'minConfidence', 'path', 'safety', 'strategy', 'yes'])
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'clyan_app_cache', 'clyan_auto_clear', 'clyan_clean', 'clyan_doctor', 'clyan_history', 'clyan_pulse',
      'clyan_reclaim', 'clyan_report', 'clyan_scan', 'clyan_schedule', 'clyan_smart_clear', 'clyan_space',
      'clyan_space_deep', 'clyan_trust', 'clyan_undo', 'clyan_verify',
    ])
    // 用**宿主自己的校验器**（不是我们的假 ctx）证明包装后的定义仍然是合法 ToolDefinition
    for (const t of tools) {
      assertSupportedJsonSchema(t.output.schema)
      assertObjectJsonSchema(t.parameters)
    }
    // 参数 schema 逐位等于「宿主编译器从同一份 spec 编出来的结果」——证明包装器**零损耗**
    assert.deepEqual(byName.get('clyan_undo').parameters, parameterSchemaSpecToJsonSchema({
      id: { type: 'string', required: true, description: '操作 ID（clyan_history 获取）' },
    }))
  })
})

test('B 端到端失败路径：CLI 不存在 → cli + call 两行，断点可判读', async () => {
  await scenario('nobin', { clyanBin: MISSING }, async ({ byName, tracePath }) => {
    const result = await byName.get('clyan_pulse').execute({ path: 'C:\\' }, {})
    assert.equal(result.ok, false)                                // 业务行为不变
    assert.match(result.error, /无法启动 clyan/)
    const lines = readTraceEntries(tracePath).slice(1)
    assert.deepEqual(lines.map((e) => e.phase), ['cli', 'call'])
    const [cli, call] = lines
    assert.equal(cli.op, 'runCli')
    assert.equal(cli.verb, 'pulse')
    assert.equal(cli.exitOk, false)
    assert.equal(cli.parsed, 'null')
    assert.equal(cli.rawChars, 0)
    assert.ok(cli.stderrChars > 0)
    assert.match(cli.error, /无法启动 clyan/)
    assert.equal(call.op, 'clyan_pulse')
    assert.equal(call.ok, false)
    assert.equal(call.args, 'path=C:\\')
    assert.equal(Number.isFinite(call.durationMs) && call.durationMs >= 0, true)
    assert.equal('destructive' in call, false)
  })
})

test('C 端到端成功路径：clyan_space_deep（插件内 DFS，不依赖 CLI）', async () => {
  await scenario('deep', { clyanBin: MISSING }, async ({ byName, tracePath, root }) => {
    const sub = join(root, 'tree')
    mkdirSync(join(sub, 'child'), { recursive: true })
    writeFileSync(join(sub, 'big.bin'), Buffer.alloc(4096))
    writeFileSync(join(sub, 'child', 'small.bin'), Buffer.alloc(16))
    const result = await byName.get('clyan_space_deep').execute(
      { path: sub, maxDepth: 2, dirThresholdMB: 0, fileThresholdMB: 0, topN: 5 }, {},
    )
    assert.equal(result.ok, true)
    assert.ok(result.result.big_files.length >= 1)
    const call = readTraceEntries(tracePath).at(-1)
    assert.equal(call.op, 'clyan_space_deep')
    assert.equal(call.ok, true)
    assert.ok(call.outKeys.includes('big_dirs'))
    assert.ok(call.args.includes('maxDepth=2'))
    assert.equal(call.build.startsWith('0.1.0@'), true)
  })
})

test('D 端到端摘要层：上游给非 JSON → cli + scan-shape + call（清洗账可见）', async () => {
  assert.ok(STUB !== null, '本机没有可用的 exit-0 假 CLI（Windows: tree.com）——该用例需要它')
  const probe = spawnSync(STUB, ['--json', 'scan'], { windowsHide: true, shell: false, encoding: 'utf8' })
  assert.equal(probe.status, 0, '假 CLI 必须 exit 0（否则测不到「CLI 成功但上游数据退化」这条分支）')
  await scenario('scan', { clyanBin: STUB }, async ({ byName, tracePath }) => {
    const result = await byName.get('clyan_scan').execute({}, {})
    assert.equal(result.ok, true)
    assert.equal(result.result.total_items, 0)                    // 退化上游 → 退化摘要（不抛）
    const lines = readTraceEntries(tracePath).slice(1)
    assert.deepEqual(lines.map((e) => e.phase), ['cli', 'scan-shape', 'call'])
    const [cli, shapeLine, call] = lines
    assert.equal(cli.verb, 'scan')
    assert.equal(cli.exitOk, true)
    assert.equal(cli.parsed, 'null')                              // 上游没给出可解析 JSON
    assert.ok(cli.rawChars >= 0)
    assert.equal(shapeLine.op, 'clyan_scan')
    assert.equal(shapeLine.shape.rawKind, 'null')
    assert.equal(shapeLine.shape.itemsKept, 0)
    assert.equal(shapeLine.shape.detailsKeys, 0)
    assert.equal(shapeLine.summary.total_items, 0)
    assert.equal(call.op, 'clyan_scan')
    assert.equal(call.ok, true)
    // 上游 stdout 内容不得落盘（只记形状）
    const raw = readFileSync(tracePath, 'utf8')
    assert.equal(raw.includes('Too many parameters'), false)
  })
})

test('E 端到端真删标记：dryRun=false + yes=true → destructive:true（U2 的落点）', async () => {
  await scenario('destructive', { clyanBin: MISSING }, async ({ byName, tracePath }) => {
    await byName.get('clyan_clean').execute({}, {})                        // 默认预览
    const preview = readTraceEntries(tracePath).at(-1)
    assert.equal(preview.op, 'clyan_clean')
    assert.equal('destructive' in preview, false)
    await byName.get('clyan_clean').execute({ dryRun: false, yes: true }, {})
    const real = readTraceEntries(tracePath).at(-1)
    assert.equal(real.destructive, true)
    assert.ok(real.args.includes('dryRun=false'))
    assert.ok(real.args.includes('yes=true'))
  })
})

test('F 端到端隐私：真实落盘路径上喂凭据 → 一个字都不落盘', async () => {
  await scenario('privacy', { clyanBin: MISSING }, async ({ byName, tracePath }) => {
    const home = homedir()
    await byName.get('clyan_trust').execute({
      action: 'add',
      path: join(home, 'secret-dir'),
      reason: 'password=hunter2-must-not-land token=tok-must-not-land',
    }, {})
    const raw = readFileSync(tracePath, 'utf8')
    for (const secret of ['hunter2-must-not-land', 'tok-must-not-land', JSON.stringify(home).slice(1, -1)]) {
      assert.equal(raw.includes(secret), false, secret + ' 从真实落盘路径泄漏！')
    }
    // 反面证据：脱敏确实跑过（否则可能是「整键没记」造成的假通过）
    assert.ok(raw.includes('password=[redacted]'))
    assert.ok(raw.includes('<home>'))
  })
})

test('G 尸体测试：轨迹不可写（DSH_HOME 落在普通文件下）→ 业务照常、不抛', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clyan-wire-blocked-'))
  const blocker = join(root, 'blocker')
  writeFileSync(blocker, 'not a dir', 'utf8')
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = join(blocker, 'sub')          // 父路径是文件 → 轨迹永远写不进去
  try {
    const { byName } = mount({ clyanBin: MISSING, defaultPath: root })
    const pulse = await byName.get('clyan_pulse').execute({}, {})
    assert.equal(pulse.ok, false)                       // 业务失败是「缺 clyan」，不是观测失败
    assert.match(pulse.error, /无法启动 clyan/)
    const deep = await byName.get('clyan_space_deep').execute({ path: root, dirThresholdMB: 0, fileThresholdMB: 0 }, {})
    assert.equal(deep.ok, true)                         // 业务成功路径不受观测失败影响
    const summary = await byName.get('clyan_space_deep').execute({ path: root, topN: 1 }, {})
    assert.equal(summary.ok, true)
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    rmSync(root, { recursive: true, force: true })
  }
})

test('H 静态守卫：单点收口（16 个 reg / 摘要层唯一入口 / DSH_HOME 单一真源 / 业务侧无落盘 IO）', () => {
  const src = readFileSync(join(HERE, '..', 'src', 'index.ts'), 'utf8')
  const traceSrc = readFileSync(join(HERE, '..', 'src', 'trace.ts'), 'utf8')
  assert.equal((src.match(/ctx\.tools\.register\(defineTool\(/g) ?? []).length, 0, '有工具绕过 reg 直接注册（观测盲区）')
  assert.equal((src.match(/reg\(defineTool\(\{/g) ?? []).length, 16, 'reg 注册点必须恰为 16')
  assert.equal((src.match(/summarizeScan\(/g) ?? []).length, 1, 'summarizeScan 必须只被 summarizeTraced 调一次（清洗账不能漏点）')
  assert.equal((src.match(/clyanTracePath\(resolveHome\(\)\)/g) ?? []).length, 1, '轨迹路径解析必须唯一')
  assert.equal((src.match(/'DSH_HOME'/g) ?? []).length, 0, '业务侧不得自带 DSH_HOME 解析（单一真源在 trace.ts）')
  assert.equal((traceSrc.match(/'DSH_HOME'/g) ?? []).length, 1, 'DSH_HOME 解析必须恰有一处')
  assert.equal((src.match(/appendFileSync|writeFileSync|createWriteStream/g) ?? []).length, 0, '业务侧不得直接落盘')
  assert.equal((src.match(/clyanTrace\(/g) ?? []).length, 3, '落盘写入点必须恰为 boot / runCli / summarizeTraced 三处')
  assert.equal((src.match(/return runCliRaw\(/g) ?? []).length, 1, 'runCli 只应委托 runCliRaw 一次（唯一观测入口）')
})

test('cleanup', () => {
  if (STUB !== null && process.platform === 'win32') rmSync(join(STUB, '..'), { recursive: true, force: true })
})
