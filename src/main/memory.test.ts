import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryService } from './memory'
import { StateStore } from './store'

let dir: string
let projectsDir: string
let store: StateStore
let memory: MemoryService

const CWD = '/Users/test/proj-a'
const SLUG = CWD.replace(/[^a-zA-Z0-9]/g, '-')

const draft = {
  session_id: 'h-1',
  cwd: CWD,
  name: 'order-bind-idempotency',
  type: 'feedback' as const,
  description: '绑定重试必须带幂等键',
  body: '重试需带幂等键。\n\n**Why:** 上游不去重\n**How to apply:** retry 时注入 trace_id'
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'letscoding-mem-'))
  projectsDir = join(dir, 'projects')
  store = new StateStore(join(dir, 'state.db'))
  memory = new MemoryService(projectsDir, store)
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('MemoryService (D6)', () => {
  it('no disk writes before confirmation', () => {
    store.addInboxItem(draft)
    expect(existsSync(projectsDir)).toBe(false) // 收件箱阶段整个 projects 目录都不该出现
  })

  it('accept writes spec-compliant frontmatter file and MEMORY.md index', () => {
    const id = store.addInboxItem(draft)
    const { filePath } = memory.accept(id)
    expect(filePath).toBe(join(projectsDir, SLUG, 'memory', 'order-bind-idempotency.md'))

    const text = readFileSync(filePath, 'utf8')
    expect(text).toMatch(/^---\nname: order-bind-idempotency\ndescription: /)
    expect(text).toContain('metadata:\n  type: feedback')
    expect(text).toContain('**Why:**')

    const index = readFileSync(join(projectsDir, SLUG, 'memory', 'MEMORY.md'), 'utf8')
    expect(index).toContain('# Memory Index')
    expect(index).toContain('- [order-bind-idempotency](order-bind-idempotency.md) — 绑定重试必须带幂等键')

    expect(store.getInboxItem(id)!.status).toBe('accepted')
  })

  it('double-accept throws; discard writes nothing', () => {
    const id = store.addInboxItem(draft)
    memory.accept(id)
    expect(() => memory.accept(id)).toThrow(/already accepted/)

    const id2 = store.addInboxItem({ ...draft, name: 'another-memory' })
    memory.discard(id2)
    expect(existsSync(join(projectsDir, SLUG, 'memory', 'another-memory.md'))).toBe(false)
    expect(store.getInboxItem(id2)!.status).toBe('discarded')
  })

  it('refuses to overwrite an existing memory file (red line) and keeps item pending', () => {
    const id = store.addInboxItem(draft)
    memory.accept(id)
    const id2 = store.addInboxItem(draft) // 同名再次提议
    expect(() => memory.accept(id2)).toThrow(/同名记忆已存在/)
    expect(store.getInboxItem(id2)!.status).toBe('pending') // 写失败不留 accepted 假状态
  })

  it('index dedupes and appends across multiple accepts', () => {
    memory.accept(store.addInboxItem(draft))
    memory.accept(store.addInboxItem({ ...draft, name: 'second-memory', description: '第二条' }))
    const index = readFileSync(join(projectsDir, SLUG, 'memory', 'MEMORY.md'), 'utf8')
    expect(index.match(/order-bind-idempotency\.md/g)?.length).toBe(1)
    expect(index).toContain('- [second-memory](second-memory.md) — 第二条')
  })

  it('listMemories parses frontmatter summaries, excludes MEMORY.md, carries slug', () => {
    memory.accept(store.addInboxItem(draft))
    const list = memory.listMemories(CWD)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      name: 'order-bind-idempotency',
      type: 'feedback',
      description: '绑定重试必须带幂等键',
      slug: SLUG
    })
    expect(readdirSync(join(projectsDir, SLUG, 'memory'))).toContain('MEMORY.md')
  })
})

describe('MemoryService editing / soft-delete (D9)', () => {
  const memDir = (): string => join(projectsDir, SLUG, 'memory')
  const filePath = (): string => join(memDir(), 'order-bind-idempotency.md')

  it('updateMemory changes body/description/type and syncs MEMORY.md; name unchanged', () => {
    memory.accept(store.addInboxItem(draft))
    memory.updateMemory(SLUG, 'order-bind-idempotency.md', {
      description: '改后的描述',
      type: 'project',
      body: '新的正文内容'
    })
    const text = readFileSync(filePath(), 'utf8')
    expect(text).toContain('name: order-bind-idempotency') // name 不变
    expect(text).toContain('description: 改后的描述')
    expect(text).toContain('metadata:\n  type: project')
    expect(text).toContain('新的正文内容')

    const index = readFileSync(join(memDir(), 'MEMORY.md'), 'utf8')
    expect(index).toContain('- [order-bind-idempotency](order-bind-idempotency.md) — 改后的描述')
    // 索引不留旧描述那行
    expect(index).not.toContain('绑定重试必须带幂等键')
    expect(index.match(/order-bind-idempotency\.md/g)?.length).toBe(1) // 不重复
  })

  it('updateMemory partial patch keeps untouched fields', () => {
    memory.accept(store.addInboxItem(draft))
    memory.updateMemory(SLUG, 'order-bind-idempotency.md', { description: '仅改描述' })
    const list = memory.listMemories(CWD)
    expect(list[0].description).toBe('仅改描述')
    expect(list[0].type).toBe('feedback') // 未动
    expect(list[0].body).toContain('**Why:**') // 未动
  })

  it('softDelete moves file to SQLite trash, removes from disk + index; listMemories excludes it', () => {
    memory.accept(store.addInboxItem(draft))
    const { trashId } = memory.softDeleteMemory(SLUG, 'order-bind-idempotency.md')

    expect(existsSync(filePath())).toBe(false) // 原文件已删
    expect(existsSync(join(memDir(), '.trash'))).toBe(false) // 不在 ~/.claude 建 .trash（D5）
    expect(memory.listMemories(CWD)).toHaveLength(0)

    const index = readFileSync(join(memDir(), 'MEMORY.md'), 'utf8')
    expect(index).not.toContain('order-bind-idempotency.md') // 索引已移除

    const trash = memory.listTrash(CWD)
    expect(trash).toHaveLength(1)
    expect(trash[0]).toMatchObject({ id: trashId, name: 'order-bind-idempotency', slug: SLUG })
  })

  it('restore writes file back, restores index, clears trash entry', () => {
    memory.accept(store.addInboxItem(draft))
    const { trashId } = memory.softDeleteMemory(SLUG, 'order-bind-idempotency.md')
    memory.restoreMemory(trashId)

    expect(existsSync(filePath())).toBe(true)
    expect(memory.listMemories(CWD)).toHaveLength(1)
    expect(memory.listTrash(CWD)).toHaveLength(0)
    const index = readFileSync(join(memDir(), 'MEMORY.md'), 'utf8')
    expect(index).toContain('- [order-bind-idempotency](order-bind-idempotency.md) —')
  })

  it('restore refuses when a same-name file already exists', () => {
    memory.accept(store.addInboxItem(draft))
    const { trashId } = memory.softDeleteMemory(SLUG, 'order-bind-idempotency.md')
    memory.accept(store.addInboxItem(draft)) // 重新沉淀同名
    expect(() => memory.restoreMemory(trashId)).toThrow(/同名记忆已存在/)
    expect(memory.listTrash(CWD)).toHaveLength(1) // 恢复失败不清回收站
  })

  it('updateMemory / softDelete reject MEMORY.md and missing files', () => {
    memory.accept(store.addInboxItem(draft))
    expect(() => memory.updateMemory(SLUG, 'MEMORY.md', { body: 'x' })).toThrow(/非法记忆文件名/)
    expect(() => memory.softDeleteMemory(SLUG, 'nope.md')).toThrow(/不存在/)
  })

  it('rejects path traversal in file / slug (D9/D5 boundary)', () => {
    // 在 memory 目录外放一个诱饵 .md，确认穿越无法命中它
    const bait = join(dir, 'bait.md')
    writeFileSync(bait, '---\nname: bait\n---\nsecret')
    memory.accept(store.addInboxItem(draft))

    // file 含目录分量 / .. 一律拒
    expect(() => memory.updateMemory(SLUG, '../../../bait.md', { body: 'x' })).toThrow(/非法记忆文件名/)
    expect(() => memory.softDeleteMemory(SLUG, '../../../bait.md')).toThrow(/非法记忆文件名/)
    expect(() => memory.updateMemory(SLUG, 'sub/x.md', { body: 'x' })).toThrow(/非法记忆文件名/)
    // slug 含非 [A-Za-z0-9-] 一律拒
    expect(() => memory.softDeleteMemory('../../..', 'bait.md')).toThrow(/非法记忆目录/)
    expect(() => memory.updateMemory('a/b', 'x.md', { body: 'x' })).toThrow(/非法记忆目录/)

    // 诱饵文件毫发无损
    expect(existsSync(bait)).toBe(true)
    expect(readFileSync(bait, 'utf8')).toContain('secret')
  })

  it('restore refuses traversal coordinates smuggled into trash', () => {
    // 直接往回收站塞越界坐标，restore 必须拒绝（纵深防御，不做越界写）
    const bait = join(dir, 'restore-bait.md')
    const trashId = store.addTrashItem({
      slug: '../../..',
      file: 'restore-bait.md',
      name: 'restore-bait',
      content: 'evil'
    })
    expect(() => memory.restoreMemory(trashId)).toThrow(/非法记忆目录/)
    expect(existsSync(bait)).toBe(false)
  })
})

describe('MemoryService consolidation (D9 · M8.2)', () => {
  const memDir = (): string => join(projectsDir, SLUG, 'memory')

  function seedTwo(): void {
    memory.accept(store.addInboxItem({ ...draft, name: 'dup-a', description: '幂等键 A' }))
    memory.accept(
      store.addInboxItem({ ...draft, name: 'dup-b', description: '幂等键 B', body: '重复内容 B' })
    )
  }

  function proposal(over: Partial<Record<string, unknown>> = {}): number {
    return store.addConsolidationItem({
      session_id: 'consolidate-1',
      cwd: CWD,
      name: 'idempotency-merged',
      type: 'feedback',
      description: '合并后的幂等键要点',
      body: '合并正文：A 与 B 的关键点都保留',
      sources: JSON.stringify(['dup-a.md', 'dup-b.md']),
      rationale: '两条都在讲幂等键，可合并',
      ...over
    } as Parameters<typeof store.addConsolidationItem>[0])
  }

  it('accept writes merged file, soft-deletes sources, updates index', () => {
    seedTwo()
    const id = proposal()
    const { filePath } = memory.acceptConsolidation(id)

    expect(filePath).toBe(join(memDir(), 'idempotency-merged.md'))
    expect(existsSync(filePath)).toBe(true)
    // 两条源都进了回收站、原文件消失
    expect(existsSync(join(memDir(), 'dup-a.md'))).toBe(false)
    expect(existsSync(join(memDir(), 'dup-b.md'))).toBe(false)
    expect(memory.listTrash(CWD)).toHaveLength(2)

    const names = memory.listMemories(CWD).map((m) => m.name)
    expect(names).toEqual(['idempotency-merged'])

    const index = readFileSync(join(memDir(), 'MEMORY.md'), 'utf8')
    expect(index).toContain('- [idempotency-merged](idempotency-merged.md) — 合并后的幂等键要点')
    expect(index).not.toContain('dup-a.md')
    expect(index).not.toContain('dup-b.md')
    expect(store.getConsolidationItem(id)!.status).toBe('accepted')
  })

  it('merged name may reuse a source name (that source is soft-deleted first)', () => {
    seedTwo()
    const id = proposal({ name: 'dup-a' }) // 合并结果沿用某源的名字
    memory.acceptConsolidation(id)
    expect(existsSync(join(memDir(), 'dup-a.md'))).toBe(true) // 新内容写在该路径
    expect(memory.listMemories(CWD).map((m) => m.name)).toEqual(['dup-a'])
    // dup-a 与 dup-b 的原件都进回收站（dup-a 被软删后新文件才写入）
    expect(memory.listTrash(CWD)).toHaveLength(2)
  })

  it('refuses when a source no longer exists (no partial mutation)', () => {
    seedTwo()
    const id = proposal({ sources: JSON.stringify(['dup-a.md', 'ghost.md']) })
    expect(() => memory.acceptConsolidation(id)).toThrow(/源记忆已不存在/)
    // 拒绝时不动任何文件
    expect(existsSync(join(memDir(), 'dup-a.md'))).toBe(true)
    expect(memory.listTrash(CWD)).toHaveLength(0)
    expect(store.getConsolidationItem(id)!.status).toBe('pending')
  })

  it('refuses when merged name collides with an unrelated existing memory', () => {
    seedTwo()
    memory.accept(store.addInboxItem({ ...draft, name: 'unrelated', description: '无关记忆' }))
    const id = proposal({ name: 'unrelated' })
    expect(() => memory.acceptConsolidation(id)).toThrow(/冲突/)
    expect(memory.listMemories(CWD)).toHaveLength(3) // 全无改动
  })

  it('listConsolidation filters by cwd; discard flips status without touching disk', () => {
    seedTwo()
    const id = proposal()
    expect(memory.listConsolidation(CWD)).toHaveLength(1)
    expect(memory.listConsolidation('/other/dir')).toHaveLength(0)
    memory.discardConsolidation(id)
    expect(memory.listConsolidation(CWD)).toHaveLength(0)
    expect(memory.listMemories(CWD)).toHaveLength(2) // 源记忆未动
    expect(store.getConsolidationItem(id)!.status).toBe('discarded')
  })

  it('sources path traversal is rejected at accept', () => {
    seedTwo()
    const id = proposal({ sources: JSON.stringify(['dup-a.md', '../../../etc/x.md']) })
    expect(() => memory.acceptConsolidation(id)).toThrow(/非法记忆文件名/)
    expect(memory.listMemories(CWD)).toHaveLength(2)
  })
})
