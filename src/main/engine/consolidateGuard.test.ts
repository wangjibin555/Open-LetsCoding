import { describe, expect, it } from 'vitest'
import { CONSOLIDATE_DISALLOWED_TOOLS } from './consolidateGuard'

describe('consolidate guard (D9 · 模型对既有文件零写权)', () => {
  it('blocks every file-write and shell-exec tool', () => {
    for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']) {
      expect(CONSOLIDATE_DISALLOWED_TOOLS).toContain(t)
    }
  })

  it('does not block the read-only or propose tools', () => {
    // 只读工具与 MCP 提议工具不应被硬闸屏蔽（否则整理无法读/无法提议）
    for (const t of ['Read', 'Grep', 'Glob', 'mcp__letscoding__propose_consolidation']) {
      expect(CONSOLIDATE_DISALLOWED_TOOLS).not.toContain(t)
    }
  })
})
