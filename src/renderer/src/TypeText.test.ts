import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { revealStep, tickMsFor } from './TypeText'

const SRC = readFileSync(resolve(__dirname, 'TypeText.tsx'), 'utf8')
// 形态断言只看代码：否则解释历史的注释会喂自己的闸（本文件初版就栽在这——
// 头注释里提了一句已删除的常量名，「不得复活」那条当场自误报）
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

/** 整段 Markdown 重解析成本，实测标定（Electron 35 / Chromium）：1k→1.0ms，12k→8.4ms，40k→32.9ms */
const parseMs = (chars: number): number => chars / 1200

/**
 * 仿真组件的步进循环，复刻实测探针的路径：短文本挂载 → 一次性长到 L → 稳态继续追加。
 * 统计「交给 Markdown 的新字符串」总解析开销占墙钟的比例。
 *
 * 只有 shown 变了才产生新字符串（否则 Markdown 的 memo 命中，免费）——
 * 这正是 60Hz 重渲染下开销仍被 tick 卡住的原因。
 */
function busyRatio(L: number, seconds: number, fixedTick?: number): number {
  const total = seconds * 1000
  let shown = 0
  let nextAt = 0
  let cost = 0
  for (let t = 0; t < total; t++) {
    const text = L + Math.floor(t / 2) // 稳态后仍以 500 字/秒追加
    if (t < nextAt) continue
    const tick = fixedTick ?? tickMsFor(text)
    nextAt = t + tick
    const next = revealStep(shown, text, tick)
    if (next !== shown) {
      shown = next
      cost += parseMs(next)
    }
  }
  return cost / total
}

/** 积压 target 全部显示完所需的墙钟毫秒 */
function catchUpMs(target: number, tick: number): number {
  let s = 0
  let ticks = 0
  while (s < target && ticks < 100_000) {
    s = revealStep(s, target, tick)
    ticks++
  }
  return ticks * tick
}

describe('revealStep（D12.5：积压自适应步进）', () => {
  it('单调递进且必达目标，到达即停', () => {
    let s = 0
    const target = 500
    let ticks = 0
    while (s < target && ticks < 10_000) {
      const next = revealStep(s, target)
      expect(next).toBeGreaterThan(s)
      s = next
      ticks++
    }
    expect(s).toBe(target)
    expect(revealStep(target, target)).toBe(target)
    expect(revealStep(target + 5, target)).toBe(target)
  })

  it('积压越大步子越大（大块到达快速追平）', () => {
    expect(revealStep(0, 4000)).toBeGreaterThanOrEqual(300)
    expect(revealStep(0, 40) - 0).toBeLessThanOrEqual(4)
    // 4000 字积压在约 1.5s（24ms × ≤65 tick）内追平
    let s = 0
    let ticks = 0
    while (s < 4000) {
      s = revealStep(s, 4000)
      ticks++
    }
    expect(ticks).toBeLessThanOrEqual(65)
  })

  it('短尾不悬挂：最小步长 3，剩 1-2 字一步到位', () => {
    expect(revealStep(38, 40)).toBe(40)
  })

  it('tick 变慢时步子相应变大：追平的墙钟时间不劣于 24ms 基线（#14）', () => {
    // 步长按 288ms/tick 折算，不是恒定 12 步——否则 tick 拉到 325ms 后
    // 40k 积压要 93×325ms≈30s 才显示完，消息末尾会明显吊着。
    // 断言墙钟而非 tick 数：基线（tick=24）本身就是 ~2.2s 的指数衰减。
    const base = catchUpMs(40_000, 24)
    expect(base).toBeLessThan(3_000)
    for (const tick of [50, 100, 150, 325, 500]) {
      expect(catchUpMs(40_000, tick)).toBeLessThanOrEqual(base * 1.2)
    }
  })
})

describe('tickMsFor：整段重解析的主线程预算闸（#14）', () => {
  it('负向红线：≤4000 字逐帧不变 —— 实测真实会话最长 3694 字，现存消息观感一律不动', () => {
    for (const n of [0, 50, 194, 729, 1647, 3694, 4000]) expect(tickMsFor(n)).toBe(24)
    // 越过红线才允许变慢
    expect(tickMsFor(4001)).toBeGreaterThan(24)
  })

  it('单调不减：越长只会更慢，不会反弹', () => {
    let prev = 0
    for (let n = 0; n <= 120_000; n += 137) {
      const t = tickMsFor(n)
      expect(t).toBeGreaterThanOrEqual(prev)
      prev = t
    }
  })

  it('预算断言：任意长度下「解析 / 步进间隔」都被压在 15% 以内', () => {
    for (const L of [6_000, 12_000, 20_000, 40_000, 80_000]) {
      expect(parseMs(L) / tickMsFor(L)).toBeLessThan(0.15)
    }
  })

  it('目的断言：40k 字消息流式期间主线程占用 < 20%（实测基线 90.3%）', () => {
    expect(busyRatio(40_000, 10)).toBeLessThan(0.2)
    expect(busyRatio(12_000, 10)).toBeLessThan(0.2)
    // 反向对照：固定 24ms 的旧实现在同一指标下必须打满，否则这个指标没有鉴别力
    expect(busyRatio(40_000, 10, 24)).toBeGreaterThan(0.8)
  })

  it('手段断言：长度判据取自当前 text，不得在挂载时被 useRef 冻结', () => {
    // 这正是 #14 的根因形态：useRef(animate && text.length <= 某常量)
    for (const m of CODE.matchAll(/useRef\(([^)]*)\)\.current/g)) {
      expect(m[1]).not.toMatch(/\.length/)
    }
    expect(CODE).toMatch(/tickMsFor\(text\.length\)/)
    // 定时器必须随档位重建，否则 tick 算了也用不上
    expect(CODE).toMatch(/\}, \[done, tick\]\)/)
    // 已删除的反向闸不得复活（关掉动画反而更卡：12k 实测 47.6% vs 35.4%）
    expect(CODE).not.toMatch(/MAX_ANIMATE_CHARS/)
  })
})
