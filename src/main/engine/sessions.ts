// SessionService（DECISIONS D2 / SPEC §2）：Agent SDK 唯一封装点。
// 与 Electron 解耦：事件/权限经回调注入，可在纯 Node 下集成测试（scripts/m2-smoke.ts）。
import {
  query,
  listSessions,
  getSessionMessages,
  deleteSession,
  renameSession,
  type HookCallback,
  type HookJSONOutput,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type SDKSessionInfo,
  type SDKUserMessage,
  type SessionMessage
} from '@anthropic-ai/claude-agent-sdk'
import { Pushable } from './pushable'
import { matchDanger, type DangerRuleLike } from './danger'
import { buildMemoryServer, MEMORY_TOOL_NAME, type MemoryProposal } from './memoryTool'
import {
  buildConsolidationServer,
  CONSOLIDATE_TOOL_NAME,
  type ConsolidationProposal
} from './consolidationTool'
import { CONSOLIDATE_DISALLOWED_TOOLS } from './consolidateGuard'
import { SCHEDULED_DISALLOWED_TOOLS, SCHEDULED_MAX_TURNS } from './scheduledGuard'
import { shouldAutoAllow, UI_TO_SDK_MODE, type UiPermissionMode } from './permissionPolicy'

export type { MemoryProposal, ConsolidationProposal }
export type { UiPermissionMode } from './permissionPolicy'

export interface EngineConfig {
  baseUrl: string
  authToken: string
  smallFastModel?: string
}

export interface ImageAttachment {
  /** e.g. image/png、image/jpeg */
  media_type: string
  /** base64（不带 data: 前缀） */
  data: string
}

export interface CreateSessionOpts {
  handle: string
  cwd: string
  model: string
  uiMode: UiPermissionMode
  resume?: string
  firstPrompt: string
  /** 首条消息附带的图片（粘贴/拖拽） */
  images?: ImageAttachment[]
  /** 'consolidate' 注入 propose_consolidation（D9）；'scheduled' 定时只读会话（D10）；默认 'chat' 注入 propose_memory */
  mode?: 'chat' | 'consolidate' | 'scheduled'
}

export interface PermissionRequest {
  requestId: string
  handle: string
  toolName: string
  input: Record<string, unknown>
  reason: 'prompt' | 'danger_list'
  dangerPattern?: string
  decisionReason?: string
  /** SDK 提供了「以后不再问」的权限更新建议（危险命令永不透传，见 handlePermission） */
  hasSuggestions: boolean
}

export interface LiveSessionInfo {
  handle: string
  sessionId?: string
  model: string
  cwd: string
  uiMode: UiPermissionMode
}

export interface EngineCallbacks {
  onStream: (handle: string, msg: unknown) => void
  onPermissionRequest: (req: PermissionRequest) => void
  /** propose_memory 工具调用 → 收件箱（不写盘，D6）。未接线时传 undefined 表示不注入工具。 */
  onMemoryProposal?: (p: MemoryProposal) => void
  /** propose_consolidation 工具调用 → 整理收件箱（不写盘/不删源，D9） */
  onConsolidationProposal?: (p: ConsolidationProposal) => void
  getDangerRules: () => DangerRuleLike[]
  /** 命令白名单（D7）：规则内容形如 "git status:*"，engine 包装为 Bash(...) allow 规则 */
  getWhitelist: () => string[]
  getConfig: () => EngineConfig | null
}

interface LiveSession {
  handle: string
  q: ReturnType<typeof query>
  input: Pushable<SDKUserMessage>
  sessionId?: string
  model: string
  cwd: string
  uiMode: UiPermissionMode
}

interface PendingPerm {
  resolve: (r: PermissionResult) => void
  suggestions?: PermissionUpdate[]
}

export class SessionService {
  private live = new Map<string, LiveSession>()
  private pendingPerms = new Map<string, PendingPerm>()
  private permSeq = 0

  constructor(private readonly cb: EngineCallbacks) {}

  create(opts: CreateSessionOpts): void {
    const cfg = this.cb.getConfig()
    if (!cfg) throw new Error('gateway not configured (base URL / key missing)')
    if (this.live.has(opts.handle)) throw new Error(`handle ${opts.handle} already live`)

    // F3 红线：base URL 与 auth token 必须成对注入；剔除环境里可能残留的官方 key
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && k !== 'ANTHROPIC_API_KEY') env[k] = v
    }
    env['ANTHROPIC_BASE_URL'] = cfg.baseUrl
    env['ANTHROPIC_AUTH_TOKEN'] = cfg.authToken
    env['ANTHROPIC_SMALL_FAST_MODEL'] = cfg.smallFastModel ?? opts.model
    env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] = '1'

    // D7：白名单 → allow 规则（白名单内自动放行、未知命令走弹窗）。
    // 危险清单不受此影响 —— PreToolUse 硬门在放行判定之前强制 'ask'。
    const allowedTools = this.cb.getWhitelist().map((p) => `Bash(${p})`)

    // D6/D9：注入专用工具（自身免权限弹窗；产出只进对应收件箱，不写盘）。
    // 整理会话（mode='consolidate'）注入 propose_consolidation；普通会话注入 propose_memory。
    const onConsolidation = this.cb.onConsolidationProposal
    const onProposal = this.cb.onMemoryProposal
    // 定时会话（D10）不注入任何提议工具：复盘报告不该顺手产出记忆提议
    const toolServer =
      opts.mode === 'consolidate'
        ? onConsolidation
          ? buildConsolidationServer(opts.handle, opts.cwd, onConsolidation)
          : null
        : opts.mode === 'scheduled'
          ? null
          : onProposal
            ? buildMemoryServer(opts.handle, opts.cwd, onProposal)
            : null
    if (toolServer) {
      allowedTools.push(opts.mode === 'consolidate' ? CONSOLIDATE_TOOL_NAME : MEMORY_TOOL_NAME)
    }

    const input = new Pushable<SDKUserMessage>()
    const options: Options = {
      cwd: opts.cwd,
      model: opts.model,
      env,
      permissionMode: UI_TO_SDK_MODE[opts.uiMode],
      ...(toolServer ? { mcpServers: { letscoding: toolServer } } : {}),
      ...(allowedTools.length ? { allowedTools } : {}),
      // D9 硬闸：整理会话禁写工具，模型对既有记忆零写权（仅经 propose_consolidation 提议）
      ...(opts.mode === 'consolidate' ? { disallowedTools: CONSOLIDATE_DISALLOWED_TOOLS } : {}),
      // D10 硬闸：定时会话无人值守 → 只读 + 轮数封顶（成本护栏）
      ...(opts.mode === 'scheduled'
        ? { disallowedTools: SCHEDULED_DISALLOWED_TOOLS, maxTurns: SCHEDULED_MAX_TURNS }
        : {}),
      includePartialMessages: true,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      // 复用本机 ~/.claude 体系（产品定位）：加载用户/项目级 skills 与 CLAUDE.md，
      // init 消息的 skills/slash_commands 即真值来源（composer 斜杠提示用）
      settingSources: ['user', 'project'],
      canUseTool: (toolName, toolInput, o) =>
        this.handlePermission(opts.handle, toolName, toolInput, o.decisionReason, o.suggestions),
      hooks: {
        PreToolUse: [{ hooks: [this.dangerGate] }]
      },
      ...(opts.resume ? { resume: opts.resume } : {})
    }

    const q = query({ prompt: input, options })
    const session: LiveSession = {
      handle: opts.handle,
      q,
      input,
      model: opts.model,
      cwd: opts.cwd,
      uiMode: opts.uiMode
    }
    this.live.set(opts.handle, session)
    void this.pump(session)
    this.send(opts.handle, opts.firstPrompt, opts.images)
  }

  send(handle: string, text: string, images?: ImageAttachment[]): void {
    const s = this.must(handle)
    const content: unknown[] = [
      ...(images ?? []).map((img) => ({
        type: 'image',
        source: { type: 'base64', media_type: img.media_type, data: img.data }
      }))
    ]
    // 纯图片消息不塞空 text block（API 不接受空文本）
    if (text.trim() || content.length === 0) content.push({ type: 'text', text })
    s.input.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null
    } as SDKUserMessage)
  }

  async interrupt(handle: string): Promise<void> {
    await this.must(handle).q.interrupt()
  }

  async setModel(handle: string, model: string): Promise<void> {
    const s = this.must(handle)
    await s.q.setModel(model)
    s.model = model
  }

  async setMode(handle: string, uiMode: UiPermissionMode): Promise<void> {
    const s = this.must(handle)
    await s.q.setPermissionMode(UI_TO_SDK_MODE[uiMode])
    s.uiMode = uiMode
  }

  close(handle: string): void {
    const s = this.live.get(handle)
    if (!s) return
    s.input.end()
    try {
      s.q.close()
    } catch {
      // 已经结束的进程 close 抛错可忽略
    }
    this.live.delete(handle)
  }

  closeAll(): void {
    for (const handle of [...this.live.keys()]) this.close(handle)
  }

  resolvePermission(requestId: string, allow: boolean, opts?: { always?: boolean; message?: string }): void {
    const pending = this.pendingPerms.get(requestId)
    if (!pending) return
    this.pendingPerms.delete(requestId)
    if (!allow) {
      pending.resolve({
        behavior: 'deny',
        message: opts?.message ?? '用户在 LetsCoding 中拒绝了该操作'
      })
      return
    }
    // 「总是允许（本会话）」：回传 SDK 的建议规则集，本会话内同类调用不再问
    pending.resolve(
      opts?.always && pending.suggestions?.length
        ? { behavior: 'allow', updatedPermissions: pending.suggestions }
        : { behavior: 'allow' }
    )
  }

  liveSessions(): LiveSessionInfo[] {
    return [...this.live.values()].map((s) => ({
      handle: s.handle,
      sessionId: s.sessionId,
      model: s.model,
      cwd: s.cwd,
      uiMode: s.uiMode
    }))
  }

  list(dir?: string): Promise<SDKSessionInfo[]> {
    return listSessions(dir ? { dir } : {})
  }

  messages(sessionId: string, dir?: string): Promise<SessionMessage[]> {
    return getSessionMessages(sessionId, dir ? { dir } : undefined)
  }

  /** 删除会话 transcript（用户显式动作；live 会话须先关闭） */
  async remove(sessionId: string, dir?: string): Promise<void> {
    for (const s of this.live.values()) {
      if (s.sessionId === sessionId) this.close(s.handle)
    }
    await deleteSession(sessionId, dir ? { dir } : undefined)
  }

  rename(sessionId: string, title: string, dir?: string): Promise<void> {
    return renameSession(sessionId, title, dir ? { dir } : undefined)
  }

  private must(handle: string): LiveSession {
    const s = this.live.get(handle)
    if (!s) throw new Error(`no live session for handle ${handle}`)
    return s
  }

  private async pump(s: LiveSession): Promise<void> {
    try {
      for await (const msg of s.q) {
        const m = msg as { type?: string; subtype?: string; session_id?: string }
        if (m.type === 'system' && m.subtype === 'init' && m.session_id) {
          s.sessionId = m.session_id
        }
        this.cb.onStream(s.handle, msg)
      }
      this.cb.onStream(s.handle, { type: 'engine', subtype: 'closed' })
    } catch (err) {
      this.cb.onStream(s.handle, { type: 'engine', subtype: 'error', error: String(err) })
    } finally {
      this.live.delete(s.handle)
    }
  }

  private handlePermission(
    handle: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    decisionReason?: string,
    suggestions?: PermissionUpdate[]
  ): Promise<PermissionResult> {
    const rules = this.cb.getDangerRules()
    const danger = matchDanger(rules, toolName, toolInput)
    // D14 全权委托：非危险调用全自动放行（危险清单仍走下方弹卡，D7 硬门不动摇）
    if (shouldAutoAllow(this.live.get(handle)?.uiMode, danger)) {
      return Promise.resolve({ behavior: 'allow' })
    }
    const requestId = `perm-${++this.permSeq}`
    // D7 红线：危险命令绝不提供「总是允许」——每次都必须人肉确认
    const usableSuggestions = danger ? undefined : suggestions
    return new Promise<PermissionResult>((resolve) => {
      this.pendingPerms.set(requestId, { resolve, suggestions: usableSuggestions })
      this.cb.onPermissionRequest({
        requestId,
        handle,
        toolName,
        input: toolInput,
        reason: danger ? 'danger_list' : 'prompt',
        dangerPattern: danger ?? undefined,
        decisionReason,
        hasSuggestions: (usableSuggestions?.length ?? 0) > 0
      })
    })
  }

  // D7：命中危险清单 → 强制进入权限提示（hook 对白名单/acceptEdits 放行路径同样生效，
  // 这是 canUseTool 做不到的 —— canUseTool 不会对已自动放行的调用触发）。
  private dangerGate: HookCallback = async (input): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    const matched = matchDanger(
      this.cb.getDangerRules(),
      input.tool_name,
      (input.tool_input ?? {}) as Record<string, unknown>
    )
    if (!matched) return {}
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: `danger_list: ${matched}`
      }
    }
  }
}
