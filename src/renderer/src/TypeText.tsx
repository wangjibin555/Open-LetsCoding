// 打字机平滑显示（DECISIONS D12.5）：网关缓冲使 text_delta 大块到达，文本整段弹出——
// 这里在渲染层逐字 reveal 追平。只做展示层动画，不碰 useStream 事件归约。
//
// ⚡ 性能红线（#14）：每次步进都会把**整段文本**交给 Markdown 重新解析，
// 成本实测 ≈ L/1200 ms（Electron 35 / Chromium）。固定 24ms 步进时，40k 字的消息
// 会吃掉 90.3% 主线程——界面冻住。所以步进间隔必须随**当前**长度自适应（见 tickMsFor）。
//
// 【为什么不是「超长就关动画」】原实现留了个 MAX_ANIMATE_CHARS 想干这事，
// 但方向是反的：关掉动画后 Markdown 直接吃 text，而底层流本身以 ≤60Hz 在换文本，
// 比打字机的 42Hz **更勤**——12k 字实测 47.6% vs 35.4%。要节流的是
// 「交给 Markdown 的新字符串」的频率，不是动画开关。该常量已删除。
import { useEffect, useRef, useState } from 'react'
import Markdown from './Markdown'

const TICK_MS = 24

/**
 * 步进间隔：把「整段重解析」的开销锁在主线程 ~10% 以内。
 *
 * ≤4000 字返回 TICK_MS，与旧实现逐帧一致——实测真实会话最长的助手消息 3694 字，
 * 即现存全部消息的观感逐字节不变（负向红线）。更长时取 L/100 并按 25ms 分档。
 *
 * 除数取 100 而非按 10% 预算算出的 125：实测 40k 时解析只占 8%，但 60Hz 重渲染 +
 * 大 DOM 布局还有约 9% 底噪，这部分不随 tick 缩。留出余量才不至于踩线过。
 * 分档是为了让 tick 少变：tick 一变 useEffect 就重建定时器，变太勤会饿死步进——
 * 档位每 2500 字才跳一次，而 tick ≤500ms，对 2-3k 字/秒的真实流速有 2× 以上余量。
 */
export function tickMsFor(chars: number): number {
  if (chars <= 4000) return TICK_MS
  return Math.min(500, Math.max(TICK_MS, Math.round(chars / 100 / 25) * 25))
}

/**
 * 每 tick 步进：积压越大步子越大，到达即停。
 *
 * 追平窗口恒定 ≈288ms（= 12 × TICK_MS）而非恒定 12 个 tick——tick 被拉慢后若仍按
 * 12 步走，40k 字要 12×325ms≈4s 才追平，消息末尾会明显吊着。
 */
export function revealStep(shown: number, target: number, tick: number = TICK_MS): number {
  if (shown >= target) return target
  const steps = Math.max(1, Math.round((12 * TICK_MS) / tick))
  return Math.min(target, shown + Math.max(3, Math.ceil((target - shown) / steps)))
}

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
  // animate 挂载时捕获（历史消息不该因为父组件重渲染就开始动画）；
  // 但**长度判据不能一起冻结**——流式消息挂载时才几十字，冻了就永远按短消息走（#14）。
  const anim = useRef(animate).current
  const [shown, setShown] = useState(anim ? 0 : text.length)
  const targetRef = useRef(text.length)
  targetRef.current = text.length
  const onGrowRef = useRef(onGrow)
  onGrowRef.current = onGrow
  // 按当前长度取步进间隔，随文本增长实时变慢
  const tick = tickMsFor(text.length)
  const tickRef = useRef(tick)
  tickRef.current = tick

  const done = !anim || shown >= text.length
  useEffect(() => {
    if (done) return
    const t = setInterval(() => {
      setShown((s) => {
        const next = revealStep(s, targetRef.current, tickRef.current)
        if (next !== s) onGrowRef.current?.()
        return next
      })
    }, tick)
    return () => clearInterval(t)
    // done 翻转或档位变化才重建定时器：text 继续增长（流式追加）时同一定时器接着追
  }, [done, tick])

  return <Markdown text={anim && shown < text.length ? text.slice(0, shown) : text} />
}
