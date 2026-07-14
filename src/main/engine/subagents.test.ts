import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { readSubagents } from './subagents'

const projects = mkdtempSync(join(tmpdir(), 'lc-subagents-test-'))
const CWD = '/Users/x/proj'
const SLUG = CWD.replace(/[^a-zA-Z0-9]/g, '-')
const SID = 'sess-1'

function seedAgent(name: string, meta: object, lines: object[]): void {
  const dir = join(projects, SLUG, SID, 'subagents')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.meta.json`), JSON.stringify(meta))
  writeFileSync(join(dir, `${name}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'))
}

afterAll(() => rmSync(projects, { recursive: true, force: true }))

describe('readSubagents（子 agent 步骤读取）', () => {
  it('按 toolUseId 关联，text/tool_use 摘要成步骤', () => {
    seedAgent(
      'agent-a1',
      { toolUseId: 'toolu_1', description: '找扁平化引用', agentType: 'Explore' },
      [
        { type: 'user', message: { content: 'prompt' } },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: '先看目录结构' },
              { type: 'tool_use', name: 'Bash', input: { command: 'ls src' } }
            ]
          }
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b.ts' } }] }
        }
      ]
    )
    const out = readSubagents(projects, CWD, SID)
    expect(out['toolu_1']).toBeDefined()
    expect(out['toolu_1'].description).toBe('找扁平化引用')
    expect(out['toolu_1'].steps.map((s) => s.label)).toEqual([
      '先看目录结构',
      'Bash ls src',
      'Read /a/b.ts'
    ])
  })

  it('损坏的 meta/jsonl 行不影响其余；无 subagents 目录返回空表', () => {
    seedAgent('agent-bad', { toolUseId: 'toolu_2', description: 'ok' }, [])
    writeFileSync(join(projects, SLUG, SID, 'subagents', 'agent-broken.meta.json'), '{oops')
    writeFileSync(join(projects, SLUG, SID, 'subagents', 'agent-bad.jsonl'), 'not-json\n')
    const out = readSubagents(projects, CWD, SID)
    expect(out['toolu_2']).toBeDefined()
    expect(readSubagents(projects, CWD, 'no-such-session')).toEqual({})
  })

  it('步骤数量有上限（防超大 transcript 撑爆 IPC）', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `step ${i}` } }] }
    }))
    seedAgent('agent-big', { toolUseId: 'toolu_3' }, many)
    const out = readSubagents(projects, CWD, SID)
    expect(out['toolu_3'].steps.length).toBeLessThanOrEqual(150)
  })
})
