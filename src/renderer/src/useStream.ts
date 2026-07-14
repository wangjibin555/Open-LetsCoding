// 把 SDK 流式消息归约成可渲染的 UI 事件列表。
// 按 handle 分桶：事件写入所属会话的桶（无论是否活跃），切换会话时流与历史不丢——
// 修复「live→只读回放→切回 live 后内容错乱/像切不动」的根因（旧实现单桶共享、切换即被 reset 覆盖）。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { StreamEventPayload } from '../../shared/ipc'

export interface DiffData {
  file: string
  badge: 'EDIT' | 'WRITE'
  del: string[]
  add: string[]
  /** 真实增/删行数（del/add 为展示用截断，折叠头的 +N −M 用这两个） */
  delN: number
  addN: number
}

export interface FlowItem {
  id: string
  kind: 'user' | 'assistant' | 'tool' | 'status' | 'memory'
  text?: string
  toolName?: string
  toolInput?: string
  toolUseId?: string
  /** 工具结果摘要（设计稿 .tres：如「214 行」「出错」） */
  tres?: string
  /** Edit/Write 的 diff 块（设计稿 .diff） */
  diff?: DiffData
  status?: string
  memory?: { inboxId: number; name: string; memType: string; description: string; resolved?: 'accepted' | 'discarded' | 'error'; note?: string }
  /** 子 agent（Task 工具）的执行步骤摘要，live 按 parent_tool_use_id 路由、回放读 subagents/ 目录 */
  sub?: string[]
  /** 子 agent 的任务描述（回放 meta.json / live 无） */
  subDesc?: string
  /** 用户消息附带的图片（dataURL 预览） */
  images?: string[]
}

export interface TokenUsage {
  inTok: number
  outTok: number
  /** 上下文实际占用 = input + cache_read + cache_creation（右栏用量条数据源） */
  ctxTok: number
}

interface ContentBlock {
  type: string
  id?: string
  text?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  is_error?: boolean
  content?: unknown
}

interface SdkMsg {
  type?: string
  subtype?: string
  session_id?: string
  parent_tool_use_id?: string | null
  /** stream_event 的增量事件（打字机流式渲染只消费 text_delta） */
  event?: { type?: string; delta?: { type?: string; text?: string } }
  error?: string
  inboxId?: number
  name?: string
  memType?: string
  description?: string
  num_turns?: number
  skills?: string[]
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  message?: { content?: ContentBlock[] | string }
}

export function summarizeInput(name?: string, input?: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  if (name === 'Bash' && typeof o['command'] === 'string') return o['command'] as string
  if (typeof o['file_path'] === 'string') return o['file_path'] as string
  if (typeof o['pattern'] === 'string') return o['pattern'] as string
  // Task/Agent 等工具：用任务描述兜底
  if (typeof o['description'] === 'string') return o['description'] as string
  return ''
}

/** Edit/Write 输入 → diff 块数据；非编辑类工具返回 undefined */
export function diffOf(name?: string, input?: unknown): DiffData | undefined {
  if (!input || typeof input !== 'object') return undefined
  const o = input as Record<string, unknown>
  const file = typeof o['file_path'] === 'string' ? (o['file_path'] as string) : ''
  if (!file) return undefined
  const cap = (s: string): string[] => {
    const lines = s.split('\n')
    return lines.length > 12 ? [...lines.slice(0, 12), `… 共 ${lines.length} 行`] : lines
  }
  const count = (s: string): number => s.split('\n').length
  if (name === 'Edit' && typeof o['old_string'] === 'string' && typeof o['new_string'] === 'string') {
    const oldS = o['old_string'] as string
    const newS = o['new_string'] as string
    return { file, badge: 'EDIT', del: cap(oldS), add: cap(newS), delN: count(oldS), addN: count(newS) }
  }
  if (name === 'Write' && typeof o['content'] === 'string') {
    const c = o['content'] as string
    return { file, badge: 'WRITE', del: [], add: cap(c), delN: 0, addN: count(c) }
  }
  return undefined
}

/** tool_result → 摘要文本（行数 / 出错） */
export function summarizeResult(b: { is_error?: boolean; content?: unknown }): string {
  if (b.is_error) return '出错'
  let text = ''
  if (typeof b.content === 'string') text = b.content
  else if (Array.isArray(b.content)) {
    text = (b.content as ContentBlock[])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
  }
  if (!text.trim()) return '完成'
  return `${text.trim().split('\n').length} 行`
}

interface HandleState {
  items: FlowItem[]
  running: boolean
  usage: TokenUsage | null
  runningTool: { name: string; cmd: string } | null
  /** init 消息的 skills（斜杠提示的真值来源） */
  skills: string[] | null
  /** 打字机流式：正在增量累积的助手消息 item id（完整消息到达即替换） */
  partialId: string | null
  /** 后台会话完成本轮 → 未读；切到该会话即清 */
  unread: boolean
}

function emptyState(): HandleState {
  return {
    items: [],
    running: false,
    usage: null,
    runningTool: null,
    skills: null,
    partialId: null,
    unread: false
  }
}

export function useSessionStream(activeHandle: string | null): {
  items: FlowItem[]
  running: boolean
  usage: TokenUsage | null
  runningTool: { name: string; cmd: string } | null
  /** 活跃会话 init 上报的 skills；未上报为 null */
  sessionSkills: string[] | null
  /** 指定 handle 是否已有本地流缓存（无则需从 transcript 回放播种） */
  hasCache: (handle: string) => boolean
  /** 有未读完成轮次的后台会话 handles（侧栏未读点） */
  unreadHandles: string[]
  pushUser: (text: string, images?: string[]) => void
  /** 向活跃桶追加一条状态行（如「停止失败」「启动失败」的可见反馈） */
  pushStatus: (text: string) => void
  resolveMemory: (inboxId: number, resolved: 'accepted' | 'discarded' | 'error', note?: string) => void
  /** 覆盖式播种某 handle 的事件列表（回放/续聊迁移用） */
  seed: (handle: string, items: FlowItem[]) => void
  /** 乐观标记运行状态：创建/发送后立即置 true，让「停止」按钮覆盖启动窗口期 */
  setRunning: (handle: string, running: boolean) => void
} {
  const store = useRef(new Map<string, HandleState>())
  const seq = useRef(0)
  const [, bump] = useState(0)
  const activeRef = useRef(activeHandle)
  activeRef.current = activeHandle

  const nextId = (): string => `f${++seq.current}`
  const ensure = (handle: string): HandleState => {
    let s = store.current.get(handle)
    if (!s) {
      s = emptyState()
      store.current.set(handle, s)
    }
    return s
  }
  // 仅活跃会话的变更需要重渲染；后台桶静默积累
  const commit = (handle: string): void => {
    if (handle === activeRef.current) bump((v) => v + 1)
  }

  useEffect(() => {
    const unsub = window.letscoding.session.onStream((e: StreamEventPayload) => {
      const s = ensure(e.handle)
      const m = e.msg as SdkMsg
      // 子 agent（Task 工具）消息：不进主流，路由到所属 Task 工具行的 sub 步骤列表
      if (m.parent_tool_use_id) {
        if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
          const labels: string[] = []
          for (const b of m.message.content) {
            if (b.type === 'text' && b.text?.trim()) labels.push(b.text.trim().slice(0, 90))
            else if (b.type === 'tool_use') {
              labels.push(`${b.name ?? ''} ${summarizeInput(b.name, b.input)}`.trim().slice(0, 90))
            }
          }
          if (labels.length) {
            const pid = m.parent_tool_use_id
            s.items = s.items.map((it) =>
              it.kind === 'tool' && it.toolUseId === pid
                ? { ...it, sub: [...(it.sub ?? []), ...labels].slice(-200) }
                : it
            )
            commit(e.handle)
          }
        }
        return
      }
      if (m.type === 'system' && m.subtype === 'init' && Array.isArray(m.skills)) {
        s.skills = m.skills
        commit(e.handle)
        return
      }
      if (m.type === 'stream_event') {
        if (!s.running) {
          s.running = true
          commit(e.handle)
        }
        // 打字机流式：text_delta 增量写入 partial 助手消息
        const delta = m.event?.type === 'content_block_delta' ? m.event.delta : undefined
        if (delta?.type === 'text_delta' && delta.text) {
          const chunk = delta.text
          if (s.partialId) {
            const pid = s.partialId
            s.items = s.items.map((it) => (it.id === pid ? { ...it, text: (it.text ?? '') + chunk } : it))
          } else {
            const id = nextId()
            s.partialId = id
            s.items = [...s.items, { id, kind: 'assistant', text: chunk }]
          }
          commit(e.handle)
        }
        return
      }
      if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
        s.running = true
        // 完整消息到达：首个文本块原位替换流式 partial（保持同 id——打字机动画不重启，D12.5）
        let pid = s.partialId
        s.partialId = null
        for (const b of m.message.content) {
          // 纯空白文本块跳过（同 replayToFlow）：空气泡 + 打断工具批次合并
          if (b.type === 'text' && b.text?.trim()) {
            if (pid) {
              const usePid = pid
              pid = null
              s.items = s.items.map((it) => (it.id === usePid ? { ...it, text: b.text } : it))
            } else {
              s.items = [...s.items, { id: nextId(), kind: 'assistant', text: b.text }]
            }
          }
          if (b.type === 'tool_use') {
            const cmd = summarizeInput(b.name, b.input)
            s.runningTool = { name: b.name ?? '', cmd }
            s.items = [
              ...s.items,
              {
                id: nextId(),
                kind: 'tool',
                toolName: b.name,
                toolInput: cmd,
                toolUseId: b.id,
                diff: diffOf(b.name, b.input)
              }
            ]
          }
        }
        // 最终消息没有文本块（罕见）：partial 无处安放，按原语义移除避免重复
        if (pid) {
          const rm = pid
          s.items = s.items.filter((it) => it.id !== rm)
        }
        commit(e.handle)
      }
      // 工具结果（SDK 以 user 消息承载 tool_result）→ 回填对应工具行的 .tres
      if (m.type === 'user' && Array.isArray(m.message?.content)) {
        for (const b of m.message.content) {
          if (b.type === 'tool_result' && b.tool_use_id) {
            const tres = summarizeResult(b)
            s.runningTool = null
            s.items = s.items.map((it) =>
              it.kind === 'tool' && it.toolUseId === b.tool_use_id ? { ...it, tres } : it
            )
          }
        }
        commit(e.handle)
      }
      if (m.type === 'result') {
        s.running = false
        s.runningTool = null
        // 被打断时 partial 内容保留（是真实输出），仅归还指针
        s.partialId = null
        // 非活跃会话完成 → 未读点
        if (e.handle !== activeRef.current) s.unread = true
        // D8：会话内只显示 token 计数（SDK 真值），金额一律不采用 SDK 估算
        const inTok = m.usage?.input_tokens
        const outTok = m.usage?.output_tokens
        if (inTok !== undefined || outTok !== undefined) {
          const ctxTok =
            (inTok ?? 0) +
            (m.usage?.cache_read_input_tokens ?? 0) +
            (m.usage?.cache_creation_input_tokens ?? 0)
          s.usage = { inTok: inTok ?? 0, outTok: outTok ?? 0, ctxTok }
        }
        if (inTok !== undefined || outTok !== undefined || m.num_turns !== undefined) {
          s.items = [
            ...s.items,
            {
              id: nextId(),
              kind: 'status',
              status: `本轮完成 · ${m.num_turns ?? '?'} 步 · tokens 入 ${inTok ?? '?'} / 出 ${outTok ?? '?'}`
            }
          ]
        }
        commit(e.handle)
      }
      if (m.type === 'engine' && m.subtype === 'memory_proposed' && m.inboxId !== undefined) {
        const memory = {
          inboxId: m.inboxId,
          name: m.name ?? '',
          memType: m.memType ?? 'feedback',
          description: m.description ?? ''
        }
        s.items = [...s.items, { id: nextId(), kind: 'memory', memory }]
        commit(e.handle)
      }
      if (m.type === 'engine' && (m.subtype === 'closed' || m.subtype === 'error')) {
        s.running = false
        s.runningTool = null
        s.partialId = null
        if (m.subtype === 'error') {
          s.items = [...s.items, { id: nextId(), kind: 'status', status: `引擎错误：${m.error}` }]
        }
        commit(e.handle)
      }
    })
    return unsub
    // 全局订阅一次：事件按 handle 入桶，与活跃会话无关
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 切换活跃会话时重渲染一次，取到该桶内容；打开即清未读
  useEffect(() => {
    if (activeHandle) {
      const s = store.current.get(activeHandle)
      if (s) s.unread = false
    }
    bump((v) => v + 1)
  }, [activeHandle])

  const active = activeHandle ? (store.current.get(activeHandle) ?? emptyState()) : emptyState()

  const hasCache = useCallback((handle: string) => store.current.has(handle), [])

  return {
    items: active.items,
    running: active.running,
    usage: active.usage,
    runningTool: active.runningTool,
    sessionSkills: active.skills,
    hasCache,
    unreadHandles: [...store.current.entries()].filter(([, s]) => s.unread).map(([h]) => h),
    pushUser: (text: string, images?: string[]) => {
      const h = activeRef.current
      if (!h) return
      const s = ensure(h)
      s.items = [...s.items, { id: nextId(), kind: 'user', text, ...(images?.length ? { images } : {}) }]
      commit(h)
    },
    pushStatus: (text: string) => {
      const h = activeRef.current
      if (!h) return
      const s = ensure(h)
      s.items = [...s.items, { id: nextId(), kind: 'status', status: text }]
      commit(h)
    },
    resolveMemory: (inboxId, resolved, note) => {
      const h = activeRef.current
      if (!h) return
      const s = ensure(h)
      s.items = s.items.map((it) =>
        it.kind === 'memory' && it.memory?.inboxId === inboxId
          ? { ...it, memory: { ...it.memory, resolved, note } }
          : it
      )
      commit(h)
    },
    seed: (handle, items) => {
      const s = ensure(handle)
      s.items = items
      // 覆盖播种后旧 partial 指针必然失配：清掉，防最终文本原位替换 map 不到而丢失
      s.partialId = null
      seq.current = Math.max(seq.current, items.length + 1)
      commit(handle)
    },
    setRunning: (handle, running) => {
      const s = ensure(handle)
      if (s.running === running) return
      s.running = running
      if (!running) s.runningTool = null
      commit(handle)
    }
  }
}
