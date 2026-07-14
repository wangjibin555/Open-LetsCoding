import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { computeDueAt, cronChatRunIdOf, cronRunIdOf, tickDecision, validateSchedule, MISS_GRACE_MS } from './cron'
import { SCHEDULED_DISALLOWED_TOOLS, SCHEDULED_MAX_TURNS } from './engine/scheduledGuard'
import { StateStore } from './store'

const root = mkdtempSync(join(tmpdir(), 'lc-cron-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** 本地时区某日某时刻的 epoch ms（due 计算按本地时区，测试同基准） */
function at(y: number, mo: number, d: number, h: number, mi: number): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime()
}

describe('validateSchedule', () => {
  it('三种周期的合法与非法参数', () => {
    expect(validateSchedule('daily', '21:30')).toBeNull()
    expect(validateSchedule('daily', '24:00')).not.toBeNull()
    expect(validateSchedule('daily', '9:5')).not.toBeNull()
    expect(validateSchedule('weekly', '5,18:00')).toBeNull()
    expect(validateSchedule('weekly', '8,18:00')).not.toBeNull()
    expect(validateSchedule('hourly', '4')).toBeNull()
    expect(validateSchedule('hourly', '0')).not.toBeNull()
    expect(validateSchedule('hourly', '1.5')).not.toBeNull()
    expect(validateSchedule('cron', '* * * * *')).not.toBeNull()
  })
})

describe('cronRunIdOf（handle → runId，通知文案与 onStream 共用）', () => {
  it('cron- 前缀且 runId 为正整数才命中', () => {
    expect(cronRunIdOf('cron-12')).toBe(12)
    expect(cronRunIdOf('cron-0')).toBeNull()
    expect(cronRunIdOf('cron-abc')).toBeNull()
    expect(cronRunIdOf('cron-')).toBeNull()
    expect(cronRunIdOf('cron-1.5')).toBeNull()
    expect(cronRunIdOf('design-1751900000000')).toBeNull()
    expect(cronRunIdOf('h1')).toBeNull()
    // cronchat- 不是 cron- 前缀（续聊不吃 run 收尾语义）
    expect(cronRunIdOf('cronchat-12-999')).toBeNull()
  })
})

describe('cronChatRunIdOf（M21 续聊 handle → runId）', () => {
  it('cronchat-<runId>-<ts> 解析首段 runId', () => {
    expect(cronChatRunIdOf('cronchat-12-1751900000000')).toBe(12)
    expect(cronChatRunIdOf('cronchat-0-1')).toBeNull()
    expect(cronChatRunIdOf('cronchat-abc-1')).toBeNull()
    expect(cronChatRunIdOf('cron-12')).toBeNull()
    expect(cronChatRunIdOf('design-1')).toBeNull()
  })
})

describe('computeDueAt', () => {
  it('daily：当天未到取当天，已过取次日', () => {
    // 2026-07-08 是周三
    expect(computeDueAt('daily', '21:30', at(2026, 7, 8, 9, 0))).toBe(at(2026, 7, 8, 21, 30))
    expect(computeDueAt('daily', '21:30', at(2026, 7, 8, 21, 30))).toBe(at(2026, 7, 9, 21, 30))
    expect(computeDueAt('daily', '21:30', at(2026, 7, 8, 23, 0))).toBe(at(2026, 7, 9, 21, 30))
  })

  it('weekly：1=周一…7=周日；同日已过滚到下周', () => {
    // ref 周三 → 周五 18:00 是两天后
    expect(computeDueAt('weekly', '5,18:00', at(2026, 7, 8, 9, 0))).toBe(at(2026, 7, 10, 18, 0))
    // ref 周五 18:00 整 → 下周五
    expect(computeDueAt('weekly', '5,18:00', at(2026, 7, 10, 18, 0))).toBe(at(2026, 7, 17, 18, 0))
    // 7=周日
    expect(computeDueAt('weekly', '7,08:00', at(2026, 7, 8, 9, 0))).toBe(at(2026, 7, 12, 8, 0))
  })

  it('hourly：ref + N 小时；非法参数返回 null', () => {
    expect(computeDueAt('hourly', '4', at(2026, 7, 8, 9, 0))).toBe(at(2026, 7, 8, 13, 0))
    expect(computeDueAt('daily', '99:99', at(2026, 7, 8, 9, 0))).toBeNull()
  })
})

describe('tickDecision（补跑判定，D10 验收）', () => {
  const base = {
    schedule_kind: 'daily',
    schedule_arg: '21:30',
    created_at: at(2026, 7, 7, 10, 0),
    last_run_at: at(2026, 7, 7, 21, 30),
    enabled: 1,
    catch_up: 1
  }

  it('未到期 wait，到期 run', () => {
    expect(tickDecision(base, at(2026, 7, 8, 21, 29))).toBe('wait')
    expect(tickDecision(base, at(2026, 7, 8, 21, 30))).toBe('run')
  })

  it('关停横跨 due + catch_up=1 → 拉起补跑（迟到多久都 run）', () => {
    expect(tickDecision(base, at(2026, 7, 9, 11, 0))).toBe('run')
  })

  it('catch_up=0：宽限内 run，超宽限 skip（推进周期，不悬挂）', () => {
    const noCatch = { ...base, catch_up: 0 }
    const due = at(2026, 7, 8, 21, 30)
    expect(tickDecision(noCatch, due + MISS_GRACE_MS)).toBe('run')
    expect(tickDecision(noCatch, due + MISS_GRACE_MS + 1)).toBe('skip')
  })

  it('停用 wait；从未跑过用 created_at 起算', () => {
    expect(tickDecision({ ...base, enabled: 0 }, at(2026, 7, 9, 11, 0))).toBe('wait')
    const fresh = { ...base, last_run_at: null, created_at: at(2026, 7, 8, 22, 0) }
    // 创建于 21:30 之后 → 首次 due 是次日 21:30
    expect(tickDecision(fresh, at(2026, 7, 8, 23, 0))).toBe('wait')
    expect(tickDecision(fresh, at(2026, 7, 9, 21, 30))).toBe('run')
  })
})

describe('scheduledGuard（D10 手段断言：无人值守只读 + 轮数封顶）', () => {
  it('禁用工具集 ⊇ 全部写/执行工具，maxTurns 有限', () => {
    for (const t of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']) {
      expect(SCHEDULED_DISALLOWED_TOOLS).toContain(t)
    }
    expect(SCHEDULED_MAX_TURNS).toBeGreaterThan(0)
    expect(SCHEDULED_MAX_TURNS).toBeLessThanOrEqual(100)
  })
})

describe('StateStore cron CRUD（D10 验收：往返一致）', () => {
  const store = new StateStore(join(root, 'state.db'))
  afterAll(() => store.close())

  it('save/list/get 往返、更新不触碰 last_run_at/created_at', () => {
    const now = at(2026, 7, 8, 10, 0)
    const id = store.saveCronJob(
      {
        name: '每日复盘',
        prompt: '总结今天',
        cwd: '/tmp/proj',
        model: null,
        schedule_kind: 'daily',
        schedule_arg: '21:30',
        enabled: 1,
        catch_up: 1
      },
      now
    )
    expect(store.listCronJobs()).toHaveLength(1)
    const job = store.getCronJob(id)!
    expect(job).toMatchObject({ name: '每日复盘', schedule_arg: '21:30', created_at: now, last_run_at: null })

    store.saveCronJob(
      { id, name: '每日复盘v2', prompt: '总结今天', cwd: '/tmp/proj', model: 'm1', schedule_kind: 'weekly', schedule_arg: '5,18:00', enabled: 1, catch_up: 0 },
      now + 999
    )
    const updated = store.getCronJob(id)!
    expect(updated).toMatchObject({ name: '每日复盘v2', model: 'm1', schedule_kind: 'weekly', catch_up: 0, created_at: now })
  })

  it('空名称/空指令拒绝；toggle 与 touch 生效', () => {
    expect(() =>
      store.saveCronJob(
        { name: ' ', prompt: 'x', cwd: '/tmp', model: null, schedule_kind: 'daily', schedule_arg: '09:00', enabled: 1, catch_up: 1 },
        1
      )
    ).toThrow()
    const id = store.listCronJobs()[0].id
    store.setCronJobEnabled(id, false)
    expect(store.getCronJob(id)!.enabled).toBe(0)
    store.touchCronJob(id, 12345)
    expect(store.getCronJob(id)!.last_run_at).toBe(12345)
  })

  it('run 生命周期：start 置 last_run_at、finish 仅对 running 生效、join 带任务名', () => {
    const id = store.listCronJobs()[0].id
    const t0 = at(2026, 7, 8, 21, 30)
    const runId = store.startCronRun(id, t0)
    expect(store.getCronJob(id)!.last_run_at).toBe(t0)
    store.setCronRunSession(runId, 'abc-session')
    store.finishCronRun(runId, 'ok', '报告摘要', 2143)
    // 二次收尾（模拟 result 之后的 closed 事件）→ no-op
    store.finishCronRun(runId, 'error', '不该覆盖')
    const run = store.getCronRun(runId)!
    expect(run).toMatchObject({
      status: 'ok',
      summary: '报告摘要',
      session_id: 'abc-session',
      job_name: '每日复盘v2',
      out_tokens: 2143
    })
    // M21 续聊回绑：fork 出的新 sessionId 覆写到 run（回放含续聊全程）
    store.setCronRunSession(runId, 'forked-session')
    expect(store.getCronRun(runId)!.session_id).toBe('forked-session')
    expect(store.listCronRuns(id, 10)).toHaveLength(1)
    expect(store.listCronRuns(null, 10)[0].job_name).toBe('每日复盘v2')
  })

  it('删除任务级联清 runs', () => {
    const id = store.listCronJobs()[0].id
    store.deleteCronJob(id)
    expect(store.listCronJobs()).toHaveLength(0)
    expect(store.listCronRuns(null, 10)).toHaveLength(0)
  })
})
