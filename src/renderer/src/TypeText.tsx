// 打字机平滑显示（DECISIONS D12.5）：网关缓冲使 text_delta 大块到达，文本整段弹出——
// 这里在渲染层逐字 reveal 追平。只做展示层动画，不碰 useStream 事件归约。
import { useEffect, useRef, useState } from 'react'
import Markdown from './Markdown'

/** 超长文本不动画（Markdown 每帧重排的成本兜底），直接整段显示 */
export const MAX_ANIMATE_CHARS = 20_000

/** 每 tick 步进：积压越大步子越大（几千字积压约 1.5s 追平），到达即停 */
export function revealStep(shown: number, target: number): number {
  if (shown >= target) return target
  return Math.min(target, shown + Math.max(3, Math.ceil((target - shown) / 12)))
}

const TICK_MS = 24

export default function TypeText({
  text,
  animate,
  onGrow
}: {
  text: string
  /** 挂载时捕获：仅「运行中的最后一条 assistant」动画；历史/回放/切回会话整段显示 */
  animate: boolean
  /** 每次步进回调（父容器跟随滚动用） */
  onGrow?: () => void
}): React.JSX.Element {
  const anim = useRef(animate && text.length <= MAX_ANIMATE_CHARS).current
  const [shown, setShown] = useState(anim ? 0 : text.length)
  const targetRef = useRef(text.length)
  targetRef.current = text.length
  const onGrowRef = useRef(onGrow)
  onGrowRef.current = onGrow

  const done = !anim || shown >= text.length
  useEffect(() => {
    if (done) return
    const t = setInterval(() => {
      setShown((s) => {
        const next = revealStep(s, targetRef.current)
        if (next !== s) onGrowRef.current?.()
        return next
      })
    }, TICK_MS)
    return () => clearInterval(t)
    // done 翻转才重建定时器：text 继续增长（流式追加）时同一定时器接着追
  }, [done])

  return <Markdown text={anim && shown < text.length ? text.slice(0, shown) : text} />
}
