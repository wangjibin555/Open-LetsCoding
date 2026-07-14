// TaskWork 调度器（DECISIONS D10）：cron_jobs 落 state.db，main 进程 30s tick；
// App 开着才跑，关闭错过时段 → 再次拉起时补跑一次（catch_up 可关）。
// due 计算与 tick 决策为纯函数（时钟入参，vitest 可测）；CronService 只做接线——
// 读写 SQLite + 起 engine 会话，零 fs 写（G7 单写者不涉）。
import { CRON_HANDLE_PREFIX, CRONCHAT_HANDLE_PREFIX } from '../shared/ipc'
import type { SessionService } from './engine/sessions'
import type { CronJobRow, StateStore } from './store'

export { CRON_HANDLE_PREFIX }
/** 不补跑任务的触发宽限：错过 due 超过此值且 catch_up=0 → 跳过本次，推进到下一周期 */
export const MISS_GRACE_MS = 5 * 60_000

/** 周期参数校验：返回错误文案，合法返回 null */
export function validateSchedule(kind: string, arg: string): string | null {
  if (kind === 'daily') {
    return /^([01]?\d|2[0-3]):[0-5]\d$/.test(arg) ? null : '每天周期需为 HH:MM'
  }
  if (kind === 'weekly') {
    return /^[1-7],([01]?\d|2[0-3]):[0-5]\d$/.test(arg) ? null : '每周周期需为 周几(1-7),HH:MM'
  }
  if (kind === 'hourly') {
    const n = Number(arg)
    return Number.isInteger(n) && n >= 1 && n <= 168 ? null : '每 N 小时需为 1-168 的整数'
  }
  return '未知周期类型'
}

/** ref 之后（严格大于）的下一个到期时刻（本地时区）；参数非法返回 null */
export function computeDueAt(kind: string, arg: string, refMs: number): number | null {
  if (validateSchedule(kind, arg) !== null) return null
  if (kind === 'hourly') return refMs + Number(arg) * 3_600_000
  const [dowPart, hmPart] = kind === 'weekly' ? arg.split(',') : [null, arg]
  const [h, min] = hmPart.split(':').map(Number)
  const d = new Date(refMs)
  d.setHours(h, min, 0, 0)
  if (kind === 'daily') {
    if (d.getTime() <= refMs) d.setDate(d.getDate() + 1)
    return d.getTime()
  }
  // weekly：约定 1=周一…7=周日；JS getDay() 0=周日 → 取模对齐。最多前进 8 天必命中
  const target = Number(dowPart) % 7
  while (d.getDay() !== target || d.getTime() <= refMs) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/** cron 会话 handle → runId；非 cron 会话 / 非法 runId 返回 null（通知文案与 onStream 共用） */
export function cronRunIdOf(handle: string): number | null {
  if (!handle.startsWith(CRON_HANDLE_PREFIX)) return null
  const runId = Number(handle.slice(CRON_HANDLE_PREFIX.length))
  return Number.isInteger(runId) && runId > 0 ? runId : null
}

/** 续聊 handle `cronchat-<runId>-<ts>` → runId（M21：fork 会话回绑该 run + 标 hidden） */
export function cronChatRunIdOf(handle: string): number | null {
  if (!handle.startsWith(CRONCHAT_HANDLE_PREFIX)) return null
  const runId = Number(handle.slice(CRONCHAT_HANDLE_PREFIX.length).split('-')[0])
  return Number.isInteger(runId) && runId > 0 ? runId : null
}

export type TickDecision = 'run' | 'skip' | 'wait'

/**
 * 单任务 tick 决策：
 * - 未到期 / 停用 / 参数坏 → wait
 * - 到期且（补跑 或 迟到 ≤ 宽限）→ run
 * - 到期但不补跑且已迟到超宽限 → skip（推进 last_run_at，否则过期 due 永久悬挂、永不再触发）
 */
export function tickDecision(
  job: Pick<
    CronJobRow,
    'enabled' | 'catch_up' | 'schedule_kind' | 'schedule_arg' | 'last_run_at' | 'created_at'
  >,
  nowMs: number,
  graceMs = MISS_GRACE_MS
): TickDecision {
  if (!job.enabled) return 'wait'
  const ref = job.last_run_at ?? job.created_at
  const due = computeDueAt(job.schedule_kind, job.schedule_arg, ref)
  if (due === null || nowMs < due) return 'wait'
  if (!job.catch_up && nowMs - due > graceMs) return 'skip'
  return 'run'
}

export class CronService {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly store: StateStore,
    private readonly engine: SessionService,
    private readonly getDefaultModel: () => string | null
  ) {}

  /** 启动即 tick 一次（承接补跑），此后 30s 一轮 */
  start(): void {
    this.tick()
    this.timer = setInterval(() => this.tick(), 30_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 串行护栏：同一时刻最多一个定时会话在跑（不并发抢网关） */
  private busy(): boolean {
    return this.engine.liveSessions().some((s) => s.handle.startsWith(CRON_HANDLE_PREFIX))
  }

  tick(nowMs = Date.now()): void {
    for (const job of this.store.listCronJobs()) {
      const d = tickDecision(job, nowMs)
      if (d === 'skip') this.store.touchCronJob(job.id, nowMs)
      else if (d === 'run' && !this.busy()) this.runJob(job, nowMs)
    }
  }

  /** 「立即运行」：无视 due 手动触发（也计入 last_run_at） */
  runNow(id: number, nowMs = Date.now()): void {
    const job = this.store.getCronJob(id)
    if (!job) throw new Error(`定时任务 ${id} 不存在`)
    if (this.busy()) throw new Error('已有定时任务在运行，请稍后再试')
    this.runJob(job, nowMs)
  }

  private runJob(job: CronJobRow, nowMs: number): void {
    const runId = this.store.startCronRun(job.id, nowMs, job.cwd)
    const model = job.model ?? this.getDefaultModel()
    if (!model) {
      // tick 场景无人接异常：落 error 记录留痕，不抛
      this.store.finishCronRun(runId, 'error', '未配置默认模型，无法执行')
      return
    }
    try {
      this.engine.create({
        handle: `${CRON_HANDLE_PREFIX}${runId}`,
        cwd: job.cwd,
        model,
        uiMode: 'auto',
        mode: 'scheduled',
        firstPrompt: job.prompt
      })
    } catch (err) {
      this.store.finishCronRun(runId, 'error', String(err).slice(0, 200))
    }
  }

  /** 由 main 的 onStream 接线调用：跟踪 cron 会话的 init（标 hidden）与 result/closed（收尾）；
   * 续聊 fork（cronchat-）的 init 回绑 run + 同样标 hidden（M21：报告只在 TaskWork 页内可见） */
  onStream(handle: string, msg: unknown): void {
    const m = msg as {
      type?: string
      subtype?: string
      session_id?: string
      result?: unknown
      is_error?: boolean
      usage?: { output_tokens?: number }
    }
    const chatRunId = cronChatRunIdOf(handle)
    if (chatRunId !== null) {
      // resume fork 出新 sessionId：回绑到 run（下次回放含续聊全程），并继承 hidden
      if (m.type === 'system' && m.subtype === 'init' && m.session_id) {
        this.store.setCronRunSession(chatRunId, m.session_id)
        this.hideSession(m.session_id)
      }
      return
    }
    const runId = cronRunIdOf(handle)
    if (runId === null) return
    if (m.type === 'system' && m.subtype === 'init' && m.session_id) {
      this.store.setCronRunSession(runId, m.session_id)
      // M21：报告不再进 Code 栏（不归组），标 hidden——只在 TaskWork 页内回放/续聊
      this.hideSession(m.session_id)
      return
    }
    if (m.type === 'result') {
      const summary = typeof m.result === 'string' ? m.result.slice(0, 300) : null
      this.store.finishCronRun(runId, m.is_error ? 'error' : 'ok', summary, m.usage?.output_tokens)
      // 一次性任务：收到 result 即释放 live 句柄，再补会话标题（任务名 · 月/日）
      this.engine.close(handle)
      const run = this.store.getCronRun(runId)
      if (run?.session_id) {
        const d = new Date(run.started_at)
        void this.engine
          .rename(run.session_id, `${run.job_name} · ${d.getMonth() + 1}/${d.getDate()}`)
          .catch(() => {})
      }
      return
    }
    if (m.type === 'engine' && (m.subtype === 'error' || m.subtype === 'closed')) {
      // result 已收尾则 no-op（finishCronRun 仅对 running 生效）
      this.store.finishCronRun(runId, 'error', m.subtype === 'error' ? '会话异常中断' : '会话提前结束')
    }
  }

  private hideSession(sessionId: string): void {
    this.store.upsertSessionMeta({
      session_id: sessionId,
      group_name: null,
      pinned: 0,
      archived: 0,
      hidden: 1,
      fallback_note: null
    })
  }
}
