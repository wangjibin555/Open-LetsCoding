import { describe, expect, it } from 'vitest'
import { MAX_ANIMATE_CHARS, revealStep } from './TypeText'

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

  it('超长禁用动画的阈值常量有限', () => {
    expect(MAX_ANIMATE_CHARS).toBeGreaterThan(1000)
    expect(Number.isFinite(MAX_ANIMATE_CHARS)).toBe(true)
  })
})
