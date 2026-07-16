import { describe, expect, it } from 'vitest'
import { parseLearnConfig } from './learn'

describe('parseLearnConfig（D16 配置解析）', () => {
  it('空/坏 JSON/缺 dir → 未配置', () => {
    expect(parseLearnConfig(null)).toBeNull()
    expect(parseLearnConfig(undefined)).toBeNull()
    expect(parseLearnConfig('')).toBeNull()
    expect(parseLearnConfig('not json')).toBeNull()
    expect(parseLearnConfig('{"port":8989}')).toBeNull()
    expect(parseLearnConfig('{"dir":"  "}')).toBeNull()
  })

  it('port 缺省 8989；dir 去首尾空白', () => {
    expect(parseLearnConfig('{"dir":" /a/b "}')).toEqual({ dir: '/a/b', port: 8989 })
  })

  it('合法端口透传；越界/非整数拒绝', () => {
    expect(parseLearnConfig('{"dir":"/a","port":3000}')).toEqual({ dir: '/a', port: 3000 })
    expect(parseLearnConfig('{"dir":"/a","port":"8989"}')).toEqual({ dir: '/a', port: 8989 })
    expect(parseLearnConfig('{"dir":"/a","port":0}')).toBeNull()
    expect(parseLearnConfig('{"dir":"/a","port":70000}')).toBeNull()
    expect(parseLearnConfig('{"dir":"/a","port":80.5}')).toBeNull()
  })
})
