import { describe, expect, it } from 'vitest'
import { allowResult, shouldAutoAllow, UI_TO_SDK_MODE } from './permissionPolicy'

// issue #5：allow 分支缺 updatedInput → SDK 运行时 schema 的 union 两条都不匹配 →
// `ZodError: expected record, received undefined`，用户点了「同意」工具也执行不了。
// 断言打在**返回的对象**上，不是 grep 常量。
describe('allowResult（放行结果唯一构造点，#5）', () => {
  const input = { command: 'ls /tmp | head -3', description: '列目录' }

  it('必须带 updatedInput —— 缺它整个权限请求以 ZodError 失败', () => {
    const r = allowResult(input)
    expect(r).toEqual({ behavior: 'allow', updatedInput: input })
    expect((r as { updatedInput?: unknown }).updatedInput).toBeDefined()
  })

  it('updatedInput 逐字段等于原始入参 —— 绝不替用户改写要执行的命令', () => {
    const r = allowResult(input) as { updatedInput: Record<string, unknown> }
    expect(r.updatedInput).toEqual(input)
    expect(r.updatedInput.command).toBe('ls /tmp | head -3')
  })

  it('「总是允许」带上规则集，且 updatedInput 仍在', () => {
    const rules = [{ type: 'addRules' as const }] as never
    const r = allowResult(input, rules) as Record<string, unknown>
    expect(r.behavior).toBe('allow')
    expect(r.updatedInput).toEqual(input)
    expect(r.updatedPermissions).toBe(rules)
  })

  it('空规则集不产出 updatedPermissions 字段（别塞空数组给 SDK）', () => {
    expect(allowResult(input, [])).toEqual({ behavior: 'allow', updatedInput: input })
  })
})

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
