import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { readSessionTasks } from './tasks'

const root = mkdtempSync(join(tmpdir(), 'lc-tasks-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function seed(sessionId: string, files: Record<string, unknown>): void {
  const dir = join(root, sessionId)
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content))
  }
}

describe('readSessionTasks', () => {
  it('按数字序读取并解析 subject/status/activeForm', () => {
    seed('aaaaaaaa-1111-2222-3333-444444444444', {
      '2.json': { id: '2', subject: '任务二', status: 'in_progress', activeForm: '做任务二' },
      '1.json': { id: '1', subject: '任务一', status: 'completed' },
      '10.json': { id: '10', subject: '任务十', status: 'pending' }
    })
    const tasks = readSessionTasks(root, 'aaaaaaaa-1111-2222-3333-444444444444')
    expect(tasks.map((t) => t.subject)).toEqual(['任务一', '任务二', '任务十'])
    expect(tasks[1]).toMatchObject({ status: 'in_progress', activeForm: '做任务二' })
    expect(tasks[0].activeForm).toBeNull()
  })

  it('坏 JSON 单文件跳过、无 subject 跳过、目录不存在返回空', () => {
    seed('bbbbbbbb-1111-2222-3333-444444444444', {
      '1.json': '{broken',
      '2.json': { id: '2', status: 'pending' },
      '3.json': { id: '3', subject: '有效', status: 'pending' }
    })
    expect(readSessionTasks(root, 'bbbbbbbb-1111-2222-3333-444444444444').map((t) => t.subject)).toEqual(['有效'])
    expect(readSessionTasks(root, 'cccccccc-1111-2222-3333-444444444444')).toEqual([])
  })

  it('非 uuid 形态的 sessionId 拒绝（防路径穿越）', () => {
    expect(readSessionTasks(root, '../etc')).toEqual([])
    expect(readSessionTasks(root, 'x/../../y')).toEqual([])
  })
})
