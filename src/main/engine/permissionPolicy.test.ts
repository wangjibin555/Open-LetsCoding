import { describe, expect, it } from 'vitest'
import { shouldAutoAllow, UI_TO_SDK_MODE } from './permissionPolicy'

describe('UI_TO_SDK_MODE（D14 映射表逐字钉死）', () => {
  it('负向红线：既有三档映射字面不变；bypass 映射 acceptEdits 而非 SDK 裸跳档', () => {
    expect(UI_TO_SDK_MODE).toEqual({
      'confirm-each': 'default',
      'plan-first': 'plan',
      auto: 'acceptEdits',
      bypass: 'acceptEdits'
    })
  })
})

describe('shouldAutoAllow（bypass 放行真值表）', () => {
  it('bypass + 非危险 → 放行', () => {
    expect(shouldAutoAllow('bypass', null)).toBe(true)
  })

  it('bypass + 危险清单命中 → 不放行（D7 照常弹卡）', () => {
    expect(shouldAutoAllow('bypass', 'rm -rf*')).toBe(false)
  })

  it('其余三档与未知会话（undefined）一律不放行', () => {
    expect(shouldAutoAllow('auto', null)).toBe(false)
    expect(shouldAutoAllow('plan-first', null)).toBe(false)
    expect(shouldAutoAllow('confirm-each', null)).toBe(false)
    expect(shouldAutoAllow(undefined, null)).toBe(false)
    // 「任意」含危险命中：非 bypass 档 + 危险同样不经此路放行（走弹卡）
    expect(shouldAutoAllow('auto', 'rm -rf*')).toBe(false)
  })
})
