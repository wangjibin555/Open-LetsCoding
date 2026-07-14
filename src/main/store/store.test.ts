import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { StateStore } from './index'

let dir: string
let store: StateStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'letscoding-store-'))
  store = new StateStore(join(dir, 'state.db'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('schema & seeds', () => {
  it('seeds builtin danger rules (D7)', () => {
    const rules = store.listDangerRules()
    expect(rules.length).toBeGreaterThanOrEqual(5)
    expect(rules.every((r) => r.builtin === 1 && r.enabled === 1)).toBe(true)
  })

  it('seeding is idempotent across reopen', () => {
    const before = store.listDangerRules().length
    store.close()
    store = new StateStore(join(dir, 'state.db'))
    expect(store.listDangerRules().length).toBe(before)
  })
})

describe('danger rules red line (D7)', () => {
  it('refuses to disable builtin rules', () => {
    const builtin = store.listDangerRules()[0]
    expect(() => store.setDangerRuleEnabled(builtin.id, false)).toThrow(/cannot be disabled/)
  })

  it('allows toggling user-added rules', () => {
    store.addDangerRule('drop\\s+database')
    const rule = store.listDangerRules().find((r) => r.builtin === 0)!
    store.setDangerRuleEnabled(rule.id, false)
    expect(store.listDangerRules().find((r) => r.id === rule.id)!.enabled).toBe(0)
  })

  it('refuses to remove builtin rules, removes user-added ones', () => {
    const builtin = store.listDangerRules().find((r) => r.builtin === 1)!
    expect(() => store.removeDangerRule(builtin.id)).toThrow(/cannot be removed/)
    store.addDangerRule('custom\\s+danger')
    const user = store.listDangerRules().find((r) => r.pattern === 'custom\\s+danger')!
    store.removeDangerRule(user.id)
    expect(store.listDangerRules().some((r) => r.id === user.id)).toBe(false)
  })

  it('whitelist add/remove roundtrip', () => {
    store.addWhitelist('git status:*')
    store.addWhitelist('npm run test:*')
    expect(store.listWhitelist()).toEqual(['git status:*', 'npm run test:*'])
    store.removeWhitelist('git status:*')
    expect(store.listWhitelist()).toEqual(['npm run test:*'])
  })

  it('rejects malformed whitelist and danger patterns (D7 audit hardening)', () => {
    expect(() => store.addWhitelist('')).toThrow(/empty/)
    expect(() => store.addWhitelist('  ')).toThrow(/empty/)
    expect(() => store.addWhitelist('evil(:*')).toThrow(/parentheses/)
    expect(() => store.addDangerRule('')).toThrow(/empty/)
    expect(() => store.addDangerRule('([bad')).toThrow(/valid regex/)
    store.addWhitelist('git log --oneline:*') // 含空格的合法模式必须放行
    expect(store.listWhitelist()).toContain('git log --oneline:*')
  })
})

describe('memory inbox (D6)', () => {
  const draft = {
    session_id: 's-1',
    cwd: '/tmp/proj',
    name: 'test-memory',
    type: 'feedback' as const,
    description: 'a test memory',
    body: 'body\n\n**Why:** because\n**How to apply:** apply'
  }

  it('pending → accepted transition, no double-processing', () => {
    const id = store.addInboxItem(draft)
    expect(store.listInbox('pending')).toHaveLength(1)
    const accepted = store.setInboxStatus(id, 'accepted')
    expect(accepted.status).toBe('accepted')
    expect(store.listInbox('pending')).toHaveLength(0)
    expect(() => store.setInboxStatus(id, 'discarded')).toThrow(/already accepted/)
  })

  it('rejects invalid memory type at DB level', () => {
    expect(() =>
      store.addInboxItem({ ...draft, type: 'invalid' as never })
    ).toThrow()
  })
})

describe('session meta & settings (D5/D8)', () => {
  it('upserts session decorations', () => {
    store.upsertSessionMeta({
      session_id: 's-9',
      group_name: 'payments-api',
      pinned: 1,
      archived: 0,
      hidden: 0,
      fallback_note: null
    })
    store.upsertSessionMeta({
      session_id: 's-9',
      group_name: 'web-console',
      pinned: 0,
      archived: 0,
      hidden: 0,
      fallback_note: 'moved'
    })
    const meta = store.getSessionMeta('s-9')!
    expect(meta.group_name).toBe('web-console')
    expect(meta.fallback_note).toBe('moved')
  })

  it('model toggles: disabled set reflects state, default enabled', () => {
    expect(store.disabledModels().size).toBe(0)
    store.setModelEnabled('openrouter/x/model-a', false)
    store.setModelEnabled('openrouter/x/model-b', true)
    expect(store.disabledModels()).toEqual(new Set(['openrouter/x/model-a']))
    store.setModelEnabled('openrouter/x/model-a', true)
    expect(store.disabledModels().size).toBe(0)
  })

  it('settings roundtrip', () => {
    expect(store.getSetting('base_url')).toBeNull()
    store.setSetting('base_url', 'https://llm.example.com')
    store.setSetting('base_url', 'https://llm2.example.com')
    expect(store.getSetting('base_url')).toBe('https://llm2.example.com')
  })
})

describe('session groups (M6)', () => {
  it('create/list/collapse/delete, reassigns members to ungrouped', () => {
    store.createGroup('payments-api')
    store.createGroup('payments-api') // idempotent
    expect(store.listGroups().map((g) => g.name)).toEqual(['payments-api'])

    store.upsertSessionMeta({
      session_id: 's-1',
      group_name: 'payments-api',
      pinned: 0,
      archived: 0,
      hidden: 0,
      fallback_note: null
    })
    store.setGroupCollapsed('payments-api', true)
    expect(store.listGroups()[0].collapsed).toBe(1)

    store.deleteGroup('payments-api')
    expect(store.listGroups()).toHaveLength(0)
    // 删组后成员回到未分组（group_name 置空），会话本身不丢
    expect(store.getSessionMeta('s-1')!.group_name).toBeNull()
  })

  it('rename group migrates member metas', () => {
    store.createGroup('old')
    store.upsertSessionMeta({
      session_id: 's-2',
      group_name: 'old',
      pinned: 1,
      archived: 0,
      hidden: 0,
      fallback_note: null
    })
    store.renameGroup('old', 'new')
    expect(store.listGroups().map((g) => g.name)).toEqual(['new'])
    expect(store.getSessionMeta('s-2')!.group_name).toBe('new')
    expect(store.getSessionMeta('s-2')!.pinned).toBe(1) // 其它装饰不受影响
  })

  it('deleteSessionMeta removes decoration only', () => {
    store.upsertSessionMeta({
      session_id: 's-3',
      group_name: null,
      pinned: 1,
      archived: 0,
      hidden: 0,
      fallback_note: null
    })
    store.deleteSessionMeta('s-3')
    expect(store.getSessionMeta('s-3')).toBeUndefined()
  })

  it('rejects empty group name', () => {
    expect(() => store.createGroup('  ')).toThrow(/empty/)
    store.createGroup('g')
    expect(() => store.renameGroup('g', '')).toThrow(/empty/)
  })
})

describe('M21 迁移：hidden 列 + 「定时任务」分组退出 Code 栏', () => {
  it('旧库补列并把该分组整体转 hidden、删空组；其余会话不动', () => {
    const p = join(dir, 'legacy.db')
    const raw = new Database(p, { nativeBinding: process.env['LC_BS3_BINDING'] })
    raw.exec(`
      CREATE TABLE session_meta (
        session_id TEXT PRIMARY KEY, group_name TEXT,
        pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, fallback_note TEXT
      );
      CREATE TABLE session_groups (name TEXT PRIMARY KEY, collapsed INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE cron_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL, session_id TEXT,
        started_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'running', summary TEXT
      );
      INSERT INTO session_meta (session_id, group_name) VALUES ('cron-sess', '定时任务'), ('normal-sess', 'payments-api');
      INSERT INTO session_groups (name) VALUES ('定时任务'), ('payments-api');
    `)
    raw.close()
    const legacy = new StateStore(p)
    expect(legacy.getSessionMeta('cron-sess')).toMatchObject({ hidden: 1, group_name: null })
    expect(legacy.getSessionMeta('normal-sess')).toMatchObject({ hidden: 0, group_name: 'payments-api' })
    expect(legacy.listGroups().map((g) => g.name)).toEqual(['payments-api'])
    // cron_runs 同步补 out_tokens 列（迁移幂等：重开不再 ALTER）
    legacy.close()
    const reopened = new StateStore(p)
    expect(reopened.getSessionMeta('cron-sess')!.hidden).toBe(1)
    reopened.close()
  })

  it('新库 upsert hidden 往返', () => {
    store.upsertSessionMeta({
      session_id: 'h-1',
      group_name: null,
      pinned: 0,
      archived: 0,
      hidden: 1,
      fallback_note: null
    })
    expect(store.getSessionMeta('h-1')!.hidden).toBe(1)
  })
})
