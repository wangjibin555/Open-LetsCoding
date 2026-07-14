import { describe, expect, it } from 'vitest'
import { normalizeBaseUrl } from './gateway'

describe('normalizeBaseUrl', () => {
  it('strips trailing /v1 so SDK does not build /v1/v1/messages', () => {
    expect(normalizeBaseUrl('https://llm.example.com/v1')).toBe('https://llm.example.com')
  })
  it('strips /v1 with trailing slash', () => {
    expect(normalizeBaseUrl('https://llm.example.com/v1/')).toBe('https://llm.example.com')
  })
  it('leaves a root base url untouched', () => {
    expect(normalizeBaseUrl('https://llm.example.com')).toBe('https://llm.example.com')
  })
  it('strips a bare trailing slash on root', () => {
    expect(normalizeBaseUrl('https://llm.example.com/')).toBe('https://llm.example.com')
  })
  it('trims surrounding whitespace', () => {
    expect(normalizeBaseUrl('  https://llm.example.com/v1  ')).toBe('https://llm.example.com')
  })
  it('is idempotent', () => {
    const once = normalizeBaseUrl('https://llm.example.com/v1')
    expect(normalizeBaseUrl(once)).toBe(once)
  })
  it('keeps a non-version path segment', () => {
    // 仅剥版本前缀 /v1，不误伤自定义网关路径
    expect(normalizeBaseUrl('https://api.example.com/gateway')).toBe('https://api.example.com/gateway')
  })
  it('negative red line: /v1/models resolves the same before and after normalization', () => {
    // new URL 的绝对路径特性使 fetchModels 对规范化免疫（列表/spend 行为不变）
    const withV1 = new URL('/v1/models', 'https://llm.example.com/v1').href
    const root = new URL('/v1/models', normalizeBaseUrl('https://llm.example.com/v1')).href
    expect(root).toBe(withV1)
    expect(root).toBe('https://llm.example.com/v1/models')
  })
})
