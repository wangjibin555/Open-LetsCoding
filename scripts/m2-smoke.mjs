// M2 集成冒烟（DECISIONS D2 手段① / D4 红线 / D7 集成 / SPEC §5）：
// 用真实网关驱动 SessionService，断言——
//   1. 工具链真实执行、产物正确
//   2. 出站流量仅到网关 host：本地 CONNECT 日志代理捕获 SDK 子进程所有 CONNECT 目标，
//      断言无 api.anthropic.com（HTTPS_PROXY 注入子进程，Claude Code 尊重该变量）
//   3. 预置 CLI 会话 jsonl 逐字节不变（hash 前后对比）
//   4. 危险命令（rm -rf）在「白名单包含 rm:* 且 auto 档」下仍触发 danger_list 权限请求
//      且被拒绝、目标文件存活 —— 白名单绕不过硬门（D7 验收：M3 T3.2）
//   5. propose_memory 工具被模型调用 → 收件箱且磁盘零写入；确认后落盘 frontmatter 合规
//      且 MEMORY.md 建索引（D6 验收：M4）
//   6. bypass 档（D14）：非白名单 Bash 零权限请求直行、产物落地；危险命令在
//      bypass+白名单双重放行压力下仍弹 danger_list、拒绝后文件存活
//
// env: LETSCODING_GATEWAY_HOST / LETSCODING_GATEWAY_KEY / SPIKE_MODEL?
import net from 'node:net'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

// better-sqlite3 走独立 node ABI 副本，不碰 Electron 在用的 node_modules 二进制（同 vitest.config.ts）
if (!process.env.LC_BS3_BINDING) {
  process.env.LC_BS3_BINDING = execFileSync(
    process.execPath,
    [join(import.meta.dirname, 'use-abi.mjs'), 'node', '--cache-only'],
    { encoding: 'utf8' }
  ).trim()
}

const HOST = process.env.LETSCODING_GATEWAY_HOST
const KEY = process.env.LETSCODING_GATEWAY_KEY
const MODEL = process.env.SPIKE_MODEL || 'openrouter/anthropic/claude-sonnet-4.6'
if (!HOST || !KEY) {
  console.error('SKIP: LETSCODING_GATEWAY_HOST / LETSCODING_GATEWAY_KEY not set')
  process.exit(3)
}

// --- 本地 CONNECT 日志代理：捕获所有隧道目标 host，直连转发 ---
const connectHosts = new Set()
const proxy = net.createServer((client) => {
  client.once('data', (chunk) => {
    const line = chunk.toString('utf8').split('\r\n')[0]
    const m = /^CONNECT\s+([^:\s]+):(\d+)/i.exec(line)
    if (!m) {
      client.end()
      return
    }
    const [, host, port] = m
    connectHosts.add(host)
    const upstream = net.connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on('error', () => client.end())
  })
  client.on('error', () => {})
})
await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`
process.env.HTTPS_PROXY = proxyUrl
process.env.HTTP_PROXY = proxyUrl

const { SessionService } = await import('../src/main/engine/sessions.ts')
const { MemoryService } = await import('../src/main/memory.ts')
const { StateStore } = await import('../src/main/store/index.ts')
const { fetchSpend } = await import('../src/main/engine/gateway.ts')

const play = join(tmpdir(), `letscoding-m2-smoke-${process.pid}`)
mkdirSync(play, { recursive: true })
writeFileSync(join(play, 'notes.txt'), 'M2 smoke: gateway-driven session must run tools.\n')
writeFileSync(join(play, 'keep.txt'), 'this file must survive the danger case\n')
writeFileSync(join(play, 'keep2.txt'), 'this file must survive the bypass danger case\n')

// 预置「已有 CLI 会话」文件，断言不被损坏
const projSlug = play.replace(/[^a-zA-Z0-9]/g, '-')
const projDir = join(homedir(), '.claude', 'projects', projSlug)
mkdirSync(projDir, { recursive: true })
const guardPath = join(projDir, 'preexisting-guard.jsonl')
writeFileSync(guardPath, JSON.stringify({ type: 'user', preexisting: true }) + '\n')
const guardHashBefore = createHash('sha256').update(readFileSync(guardPath)).digest('hex')

const dangerRules = [{ pattern: 'rm\\s+(-[a-zA-Z]*[rf][a-zA-Z]*)(\\s|$)', enabled: 1 }]
const permRequests = []
const memoryProposals = []

// 记忆链路（D6）：临时 projects 目录 + 独立 StateStore，验证「入箱零写盘 → accept 合规落盘」
const memProjectsDir = join(play, 'fake-claude-projects')
const memStore = new StateStore(join(play, 'smoke-state.db'))
const memoryService = new MemoryService(memProjectsDir, memStore)

function runTask(handle, firstPrompt, denyAll, whitelist = [], uiMode = 'auto') {
  return new Promise((resolve) => {
    const engine = new SessionService({
      onStream: (h, msg) => {
        const m = msg
        if (m?.type === 'result' || (m?.type === 'engine' && (m?.subtype === 'closed' || m?.subtype === 'error'))) {
          engine.closeAll()
          resolve()
        }
      },
      onPermissionRequest: (req) => {
        permRequests.push(req)
        setTimeout(() => engine.resolvePermission(req.requestId, !denyAll), 10)
      },
      onMemoryProposal: (p) => {
        memoryProposals.push(p)
        memStore.addInboxItem({
          session_id: p.handle,
          cwd: p.cwd,
          name: p.name,
          type: p.type,
          description: p.description,
          body: p.body
        })
      },
      getDangerRules: () => dangerRules,
      getWhitelist: () => whitelist,
      getConfig: () => ({ baseUrl: HOST, authToken: KEY, smallFastModel: MODEL })
    })
    engine.create({ handle, cwd: play, model: MODEL, uiMode, firstPrompt })
    setTimeout(() => {
      engine.closeAll()
      resolve()
    }, 150_000)
  })
}

// Task 1：良性工具链
await runTask(
  'smoke-1',
  `Work autonomously, do not ask questions. Read ${join(play, 'notes.txt')}, then write ` +
    `${join(play, 'out.txt')} containing exactly one summary line, then run ` +
    `\`wc -l < ${join(play, 'out.txt')}\` with Bash and report the number.`,
  false
)

// Task 2：危险命令必须被拦为权限请求——白名单显式包含 rm:*、auto 档自动放行的双重
// 「放行压力」下仍要弹窗（D7 验收：白名单绕不过硬门），冒烟里拒绝
await runTask(
  'smoke-2',
  `Run this exact bash command and report what happened: rm -rf ${join(play, 'keep.txt')}`,
  true,
  ['rm:*']
)

// Task 3：propose_memory 工具通道（D6）——模型被明确要求沉淀一条反馈
await runTask(
  'smoke-3',
  'We just learned a non-trivial reusable lesson worth remembering across sessions: ' +
    '"bind retries must carry an idempotency key because upstream does not dedupe". ' +
    'Use the propose_memory tool to propose it as a feedback memory (name: order-bind-idempotency, ' +
    'body must include **Why:** and **How to apply:** lines). Do not do anything else.',
  false
)

// Task 4：bypass 档（D14）——非白名单 Bash 在 auto 档必弹（Task 1 已证），bypass 档必须零弹窗直行
await runTask(
  'smoke-4',
  `Work autonomously, do not ask questions. Write ${join(play, 'out2.txt')} containing exactly ` +
    `one line, then run \`wc -l < ${join(play, 'out2.txt')}\` with Bash and report the number.`,
  false,
  [],
  'bypass'
)

// Task 5：bypass 档危险命令——全权委托 + 白名单双重放行压力下仍必须弹 danger_list（D14/D7），拒绝
await runTask(
  'smoke-5',
  `Run this exact bash command and report what happened: rm -rf ${join(play, 'keep2.txt')}`,
  true,
  ['rm:*'],
  'bypass'
)

const proposalArrived = memoryProposals.length > 0
const noDiskBeforeAccept = !existsSync(memProjectsDir)
let memoryFileOk = false
let memoryIndexOk = false
if (proposalArrived) {
  const pending = memStore.listInbox('pending')
  if (pending.length > 0) {
    const { filePath } = memoryService.accept(pending[0].id)
    const text = readFileSync(filePath, 'utf8')
    memoryFileOk =
      /^---\nname: [a-z0-9-]+\ndescription: .+/m.test(text) && text.includes('metadata:\n  type:')
    const indexPath = join(filePath, '..', 'MEMORY.md')
    memoryIndexOk = existsSync(indexPath) && readFileSync(indexPath, 'utf8').includes('](')
  }
}
memStore.close()

// D8：spend 状态必须显式可判定 —— available=true 且金额为数字，或 available=false 且给出 reason；
// 任何情况下都不允许回退 SDK 估算值（面板单一数据源即本函数）
const spend = await fetchSpend(HOST, KEY)
const spendExplicit =
  (spend.available === true && typeof spend.spendUsd === 'number') ||
  (spend.available === false && spend.spendUsd === null && typeof spend.reason === 'string')

proxy.close()

const outCreated = existsSync(join(play, 'out.txt'))
const keepSurvived = existsSync(join(play, 'keep.txt'))
const guardHashAfter = createHash('sha256').update(readFileSync(guardPath)).digest('hex')
const guardIntact = guardHashBefore === guardHashAfter
const badHosts = [...connectHosts].filter((h) => h.includes('anthropic.com'))
const gatewayHost = new URL(HOST).host
const onlyGateway = connectHosts.size > 0 && [...connectHosts].every((h) => h === gatewayHost)
const dangerAsked = permRequests.some((r) => r.handle === 'smoke-2' && r.reason === 'danger_list')
// D14 bypass 两幕：非危险零权限请求 + 危险仍弹卡（handle 维度隔离断言）
const bypassZeroPrompts = permRequests.filter((r) => r.handle === 'smoke-4').length === 0
const bypassOutCreated = existsSync(join(play, 'out2.txt'))
const bypassDangerAsked = permRequests.some((r) => r.handle === 'smoke-5' && r.reason === 'danger_list')
const keep2Survived = existsSync(join(play, 'keep2.txt'))

const checks = {
  out_created: outCreated,
  guard_file_intact: guardIntact,
  connect_hosts: [...connectHosts],
  only_gateway_host: onlyGateway,
  no_anthropic_direct: badHosts.length === 0,
  danger_asked_despite_whitelist: dangerAsked,
  keep_file_survived: keepSurvived,
  bypass_zero_prompts: bypassZeroPrompts,
  bypass_out_created: bypassOutCreated,
  bypass_danger_asked: bypassDangerAsked,
  bypass_keep_survived: keep2Survived,
  memory_proposal_arrived: proposalArrived,
  memory_no_disk_before_accept: noDiskBeforeAccept,
  memory_file_compliant: memoryFileOk,
  memory_index_updated: memoryIndexOk,
  spend_status_explicit: spendExplicit,
  spend_available: spend.available,
  total_perm_requests: permRequests.length
}
console.log('[M2-SMOKE]', JSON.stringify(checks, null, 2))

const pass =
  outCreated &&
  guardIntact &&
  badHosts.length === 0 &&
  onlyGateway &&
  dangerAsked &&
  keepSurvived &&
  bypassZeroPrompts &&
  bypassOutCreated &&
  bypassDangerAsked &&
  keep2Survived &&
  proposalArrived &&
  noDiskBeforeAccept &&
  memoryFileOk &&
  memoryIndexOk &&
  spendExplicit
console.log(pass ? 'M2-SMOKE: PASS' : 'M2-SMOKE: FAIL')
process.exit(pass ? 0 : 1)
