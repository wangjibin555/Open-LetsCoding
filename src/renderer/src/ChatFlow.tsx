// 轻量对话流渲染（M21 从 DesignPane 抽出）：Design 设计对话与 TaskWork 报告会话共用。
// user 气泡 / assistant Markdown（打字机）/ 工具改动条 / 状态行；样式复用 .dz-m-* 系列。
import TypeText from './TypeText'
import type { FlowItem } from './useStream'

export function lastAssistantIdOf(items: FlowItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'assistant') return items[i].id
  return null
}

export default function ChatFlow({
  items,
  running,
  lastAssistantId,
  onGrow
}: {
  items: FlowItem[]
  /** 运行中 + 最后一条 assistant 才启用打字机（TypeText 挂载时捕获） */
  running: boolean
  lastAssistantId: string | null
  onGrow?: () => void
}): React.JSX.Element {
  return (
    <>
      {items.map((it) => {
        if (it.kind === 'user')
          return (
            <div key={it.id} className="dz-m-user">
              {it.text}
            </div>
          )
        if (it.kind === 'assistant')
          return (
            <div key={it.id} className="dz-m-ai md">
              <TypeText text={it.text ?? ''} animate={running && it.id === lastAssistantId} onGrow={onGrow} />
            </div>
          )
        if (it.kind === 'tool')
          return (
            <div key={it.id} className="dz-m-tool" title={it.toolInput}>
              <span className={`ed${it.diff ? '' : ' ro'}`}>{it.diff?.badge ?? it.toolName}</span>
              <code>{it.diff ? it.diff.file.split('/').pop() : it.toolInput}</code>
              {it.diff && (
                <span className="diff">
                  <span className="add">+{it.diff.addN}</span> <span className="del">−{it.diff.delN}</span>
                </span>
              )}
            </div>
          )
        return (
          <div key={it.id} className="dz-m-status">
            {it.status ?? it.text}
          </div>
        )
      })}
    </>
  )
}
