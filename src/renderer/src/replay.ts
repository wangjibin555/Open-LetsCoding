// transcript 回放 → FlowItem 列表（M20-B 从 App 抽出：Code 屏回放与 Design 历史回放共用）。
import type { ReplayMessage } from '../../shared/ipc'
import { diffOf, summarizeInput, summarizeResult, type FlowItem } from './useStream'

interface ReplayBlock {
  type: string
  text?: string
  name?: string
  id?: string
  input?: unknown
  tool_use_id?: string
  is_error?: boolean
  content?: unknown
  source?: { type?: string; media_type?: string; data?: string }
}

export function replayToFlow(msgs: ReplayMessage[]): FlowItem[] {
  const items: FlowItem[] = []
  const byToolId = new Map<string, FlowItem>()
  let i = 0
  for (const m of msgs) {
    const content = (m.message as { content?: unknown })?.content
    if (m.type === 'user' && typeof content === 'string') {
      items.push({ id: `r${i++}`, kind: 'user', text: content })
    } else if (Array.isArray(content)) {
      // 用户消息里的图片块：先收集，挂到同消息的文本项上（或独立成图项）
      let pendingImgs: string[] = []
      for (const b of content as ReplayBlock[]) {
        if (b.type === 'image' && b.source?.data && b.source.media_type) {
          pendingImgs.push(`data:${b.source.media_type};base64,${b.source.data}`)
          continue
        }
        // 纯空白文本块跳过：会渲染成空气泡，还会打断工具批次合并
        if (b.type === 'text' && b.text?.trim()) {
          items.push({
            id: `r${i++}`,
            kind: m.type === 'user' ? 'user' : 'assistant',
            text: b.text,
            ...(pendingImgs.length ? { images: pendingImgs } : {})
          })
          pendingImgs = []
        } else if (b.type === 'tool_use') {
          const item: FlowItem = {
            id: `r${i++}`,
            kind: 'tool',
            toolName: b.name,
            toolInput: summarizeInput(b.name, b.input),
            toolUseId: b.id,
            diff: diffOf(b.name, b.input)
          }
          items.push(item)
          if (b.id) byToolId.set(b.id, item)
        } else if (b.type === 'tool_result' && b.tool_use_id) {
          // 回放同样回填工具结果摘要（设计稿 .tres）
          const t = byToolId.get(b.tool_use_id)
          if (t) t.tres = summarizeResult(b)
        }
      }
      // 纯图片消息（无文本块）独立成项
      if (pendingImgs.length) {
        items.push({ id: `r${i++}`, kind: m.type === 'user' ? 'user' : 'assistant', text: '', images: pendingImgs })
      }
    }
  }
  return items
}
