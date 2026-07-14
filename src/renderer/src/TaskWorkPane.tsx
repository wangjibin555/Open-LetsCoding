import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CRON_HANDLE_PREFIX,
  CRONCHAT_HANDLE_PREFIX,
  type CronJobDto,
  type CronRunDto,
  type CronScheduleKind
} from '../../shared/ipc'
import ChatFlow, { lastAssistantIdOf } from './ChatFlow'
import ModeTabs, { type ModeKey } from './ModeTabs'
import { replayToFlow } from './replay'
import { useSessionStream, type FlowItem } from './useStream'
import { fmtTokens, relTime } from './ui'

// TaskWork v2（DECISIONS D13 / design/taskwork-session.html）：任务即对话。
// 中栏 = 选中任务的会话流（最新 run 回放 / 运行中 live / 底部续聊 resume）；
// 右栏 = Runs 历史 + 配置摘要；cron 会话标 hidden，不进 Code 栏（页内自成闭环）。

interface Props {
  onBack: () => void
  /** 切到 Design 模式页 */
  onDesign: () => void
  /** 新建任务的默认目录（当前活跃会话的 cwd） */
  defaultCwd: string | null
  /** 续聊会话的兜底模型（任务未指定时跟随默认） */
  defaultModel: string | null
  /** 左列宽度跟随 Code 左栏（panel.sideW），切换模式时左列不跳宽 */
  width?: number
  /** 右栏（Runs+配置）宽度与隐藏态（M21b 可拖拽） */
  railW: number
  railHidden: boolean
  onDragSide: (e: React.MouseEvent) => void
  onDragRail: (e: React.MouseEvent) => void
  onRailHide: (hidden: boolean) => void
  /** 等权限的会话所属模式（mode tab 红点） */
  permMode: ModeKey | null
}

const PRESETS = [
  {
    name: '每日复盘',
    arg: '21:30',
    kind: 'daily' as CronScheduleKind,
    prompt:
      '读取 ~/.claude/projects 下今天有更新的会话记录（限定当前工作目录对应的项目），总结：1) 今天做了什么、合并了什么；2) 踩了什么坑、怎么解决的；3) 未完成的待办和明天建议。控制在 500 字内。'
  },
  {
    name: '周报汇总',
    arg: '5,18:00',
    kind: 'weekly' as CronScheduleKind,
    prompt:
      '读取 ~/.claude/projects 下本周有更新的会话记录（限定当前工作目录对应的项目），按天汇总本周工作：完成的功能/修复、遇到的问题、下周建议。控制在 800 字内。'
  },
  {
    name: '待办盘点',
    arg: '4',
    kind: 'hourly' as CronScheduleKind,
    prompt:
      '读取 ~/.claude/tasks 下的待办清单与当前项目的 PLAN.md（如有），盘点：哪些在进行、哪些卡住了、哪些该开始了。控制在 300 字内。'
  }
]

const DOW = ['一', '二', '三', '四', '五', '六', '日']

interface FormState {
  name: string
  prompt: string
  cwd: string
  model: string
  kind: CronScheduleKind
  /** daily/weekly 的 HH:MM */
  time: string
  /** weekly 的周几 1-7 */
  dow: number
  /** hourly 的 N */
  hours: number
  catchUp: boolean
}

function jobToForm(j: CronJobDto): FormState {
  const [d, t] = j.scheduleKind === 'weekly' ? j.scheduleArg.split(',') : ['5', j.scheduleArg]
  return {
    name: j.name,
    prompt: j.prompt,
    cwd: j.cwd,
    model: j.model ?? '',
    kind: j.scheduleKind,
    time: j.scheduleKind === 'hourly' ? '21:30' : t,
    dow: j.scheduleKind === 'weekly' ? Number(d) : 5,
    hours: j.scheduleKind === 'hourly' ? Number(j.scheduleArg) || 4 : 4,
    catchUp: j.catchUp
  }
}

function freqLabel(j: CronJobDto): string {
  if (j.scheduleKind === 'daily') return `每天 ${j.scheduleArg}`
  if (j.scheduleKind === 'weekly') {
    const [d, t] = j.scheduleArg.split(',')
    return `每周${DOW[Number(d) - 1] ?? d} ${t}`
  }
  return `每 ${j.scheduleArg} 小时`
}

function shortFreq(j: CronJobDto): string {
  if (j.scheduleKind === 'daily') return '每天'
  if (j.scheduleKind === 'weekly') return '每周'
  return `每${j.scheduleArg}时`
}

function fmtDue(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const day =
    d.toDateString() === today.toDateString()
      ? '今天'
      : `${d.getMonth() + 1}/${d.getDate()}`
  return `${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 下次执行的相对表述（右栏配置卡） */
function relIn(ts: number): string {
  const m = Math.round((ts - Date.now()) / 60_000)
  if (m < 1) return '即将'
  if (m < 60) return `${m} 分钟后`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} 小时后`
  return `${Math.round(h / 24)} 天后`
}

export default function TaskWorkPane(props: Props): React.JSX.Element {
  const [jobs, setJobs] = useState<CronJobDto[]>([])
  const [recents, setRecents] = useState<CronRunDto[]>([])
  const [jobRuns, setJobRuns] = useState<CronRunDto[]>([])
  const [sel, setSel] = useState<number | 'new' | null>(null)
  // load 是稳定回调（5s 轮询持有），经 ref 读当前选中，避免把 sel 加进依赖导致定时器反复重建
  const selRef = useRef(sel)
  selRef.current = sel
  const [view, setView] = useState<'chat' | 'form'>('chat')
  const [selRunId, setSelRunId] = useState<number | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState(false)

  // ---- 会话流（D13）：回放基底 + live/续聊 桶 ----
  const [history, setHistory] = useState<FlowItem[]>([])
  const [chatHandle, setChatHandle] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState<string | null>(null)
  /** 本次 App 会话内看过 live 流的 run（桶还在就继续用桶，避免完成瞬间回放重排） */
  const watchedRef = useRef(new Set<number>())
  /** Recents 点击带目标 run：切任务的 effect 里接力选中 */
  const desiredRunRef = useRef<number | null>(null)
  const chatRef = useRef<HTMLDivElement>(null)

  const selJob = sel !== 'new' ? jobs.find((j) => j.id === sel) : undefined
  const selRun = jobRuns.find((r) => r.id === selRunId)

  /** 弃置续聊会话：关掉 live 句柄（终止在途生成）——防同一 transcript 被并发 resume + 句柄泄漏 */
  const dropChat = useCallback((h: string | null): void => {
    if (h) void window.letscoding.session.close(h).catch(() => {})
  }, [])

  useEffect(() => {
    if (selRun?.status === 'running') watchedRef.current.add(selRun.id)
  }, [selRun?.status, selRun?.id])

  const liveBase =
    !!selRun && chatHandle === null && (selRun.status === 'running' || watchedRef.current.has(selRun.id))
  const activeHandle = chatHandle ?? (liveBase && selRun ? `${CRON_HANDLE_PREFIX}${selRun.id}` : null)
  const { items, running: streamRunning, pushUser, pushStatus, setRunning, seed } =
    useSessionStream(activeHandle)

  const load = useCallback(async (): Promise<void> => {
    try {
      const [js, rs] = await Promise.all([
        window.letscoding.cron.jobs(),
        window.letscoding.cron.runs(null, 10)
      ])
      setJobs(js)
      setRecents(rs)
      // 选中任务的运行历史同步刷（否则「正在运行…」收尾后不落 ✓）
      if (typeof selRef.current === 'number') {
        setJobRuns(await window.letscoding.cron.runs(selRef.current, 12))
      }
    } catch {
      /* store 未就绪时静默，下轮刷新重试 */
    }
  }, [])

  // 挂载即载入 + 5s 轮询（运行状态/历史随会话推进变化）
  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 5000)
    return () => clearInterval(t)
  }, [load])

  // 首次载入后默认选中第一个任务
  useEffect(() => {
    if (sel === null && jobs.length > 0) setSel(jobs[0].id)
  }, [jobs, sel])

  // 选中任务变化 → 重置会话区 + 表单回填 + 拉运行历史
  useEffect(() => {
    setConfirmDel(false)
    setMsg(null)
    setNote(null)
    setChatHandle((h) => {
      dropChat(h)
      return null
    })
    setJobRuns([])
    setSelRunId(desiredRunRef.current)
    desiredRunRef.current = null
    if (sel === 'new') {
      const p = PRESETS[0]
      setForm({
        name: '',
        prompt: p.prompt,
        cwd: props.defaultCwd ?? '',
        model: '',
        kind: p.kind,
        time: p.arg,
        dow: 5,
        hours: 4,
        catchUp: true
      })
      setView('form')
      return
    }
    setView('chat')
    const job = jobs.find((j) => j.id === sel)
    if (!job) return
    setForm(jobToForm(job))
    window.letscoding.cron.runs(job.id, 12).then(setJobRuns).catch(() => {})
    // 表单只在切换选中时回填；轮询刷新 jobs 不覆盖正在编辑的内容
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel])

  // Runs 列表就位/更新：无选中或选中已不在列表 → 选最新；新 run 起跑那一刻自动跟到 live
  //（仅 top 变化时抢占一次——5s 轮询期间用户手选历史 run 不被弹回；续聊中不抢）
  const lastTopRef = useRef<number | null>(null)
  useEffect(() => {
    const top = jobRuns[0]
    if (!top) return
    if (selRunId === null || !jobRuns.some((r) => r.id === selRunId)) setSelRunId(top.id)
    else if (
      top.status === 'running' &&
      chatHandle === null &&
      top.id !== lastTopRef.current &&
      selRunId !== top.id
    )
      setSelRunId(top.id)
    lastTopRef.current = top.id
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobRuns])

  // 回放基底：选中已完成 run 且不走 live 桶、无续聊时，回放 transcript（seq 防迟到覆盖）
  const histSeq = useRef(0)
  useEffect(() => {
    if (chatHandle) return // 续聊期间基底冻结（send 时已定格）
    const seq = ++histSeq.current
    setHistory([])
    if (!selRun || liveBase || selRun.status === 'running' || !selRun.sessionId) return
    window.letscoding.session
      .replay(selRun.sessionId)
      .then((msgs) => {
        if (histSeq.current !== seq) return
        const flow = replayToFlow(msgs).filter((it) => it.kind !== 'memory')
        setHistory(flow.slice(-200).map((it, i) => ({ ...it, id: `h${i}` })))
      })
      .catch(() => {}) /* transcript 缺失 → 空基底，摘要仍在 Runs 行 */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selRunId, selRun?.status, selRun?.sessionId, liveBase, chatHandle])

  // 新消息/回放载入滚到底
  useEffect(() => {
    const el = chatRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items, history])

  function applyPreset(i: number): void {
    const p = PRESETS[i]
    setForm((f) =>
      f
        ? {
            ...f,
            name: f.name || p.name,
            prompt: p.prompt,
            kind: p.kind,
            time: p.kind === 'hourly' ? f.time : p.arg.split(',').pop()!,
            dow: p.kind === 'weekly' ? Number(p.arg.split(',')[0]) : f.dow,
            hours: p.kind === 'hourly' ? Number(p.arg) : f.hours
          }
        : f
    )
  }

  async function save(): Promise<void> {
    if (!form) return
    const scheduleArg =
      form.kind === 'daily' ? form.time : form.kind === 'weekly' ? `${form.dow},${form.time}` : String(form.hours)
    try {
      const id = await window.letscoding.cron.save({
        ...(sel !== 'new' && sel !== null ? { id: sel } : {}),
        name: form.name,
        prompt: form.prompt,
        cwd: form.cwd,
        model: form.model.trim() || null,
        scheduleKind: form.kind,
        scheduleArg,
        enabled: sel === 'new' ? true : (selJob?.enabled ?? true),
        catchUp: form.catchUp
      })
      setMsg('已保存')
      await load()
      if (sel === 'new') setSel(id)
      else setView('chat')
      setTimeout(() => setMsg(null), 2000)
    } catch (err) {
      setMsg(String(err instanceof Error ? err.message : err).replace(/^.*Error: /, ''))
    }
  }

  async function runNow(): Promise<void> {
    if (typeof sel !== 'number') return
    try {
      await window.letscoding.cron.runNow(sel)
      setNote(null)
      setView('chat')
      await load()
      window.letscoding.cron.runs(sel, 12).then(setJobRuns).catch(() => {})
    } catch (err) {
      setNote(String(err instanceof Error ? err.message : err).replace(/^.*Error: /, ''))
    }
  }

  async function toggle(job: CronJobDto): Promise<void> {
    await window.letscoding.cron.toggle(job.id, !job.enabled).catch(() => {})
    await load()
  }

  async function remove(): Promise<void> {
    if (typeof sel !== 'number') return
    if (!confirmDel) {
      setConfirmDel(true)
      return
    }
    await window.letscoding.cron.remove(sel).catch(() => {})
    setSel(null)
    setForm(null)
    await load()
  }

  // ---- 续聊（D13）：resume 报告会话，cronchat- 前缀走普通会话（main 侧回绑 run + 标 hidden） ----
  async function send(): Promise<void> {
    const text = draft.trim()
    if (!text || !selRun || !selJob || streamRunning || selRun.status === 'running') return
    setNote(null)
    if (chatHandle) {
      setDraft('')
      pushUser(text)
      setRunning(chatHandle, true)
      try {
        await window.letscoding.session.send(chatHandle, text)
      } catch (err) {
        setRunning(chatHandle, false)
        pushStatus(`发送失败：${String(err).slice(0, 120)}`)
      }
      return
    }
    const model = selJob.model ?? props.defaultModel
    if (!model) {
      setNote('未配置默认模型，先去设置里配一个')
      return
    }
    if (!selRun.sessionId) {
      setNote('这次运行没有产生会话，无法续聊')
      return
    }
    // live 桶做基底时先定格（切到续聊桶后基底不再随 activeHandle 变化）
    if (liveBase && items.length && history.length === 0) {
      setHistory(items.map((it, i) => ({ ...it, id: `h${i}` })))
    }
    const h = `${CRONCHAT_HANDLE_PREFIX}${selRun.id}-${Date.now()}`
    setDraft('')
    setChatHandle(h)
    seed(h, [{ id: 'u0', kind: 'user' as const, text }])
    setRunning(h, true)
    try {
      await window.letscoding.session.create({
        handle: h,
        // resume 按 cwd 定位 transcript：必须用 run 落跑时的目录快照（任务目录可能事后被改）
        cwd: selRun.cwd ?? selJob.cwd,
        model,
        uiMode: 'auto',
        resume: selRun.sessionId,
        firstPrompt: text
      })
    } catch (err) {
      setRunning(h, false)
      setChatHandle(null)
      setNote(`续聊启动失败：${String(err).slice(0, 120)}`)
      setDraft(text)
    }
  }

  async function stopChat(): Promise<void> {
    if (!chatHandle) return
    try {
      await window.letscoding.session.interrupt(chatHandle)
    } catch {
      pushStatus('停止失败，会话可能已结束')
    }
  }

  function pickRun(id: number): void {
    if (id === selRunId) return
    setChatHandle((h) => {
      dropChat(h)
      return null
    })
    setNote(null)
    setSelRunId(id)
  }

  const lastAssistantId = lastAssistantIdOf(items)
  const followTail = (): void => {
    const el = chatRef.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight
  }
  const runIcon = (r: CronRunDto): { cls: string; icon: string } => ({
    cls: r.status === 'ok' ? 'ok' : r.status === 'running' ? 'run' : 'er',
    icon: r.status === 'ok' ? '✓' : r.status === 'running' ? '●' : '✕'
  })

  const chatting = chatHandle !== null
  const composerDisabled = !selRun || selRun.status === 'running'

  return (
    <div className="taskwork">
      <div className="tw-list" style={props.width ? { width: props.width } : undefined}>
        {/* 头部与 Code 左栏逐像素同构（brand + Tab 同位同距），模式切换时左上角不跳 */}
        <div className="tw-top">
          <div className="brand">
            <i />
            LetsCoding
          </div>
          <ModeTabs
            active="taskwork"
            alert={props.permMode}
            onSwitch={(k) => (k === 'work' ? props.onBack() : k === 'design' ? props.onDesign() : undefined)}
          />
        </div>
        <div className="tw-body">
          <button className="tw-new" onClick={() => setSel('new')}>
            ＋ 新建任务
          </button>
          <div className="tw-grp">Scheduled</div>
          {jobs.length === 0 && <div className="tw-empty">还没有定时任务</div>}
          {jobs.map((j) => (
            <div key={j.id} className={`tw-jrow${sel === j.id ? ' on' : ''}`} onClick={() => setSel(j.id)}>
              <span
                className={`tw-dot${j.enabled ? '' : ' off'}${jobRunning(j, recents) ? ' running' : ''}`}
              />
              <span className="tw-jname">{j.name}</span>
              <span className="tw-jfreq">{shortFreq(j)}</span>
            </div>
          ))}
          {recents.length > 0 && (
            <>
              <div className="tw-grp" style={{ marginTop: 10 }}>
                Recents
              </div>
              <div className="tw-recents">
                {recents.map((r) => {
                  const s = runIcon(r)
                  return (
                    <div
                      key={r.id}
                      className="twh-row"
                      onClick={() => {
                        // 页内打开：切到该任务并选中这次运行（不再跳回 Code）
                        desiredRunRef.current = r.id
                        if (sel === r.jobId) {
                          desiredRunRef.current = null
                          pickRun(r.id)
                          setView('chat')
                        } else setSel(r.jobId)
                      }}
                    >
                      <span className={`twh-st ${s.cls}`}>{s.icon}</span>
                      <span className="twh-sum">
                        {r.jobName} · {r.status === 'running' ? '正在运行…' : (r.summary ?? (r.status === 'ok' ? '已完成' : '未产出报告'))}
                      </span>
                      <span className="twh-when">{relTime(r.startedAt)}</span>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </div>
      <div className="col-rsz" title="拖动调宽" onMouseDown={props.onDragSide} />

      <div className="tw-main">
        {!selJob && sel !== 'new' ? (
          <div className="tw-guide">
            <div className="tw-guide-t">TaskWork · 定时任务</div>
            <div className="tw-guide-d">
              定时让 Agent 自动跑复盘、周报、待办盘点——每个任务就是一条持续的对话流，报告在这里看、在这里追问，不占用
              Code 会话栏。执行为只读，App 打开时按时触发，关闭错过的时段下次打开补跑。
            </div>
            <button className="tw-new" style={{ maxWidth: 160 }} onClick={() => setSel('new')}>
              ＋ 新建第一个任务
            </button>
          </div>
        ) : (
          <>
            <div className="twv-top">
              <div className="tw-head">
                <span className="tw-name">{sel === 'new' ? '新建任务' : selJob?.name}</span>
                {selJob && <span className="tw-badge sched">{freqLabel(selJob)}</span>}
                <span className="tw-badge ro">只读</span>
                {selJob && (
                  <div
                    className={`tw-sw${selJob.enabled ? '' : ' off'}`}
                    title={selJob.enabled ? '停用' : '启用'}
                    onClick={() => void toggle(selJob)}
                  />
                )}
                {selJob && view === 'chat' && (
                  <button className="tw-cfg" title="编辑配置" onClick={() => setView('form')}>
                    ⚙ 配置
                  </button>
                )}
                {selJob && (
                  <button className="tw-run" onClick={() => void runNow()}>
                    ▶ 立即运行
                  </button>
                )}
              </div>
              {msg && <div className="tw-msg">{msg}</div>}
            </div>

            {view === 'form' || sel === 'new' ? (
              <div className="tw-formwrap">
                {form && (
                  <div className="tw-card">
                    <h4>
                      配置
                      {sel !== 'new' && (
                        <span className="tw-formback" onClick={() => setView('chat')}>
                          ← 返回会话
                        </span>
                      )}
                    </h4>
                    <div className="tw-frow">
                      <div className="tw-flab">名称</div>
                      <input
                        className="tw-fin"
                        value={form.name}
                        placeholder="如：每日复盘"
                        onChange={(e) => setForm({ ...form, name: e.target.value })}
                      />
                      <div className="tw-flab" style={{ width: 'auto' }}>
                        模型
                      </div>
                      <input
                        className="tw-fin"
                        style={{ flex: 'none', width: 180 }}
                        value={form.model}
                        placeholder="跟随默认模型"
                        onChange={(e) => setForm({ ...form, model: e.target.value })}
                      />
                    </div>
                    <div className="tw-frow">
                      <div className="tw-flab">周期</div>
                      <div className="tw-seg">
                        {(['daily', 'weekly', 'hourly'] as const).map((k) => (
                          <span
                            key={k}
                            className={form.kind === k ? 'on' : ''}
                            onClick={() => setForm({ ...form, kind: k })}
                          >
                            {k === 'daily' ? '每天' : k === 'weekly' ? '每周' : '每 N 小时'}
                          </span>
                        ))}
                      </div>
                      {form.kind === 'weekly' && (
                        <select
                          className="tw-fin"
                          style={{ flex: 'none', width: 76 }}
                          value={form.dow}
                          onChange={(e) => setForm({ ...form, dow: Number(e.target.value) })}
                        >
                          {DOW.map((d, i) => (
                            <option key={d} value={i + 1}>
                              周{d}
                            </option>
                          ))}
                        </select>
                      )}
                      {form.kind !== 'hourly' ? (
                        <input
                          type="time"
                          className="tw-fin"
                          style={{ flex: 'none', width: 96 }}
                          value={form.time}
                          onChange={(e) => setForm({ ...form, time: e.target.value })}
                        />
                      ) : (
                        <input
                          type="number"
                          className="tw-fin"
                          style={{ flex: 'none', width: 64 }}
                          min={1}
                          max={168}
                          value={form.hours}
                          onChange={(e) => setForm({ ...form, hours: Number(e.target.value) })}
                        />
                      )}
                      <label className="tw-check">
                        <input
                          type="checkbox"
                          checked={form.catchUp}
                          onChange={(e) => setForm({ ...form, catchUp: e.target.checked })}
                        />
                        错过补跑
                      </label>
                    </div>
                    <div className="tw-frow">
                      <div className="tw-flab">目录</div>
                      <input
                        className="tw-fin"
                        value={form.cwd}
                        placeholder="任务会话的工作目录（也是复盘读取范围）"
                        onChange={(e) => setForm({ ...form, cwd: e.target.value })}
                      />
                    </div>
                    <div className="tw-frow" style={{ alignItems: 'flex-start' }}>
                      <div className="tw-flab" style={{ marginTop: 6 }}>
                        任务指令
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <textarea
                          className="tw-farea"
                          value={form.prompt}
                          onChange={(e) => setForm({ ...form, prompt: e.target.value })}
                        />
                        <div className="tw-presets">
                          {PRESETS.map((p, i) => (
                            <span key={p.name} onClick={() => applyPreset(i)}>
                              预设：{p.name}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="tw-ffoot">
                      <span className="tw-hint">只读执行 · 上限 50 轮 · 每次运行消耗真实 token</span>
                      {sel !== 'new' && (
                        <span className={`tw-del${confirmDel ? ' arm' : ''}`} onClick={() => void remove()}>
                          {confirmDel ? '确认删除？' : '删除任务'}
                        </span>
                      )}
                      <button className="tw-save" onClick={() => void save()}>
                        保存
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <>
                {selRun && (
                  <div className="tw-runbar">
                    正在看：
                    <b className={runIcon(selRun).cls}>
                      {fmtDue(selRun.startedAt)} 的运行 {runIcon(selRun).icon}
                    </b>
                    {selRun.outTokens !== null && <span>· {fmtTokens(selRun.outTokens)} tokens</span>}
                    {chatting && <span>· 续聊中</span>}
                    <span style={{ marginLeft: 'auto' }}>右栏可切历史运行</span>
                  </div>
                )}
                <div className="tw-chat" ref={chatRef}>
                  {!selRun && (
                    <div className="tw-chat-empty">
                      这个任务还没有运行记录——点右上「▶ 立即运行」跑一次，报告会直接出现在这里。
                    </div>
                  )}
                  <ChatFlow items={history} running={false} lastAssistantId={null} />
                  {history.length > 0 && chatting && (
                    <div className="dz-m-status">—— 以上为本次运行报告，续聊接着问 ——</div>
                  )}
                  <ChatFlow
                    items={items.filter((it) => it.kind !== 'memory')}
                    running={streamRunning}
                    lastAssistantId={lastAssistantId}
                    onGrow={followTail}
                  />
                  {streamRunning && <div className="dz-m-status">● 正在{chatting ? '回答' : '运行'}…</div>}
                  {note && <div className="dz-m-status warn">{note}</div>}
                </div>
                <div className="tw-comp">
                  <textarea
                    className="dz-in"
                    placeholder={
                      composerDisabled
                        ? selRun?.status === 'running'
                          ? '任务正在运行，跑完可就报告续聊…'
                          : '先跑一次任务，再就报告续聊'
                        : '就这份报告继续问，或补充新的约束…（⌘↵ 发送）'
                    }
                    value={draft}
                    disabled={composerDisabled}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault()
                        void send()
                      }
                    }}
                  />
                  <div className="dz-comp-f">
                    <span className="dz-chip">续聊同一会话 · 不进 Code 栏</span>
                    {chatting && streamRunning ? (
                      <span className="dz-stop" onClick={() => void stopChat()}>
                        ⏹ 停止
                      </span>
                    ) : null}
                    <button
                      className="dz-send"
                      disabled={composerDisabled || streamRunning || !draft.trim()}
                      onClick={() => void send()}
                    >
                      ↵ 发送
                    </button>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>

      {selJob && view === 'chat' && props.railHidden && (
        <button className="edge-restore right" title="显示 Runs 与配置" onClick={() => props.onRailHide(false)}>
          ‹
        </button>
      )}
      {selJob && view === 'chat' && !props.railHidden && (
        <>
        <div
          className="col-rsz"
          title="拖动调宽 · 双击隐藏"
          onMouseDown={props.onDragRail}
          onDoubleClick={() => props.onRailHide(true)}
        />
        <div className="tw-rail" style={{ width: props.railW }}>
          <div className="twr-card">
            <h5>
              Runs <span className="n">最近 12 次</span>
            </h5>
            {jobRuns.length === 0 && <div className="tw-empty">还没有运行记录</div>}
            {jobRuns.map((r) => {
              const s = runIcon(r)
              return (
                <div
                  key={r.id}
                  className={`twr-run${r.id === selRunId ? ' on' : ''}`}
                  onClick={() => pickRun(r.id)}
                >
                  <span className={`twh-st ${s.cls}`}>{s.icon}</span>
                  <span className="when">{fmtDue(r.startedAt)}</span>
                  <span className="tok">{r.outTokens !== null ? fmtTokens(r.outTokens) : '—'}</span>
                </div>
              )
            })}
          </div>
          <div className="twr-card">
            <h5>任务配置</h5>
            <div className="twr-kv">
              <span className="k">周期</span>
              <span className="v">{freqLabel(selJob)}</span>
            </div>
            <div className="twr-kv">
              <span className="k">下次执行</span>
              <span className="v">
                {selJob.enabled && selJob.nextDueAt
                  ? `${fmtDue(selJob.nextDueAt)}（${relIn(selJob.nextDueAt)}）`
                  : '已停用'}
              </span>
            </div>
            <div className="twr-kv">
              <span className="k">目录</span>
              <span className="v" title={selJob.cwd}>
                {selJob.cwd.replace(/^\/Users\/[^/]+/, '~')}
              </span>
            </div>
            <div className="twr-kv">
              <span className="k">模型</span>
              <span className="v">{selJob.model ?? '跟随默认'}</span>
            </div>
            <div className="twr-kv">
              <span className="k">错过补跑</span>
              <span className="v">{selJob.catchUp ? '开' : '关'}</span>
            </div>
            <button className="twr-edit" onClick={() => setView('form')}>
              编辑配置 →
            </button>
          </div>
        </div>
        </>
      )}
    </div>
  )
}

/** 该任务是否有 running 中的记录（Recents 数据即可判断，避免额外查询） */
function jobRunning(j: CronJobDto, recents: CronRunDto[]): boolean {
  return recents.some((r) => r.jobId === j.id && r.status === 'running')
}
