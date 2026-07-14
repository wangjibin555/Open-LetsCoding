import { describe, expect, it } from 'vitest'
import { isMainSession } from './sessionFilter'

describe('isMainSession（主会话过滤）', () => {
  it('普通项目目录 → 主会话', () => {
    expect(isMainSession('/Users/dev/Desktop/LetsCoding')).toBe(true)
    expect(isMainSession('/Users/dev/Desktop/web-console')).toBe(true)
    expect(isMainSession('/Users/dev/Desktop')).toBe(true)
  })

  it('临时目录（探针/冒烟/workflow）→ 排除', () => {
    expect(isMainSession('/private/var/folders/2z/xx/T/lc-int-probe-34101')).toBe(false)
    expect(isMainSession('/var/folders/2z/xx/T/letscoding-m2-smoke-10792')).toBe(false)
    expect(isMainSession('/tmp/play')).toBe(false)
    expect(isMainSession('/private/tmp/claude-501/scratch')).toBe(false)
  })

  it('agent worktree → 排除', () => {
    expect(
      isMainSession('/Users/dev/Desktop/payments-api/.claude/worktrees/xenodochial-merkle-06009e')
    ).toBe(false)
  })

  it('cwd 缺失 → 保留（信息不足不误杀）', () => {
    expect(isMainSession(undefined)).toBe(true)
  })

  it('前缀相似但非临时目录 → 保留（不过度匹配）', () => {
    expect(isMainSession('/Users/dev/tmp/project')).toBe(true)
    expect(isMainSession('/Users/dev/Desktop/worktrees-notes')).toBe(true)
  })
})
