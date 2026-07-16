import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './theme.css'
import type {
  CreateSessionPayload,
  ConnectorsStatusDto,
  CtxInfoDto,
  CustomizeInfoDto,
  GroupDto,
  MemoryFileDto,
  PermissionRequestPayload,
  GitDiffResult,
  SessionListEntry,
  SessionTaskDto,
  SubagentInfoDto,
  UiPermissionMode
} from '../../shared/ipc'
import { useSessionStream, type DiffData, type FlowItem } from './useStream'
import Markdown from './Markdown'
import PermCard from './PermCard'
import TypeText from './TypeText'
import { modeOfHandle } from './ModeTabs'
import { replayToFlow } from './replay'
import NewSessionModal from './NewSessionModal'
import MemoryPane from './MemoryPane'
import LearnPane from './LearnPane'
import SettingsPane from './SettingsPane'
import TaskWorkPane from './TaskWorkPane'
import DesignPane from './DesignPane'
import Sidebar from './Sidebar'
import QuickSwitcher from './QuickSwitcher'
import { fmtTokens, modelMeta } from './ui'
import { applyAppearance, parseAppearance } from './appearance'

interface ActiveSession {
  handle: string
  title: string
  cwd: string
  model: string
  uiMode?: UiPermissionMode
  sessionId?: string
  /** 非空表示这是一个可续聊的回放：首条消息将以 resume 方式创建 live 会话 */
  resumeFrom?: string
}

type Screen = 'work' | 'memory' | 'settings' | 'taskwork' | 'design' | 'learn'

const MODE_LABEL: Record<UiPermissionMode, string> = {
  auto: '自动执行',
  bypass: '全权委托',
  'plan-first': '计划先行',
  'confirm-each': '每步确认'
}

// 右栏上下文用量条分母：Claude 系模型上下文窗口（openrouter/anthropic/* 均为 200k）
const CTX_WINDOW = 200_000

/** chip 内嵌 pdot 的模型标签 */
function ModelChip({ model }: { model: string }): React.JSX.Element {
  const meta = modelMeta(model)
  return (
    <span className="chip">
      <span className={`pdot ${meta.dot}`} />
      {meta.label}
    </span>
  )
}

export default function App(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>('work')
  const [sessions, setSessions] = useState<SessionListEntry[]>([])
  const [groups, setGroups] = useState<GroupDto[]>([])
  const [active, setActive] = useState<ActiveSession | null>(null)
  const [models, setModels] = useState<{ id: string; enabled: boolean }[]>([])
  const [ctx, setCtx] = useState<CtxInfoDto | null>(null)
  const [railMemories, setRailMemories] = useState<MemoryFileDto[]>([])
  const [defaultModel, setDefaultModel] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [showSwitcher, setShowSwitcher] = useState(false)
  const [connected, setConnected] = useState(false)
  const [perm, setPerm] = useState<PermissionRequestPayload | null>(null)
  // 草稿按会话隔离：A 会话打一半切到 B 不串
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [stats, setStats] = useState({ memoryCount: 0, pendingCount: 0, spendText: null as string | null })
  const [slashIdx, setSlashIdx] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const flowRef = useRef<HTMLDivElement>(null)

  const draftKey = active?.handle ?? '~'
  const draft = drafts[draftKey] ?? ''
  const setDraft = useCallback((v: string) => setDrafts((d) => ({ ...d, [draftKey]: v })), [draftKey])

  // 图片附件（粘贴/拖拽），与草稿一样按会话隔离；上限 4 张 / 单张 5MB
  const [attsMap, setAttsMap] = useState<Record<string, { mediaType: string; data: string; preview: string }[]>>({})
  const atts = attsMap[draftKey] ?? []
  const addImageFile = useCallback(
    (f: File) => {
      if (!f.type.startsWith('image/')) return
      if (f.size > 5 * 1024 * 1024) return
      const key = draftKey
      const reader = new FileReader()
      reader.onload = () => {
        const url = String(reader.result)
        const m = /^data:([^;]+);base64,(.+)$/.exec(url)
        if (!m) return
        setAttsMap((prev) => {
          const cur = prev[key] ?? []
          if (cur.length >= 4) return prev
          return { ...prev, [key]: [...cur, { mediaType: m[1], data: m[2], preview: url }] }
        })
      }
      reader.readAsDataURL(f)
    },
    [draftKey]
  )
  const removeAtt = (idx: number): void =>
    setAttsMap((prev) => ({ ...prev, [draftKey]: (prev[draftKey] ?? []).filter((_, j) => j !== idx) }))

  const {
    items,
    running,
    usage,
    runningTool,
    sessionSkills,
    hasCache,
    unreadHandles,
    pushUser,
    pushStatus,
    resolveMemory,
    seed,
    setRunning
  } = useSessionStream(active?.handle ?? null)
  const [stopping, setStopping] = useState(false)

  const enabledModels = models.filter((m) => m.enabled).map((m) => m.id)

  async function actOnMemory(inboxId: number, accept: boolean): Promise<void> {
    try {
      if (accept) await window.letscoding.memory.accept(inboxId)
      else await window.letscoding.memory.discard(inboxId)
      resolveMemory(inboxId, accept ? 'accepted' : 'discarded')
    } catch (e) {
      resolveMemory(inboxId, 'error', String(e))
    }
    void refreshStats()
  }

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await window.letscoding.session.list())
      setGroups(await window.letscoding.groups.list())
    } catch {
      /* store 未就位时忽略 */
    }
  }, [])

  const refreshModels = useCallback(async () => {
    const m = await window.letscoding.models.list()
    setModels(m)
    const st = await window.letscoding.settings.secretStatus()
    setConnected(st.gatewayKeySet && m.length > 0)
    const s = await window.letscoding.settings.get()
    setDefaultModel(s.defaultModel)
  }, [])

  // 侧栏 foot 三行：记忆总数 / 待确认 / 用量（D8：金额只认网关 /spend）
  const refreshStats = useCallback(async () => {
    try {
      const [all, inbox, spend] = await Promise.all([
        window.letscoding.memory.list(null),
        window.letscoding.memory.inbox(),
        window.letscoding.spend.summary()
      ])
      setStats({
        memoryCount: all.length,
        pendingCount: inbox.length,
        spendText: spend.available && spend.spendUsd !== null ? `$${spend.spendUsd.toFixed(2)}` : null
      })
    } catch {
      /* 网关/存储未就位时忽略 */
    }
  }, [])

  useEffect(() => {
    void refreshSessions()
    void refreshModels()
    void refreshStats()
    const unsub = window.letscoding.perm.onRequest(setPerm)
    return unsub
  }, [refreshSessions, refreshModels, refreshStats])

  // 会话连续性：应用重开自动回到上次活跃会话（直接续聊态；模型未就绪则先回放、就绪后自动升级）
  useEffect(() => {
    void (async () => {
      try {
        const st = await window.letscoding.settings.get()
        if (!st.lastSessionId) return
        const list = await window.letscoding.session.list()
        const hit = list.find((x) => x.sessionId === st.lastSessionId)
        if (hit) void openSession(hit)
      } catch {
        /* store 未就位时忽略 */
      }
    })()
    // 仅启动时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 「停止中…」态只属于当前会话，切换会话即复位
  useEffect(() => {
    setStopping(false)
  }, [active?.handle])

  // ⌘K 快速切换；⌘B / ⌘⇧B 折叠左栏 / 右栏（仅工作台）
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (screen === 'work') setShowSwitcher((v) => !v)
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b' && screen === 'work') {
        e.preventDefault()
        setPanel((p) => (e.shiftKey ? { ...p, railHide: !p.railHide } : { ...p, sideHide: !p.sideHide }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [screen])

  useEffect(() => {
    flowRef.current?.scrollTo({ top: flowRef.current.scrollHeight })
  }, [items])

  // 打字机步进时跟随滚动（仅当已近底部——用户上滚翻旧内容时不抢）
  const followTail = useCallback(() => {
    const el = flowRef.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight
  }, [])
  // 只动画运行中的最后一条 assistant（挂载时捕获，见 TypeText）
  const lastAssistantId = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'assistant') return items[i].id
    return null
  }, [items])

  // 新建会话在列表刷新后拿到 sessionId：回填 active（右栏/分支 chip）并记录连续性
  useEffect(() => {
    if (!active || active.sessionId || active.handle.startsWith('view-')) return
    const hit = sessions.find((s) => s.live?.handle === active.handle)
    if (hit) {
      setActive((a) => (a && a.handle === active.handle ? { ...a, sessionId: hit.sessionId } : a))
      window.letscoding.settings.set({ lastSessionId: hit.sessionId }).catch(() => {})
    }
  }, [sessions, active])

  // 右栏 .claude 上下文 + 目录记忆随活跃 cwd 刷新
  useEffect(() => {
    if (active?.cwd) {
      void window.letscoding.ctx.info(active.cwd).then(setCtx)
      void window.letscoding.memory.list(active.cwd).then(setRailMemories).catch(() => setRailMemories([]))
    } else {
      setCtx(null)
      setRailMemories([])
    }
  }, [active?.cwd, active?.sessionId])

  // 本轮改动：按文件聚合 Edit/Write 的 diff（右栏可展开查看具体改动）
  const changedByFile = useMemo(() => {
    const map = new Map<string, DiffData[]>()
    for (const it of items) {
      if (it.kind === 'tool' && it.diff) {
        map.set(it.diff.file, [...(map.get(it.diff.file) ?? []), it.diff])
      }
    }
    return map
  }, [items])

  // 右栏分组折叠：Skills/本轮改动默认收起（用户诉求），上下文/记忆/会话默认展开
  const [railOpen, setRailOpen] = useState<Record<string, boolean>>({
    ctx: true,
    mem: true,
    skills: false,
    changes: false,
    tasks: true,
    agents: false,
    sess: true
  })
  function toggleRail(k: string): void {
    setRailOpen((o) => ({ ...o, [k]: !o[k] }))
  }
  // Skills 小节默认只露 4 条，more-link 原地展开
  const [skillsAll, setSkillsAll] = useState(false)

  // 会话关联信息（右栏）：Claude Code 待办 + transcript 路径；运行中 20s 轮询待办
  const [sessTasks, setSessTasks] = useState<SessionTaskDto[]>([])
  const [transcript, setTranscript] = useState<string | null>(null)
  useEffect(() => {
    const sid = active?.sessionId
    const cwd = active?.cwd
    if (!sid) {
      setSessTasks([])
      setTranscript(null)
      return
    }
    const load = (): void => {
      void window.letscoding.sessionInfo.tasks(sid).then(setSessTasks).catch(() => {})
      if (cwd) {
        void window.letscoding.sessionInfo
          .transcriptPath(sid, cwd)
          .then((r) => setTranscript(r.path))
          .catch(() => {})
      }
    }
    load()
    if (!running) return
    const t = setInterval(load, 20_000)
    return () => clearInterval(t)
  }, [active?.sessionId, active?.cwd, running])

  // 右栏子 Agent 进度：当前流里的 Task/Agent 工具项（回放与实时同源）
  const subagentItems = useMemo(
    () =>
      items.filter(
        (it) =>
          it.kind === 'tool' &&
          ((it.sub?.length ?? 0) > 0 || it.toolName === 'Task' || it.toolName === 'Agent')
      ),
    [items]
  )

  // 「自定义」弹窗（Skills / 连接器 / 插件），入口在左栏新建会话下方
  const [customize, setCustomize] = useState<CustomizeInfoDto | null>(null)
  const [connectors, setConnectors] = useState<ConnectorsStatusDto | null>(null)
  const [showCustomize, setShowCustomize] = useState(false)
  const [custTab, setCustTab] = useState<'skills' | 'connectors' | 'plugins'>('skills')
  const composerRef = useRef<HTMLTextAreaElement>(null)
  function refreshConnectors(): void {
    setConnectors(null) // 「检测中…」态
    window.letscoding.customize
      .connectors()
      .then(setConnectors)
      .catch(() => setConnectors(null))
  }
  function openCustomize(): void {
    setShowCustomize(true)
    window.letscoding.customize
      .info(active?.cwd ?? null)
      .then(setCustomize)
      .catch(() => setCustomize({ skills: [], plugins: [] }))
    refreshConnectors()
  }
  // skill「使用」：/name 插入当前草稿并聚焦输入框（不发送，参数由用户补）
  function applySkill(name: string): void {
    setDrafts((m) => ({ ...m, [draftKey]: `/${name} ${m[draftKey] ?? ''}` }))
    setShowCustomize(false)
    setTimeout(() => composerRef.current?.focus(), 50)
  }

  // 面板布局：左右栏宽度可拖、可隐藏；偏好按 D5 落 state.db（settings.panel_layout）
  const [panel, setPanel] = useState({
    sideW: 264,
    railW: 290,
    // M21b：TaskWork 右栏 / Design 对话列（左列三模式共享 sideW，切换不跳宽）
    twRailW: 272,
    dzChatW: 330,
    sideHide: false,
    railHide: false,
    twRailHide: false,
    dzChatHide: false
  })
  const panelLoaded = useRef(false)
  useEffect(() => {
    window.letscoding.settings
      .get()
      .then((st) => {
        if (st.panelLayout) {
          try {
            setPanel((p) => ({ ...p, ...JSON.parse(st.panelLayout as string) }))
          } catch {
            /* 坏数据忽略，用默认 */
          }
        }
        // 外观（背景/缩放/卡片字号）随启动应用一次；设置页变更时由 SettingsPane 直接生效
        applyAppearance(parseAppearance(st.appearance))
      })
      .catch(() => {})
      .finally(() => {
        panelLoaded.current = true
      })
  }, [])
  useEffect(() => {
    // 拖拽期高频变更 → 300ms 去抖落盘；加载完成前不回写（避免默认值覆盖已存偏好）
    if (!panelLoaded.current) return
    const t = setTimeout(() => {
      window.letscoding.settings.set({ panelLayout: JSON.stringify(panel) }).catch(() => {})
    }, 300)
    return () => clearTimeout(t)
  }, [panel])

  // 分隔条拖拽：左栏拖右缘、右侧栏拖左缘；拖到过窄（<150px）折叠隐藏，反向拖回自动恢复。
  // M21b 泛化四键；noCollapse 用于 TaskWork/Design 左列（承载模式 tabs，折叠会失去导航入口）
  const PANEL_DRAG = {
    side: { dir: 1, min: 200, max: 420, w: 'sideW', h: 'sideHide' },
    rail: { dir: -1, min: 230, max: 480, w: 'railW', h: 'railHide' },
    twRail: { dir: -1, min: 200, max: 420, w: 'twRailW', h: 'twRailHide' },
    dzChat: { dir: -1, min: 240, max: 520, w: 'dzChatW', h: 'dzChatHide' }
  } as const
  function startPanelDrag(
    which: keyof typeof PANEL_DRAG,
    e: React.MouseEvent,
    opts?: { noCollapse?: boolean }
  ): void {
    e.preventDefault()
    const cfg = PANEL_DRAG[which]
    const startX = e.clientX
    const startW = panel[cfg.w]
    const onMove = (ev: MouseEvent): void => {
      const w = startW + cfg.dir * (ev.clientX - startX)
      setPanel((p) => {
        if (w < 150 && !opts?.noCollapse) return { ...p, [cfg.h]: true }
        const clamped = Math.min(cfg.max, Math.max(cfg.min, w))
        return { ...p, [cfg.h]: false, [cfg.w]: clamped }
      })
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('col-resizing')
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.classList.add('col-resizing')
  }

  const activeEntry = useMemo(
    () => (active?.sessionId ? sessions.find((s) => s.sessionId === active.sessionId) : undefined),
    [sessions, active?.sessionId]
  )

  // Design 模式可切换的项目目录：active cwd 优先，其余按最近活跃去重（上限 8）
  const designCwds = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    if (active?.cwd) {
      seen.add(active.cwd)
      out.push(active.cwd)
    }
    for (const s of [...sessions].sort((a, b) => b.lastModified - a.lastModified)) {
      if (s.cwd && !seen.has(s.cwd)) {
        seen.add(s.cwd)
        out.push(s.cwd)
      }
      if (out.length >= 8) break
    }
    return out
  }, [sessions, active?.cwd])

  const recentCwds = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const s of [...sessions].sort((a, b) => b.lastModified - a.lastModified)) {
      if (s.cwd && !seen.has(s.cwd)) {
        seen.add(s.cwd)
        out.push(s.cwd)
      }
      if (out.length >= 3) break
    }
    return out
  }, [sessions])

  // ---- 斜杠 skill 提示：输入以 / 开头（未含空格）时弹出可选 skill ----
  // 真值优先：live 会话 init 上报的 skills；未上报（回放/未连）用 .claude 目录扫描兜底
  const skillOptions = useMemo(() => {
    const scan = ctx?.skills ?? []
    const descMap = new Map(scan.map((s) => [s.name, s.description]))
    const names = sessionSkills ?? scan.map((s) => s.name)
    return [...new Set(names)].sort().map((n) => ({ name: n, description: descMap.get(n) ?? '' }))
  }, [sessionSkills, ctx])

  const slashPrefix = useMemo(() => {
    const m = /^\/([a-zA-Z0-9_-]*)$/.exec(draft)
    return m ? m[1].toLowerCase() : null
  }, [draft])

  const slashList = useMemo(() => {
    if (slashPrefix === null || slashDismissed) return []
    return skillOptions.filter((o) => o.name.toLowerCase().startsWith(slashPrefix)).slice(0, 8)
  }, [slashPrefix, slashDismissed, skillOptions])

  useEffect(() => {
    if (slashIdx >= slashList.length) setSlashIdx(Math.max(0, slashList.length - 1))
  }, [slashList, slashIdx])

  function pickSkill(name: string): void {
    setDraft(`/${name} `)
    setSlashIdx(0)
  }

  function onCreate(p: CreateSessionPayload): void {
    setShowNew(false)
    seed(p.handle, [{ id: 'u0', kind: 'user', text: p.firstPrompt }])
    // 乐观置运行态：停止按钮/运行提示从创建那一刻就可用，不等首个流事件
    setRunning(p.handle, true)
    window.letscoding.session.create(p).catch((e) => {
      setRunning(p.handle, false)
      pushStatus(`会话启动失败：${String(e)}`)
    })
    setActive({
      handle: p.handle,
      title: p.firstPrompt.slice(0, 40),
      cwd: p.cwd,
      model: p.model,
      uiMode: p.uiMode
    })
    setTimeout(refreshSessions, 1500)
  }

  function switchMode(mode: UiPermissionMode): void {
    if (!active || active.resumeFrom) return
    if (active.handle.startsWith('view-')) return
    void window.letscoding.session.setMode(active.handle, mode)
    setActive({ ...active, uiMode: mode })
  }

  // 回放 → FlowItem 列表，并按 Task tool_use_id 挂上子 agent 步骤（subagents/ 目录）
  async function loadReplayFlow(sessionId: string, cwd: string | undefined): Promise<FlowItem[]> {
    const empty: Record<string, SubagentInfoDto> = {}
    const [msgs, subs] = await Promise.all([
      window.letscoding.session.replay(sessionId),
      window.letscoding.session.subagents(sessionId, cwd ?? '').catch(() => empty)
    ])
    const flow = replayToFlow(msgs)
    for (const it of flow) {
      const info = it.kind === 'tool' && it.toolUseId ? subs[it.toolUseId] : undefined
      if (info) {
        it.sub = info.steps.map((x) => x.label)
        it.subDesc = info.description
      }
    }
    return flow
  }

  async function openSession(s: SessionListEntry): Promise<void> {
    setShowSwitcher(false)
    // 记住最后打开的会话（重开应用自动回到这里）
    window.letscoding.settings.set({ lastSessionId: s.sessionId }).catch(() => {})
    if (s.live) {
      // live 会话切回：流桶还在就直接用（useStream 按 handle 分桶，后台事件未丢）；
      // 没有缓存（如极端时序）才从 transcript 回放播种
      if (!hasCache(s.live.handle)) {
        seed(s.live.handle, await loadReplayFlow(s.sessionId, s.cwd))
      }
      setActive({
        handle: s.live.handle,
        title: s.customTitle ?? s.summary,
        cwd: s.cwd ?? '',
        model: s.live.model,
        // 档位显示引擎真值：bypass 会话切走再切回不得谎报为「自动执行」（D14 审计项）
        uiMode: s.live.uiMode,
        sessionId: s.sessionId
      })
      return
    }
    // 非运行中会话：直接进入续聊态（点开即可打字，免「继续会话」一步）；
    // 模型清单未就绪时先落只读回放，下面的升级 effect 会在模型到位后自动转续聊
    const flow = await loadReplayFlow(s.sessionId, s.cwd)
    if (enabledModels.length > 0) {
      const preferred =
        defaultModel && enabledModels.includes(defaultModel) ? defaultModel : enabledModels[0]
      const handle = `h-${Date.now()}`
      seed(handle, flow)
      setActive({
        handle,
        title: s.customTitle ?? s.summary,
        cwd: s.cwd ?? '',
        model: preferred,
        uiMode: 'auto',
        sessionId: s.sessionId,
        resumeFrom: s.sessionId
      })
      return
    }
    seed(`view-${s.sessionId}`, flow)
    setActive({
      handle: `view-${s.sessionId}`,
      title: s.customTitle ?? s.summary,
      cwd: s.cwd ?? '',
      model: '',
      sessionId: s.sessionId
    })
  }

  // 只读回放 → 续聊态的升级补偿：冷启动续上上次会话时模型清单可能晚于打开就绪，
  // 到位后自动转续聊，与「点开即续聊」行为对齐（view- 态仅剩无模型这一种来源）
  useEffect(() => {
    if (enabledModels.length > 0 && active?.handle.startsWith('view-') && active.sessionId) {
      beginResume()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabledModels.length, active?.handle])

  // 从回放进入续聊：切到「待续聊」态，首条消息以 resume 创建 live 会话
  function beginResume(): void {
    if (!active?.sessionId || enabledModels.length === 0) return
    const preferred = defaultModel && enabledModels.includes(defaultModel) ? defaultModel : enabledModels[0]
    const newHandle = `h-${Date.now()}`
    seed(newHandle, items) // 把回放历史带进续聊桶，视觉连续
    setActive({
      ...active,
      handle: newHandle,
      model: preferred,
      uiMode: 'auto',
      resumeFrom: active.sessionId
    })
  }

  async function sendDraft(): Promise<void> {
    if (!active || (!draft.trim() && atts.length === 0)) return
    const text = draft.trim()
    const key = draftKey
    const images = atts.map((a) => ({ media_type: a.mediaType, data: a.data }))
    const previews = atts.map((a) => a.preview)
    const clearAtts = (): void => setAttsMap((m) => ({ ...m, [key]: [] }))
    if (active.resumeFrom) {
      // 首条续聊消息：创建带 resume 的 live 会话。create 失败必须回退，
      // 否则消息已推、handle 悬空、UI 卡死（审计发现的续聊无回退问题）。
      const resumeFrom = active.resumeFrom
      pushUser(text, previews)
      setRunning(active.handle, true)
      setDraft('')
      clearAtts()
      try {
        await window.letscoding.session.create({
          handle: active.handle,
          cwd: active.cwd,
          model: active.model,
          uiMode: active.uiMode ?? 'auto',
          resume: resumeFrom,
          firstPrompt: text,
          ...(images.length ? { images } : {})
        })
        setActive({ ...active, resumeFrom: undefined })
        setTimeout(refreshSessions, 1500)
      } catch (e) {
        // 回退到可续聊态，让用户重试；把失败显式告知
        setRunning(active.handle, false)
        pushUser(`（续聊创建失败，请重试）${String(e)}`)
        setDraft(text)
      }
      return
    }
    if (active.handle.startsWith('view-')) return
    const handle = active.handle
    pushUser(text, previews)
    setRunning(handle, true)
    setDraft('')
    clearAtts()
    window.letscoding.session.send(handle, text, images.length ? images : undefined).catch((e) => {
      setRunning(handle, false)
      pushStatus(`发送失败：${String(e)}`)
    })
  }

  // 打断当前轮（SDK interrupt）。启动窗口期也可点：失败给出可见反馈而非静默吞掉
  async function stopActive(): Promise<void> {
    if (!active || stopping) return
    setStopping(true)
    try {
      await window.letscoding.session.interrupt(active.handle)
    } catch (e) {
      pushStatus(`停止失败：${String(e)}`)
    } finally {
      setStopping(false)
    }
  }

  function respondPerm(allow: boolean, always = false): void {
    if (!perm) return
    void window.letscoding.perm.respond({ requestId: perm.requestId, allow, always })
    setPerm(null)
  }

  // 应用内文本输入弹窗（Electron 渲染层不支持 window.prompt，新建分组/重命名都走这里）
  const [textPrompt, setTextPrompt] = useState<{
    title: string
    initial: string
    submit: (v: string) => void
  } | null>(null)
  const promptInputRef = useRef<HTMLInputElement>(null)
  function askText(title: string, initial: string, submit: (v: string) => void): void {
    setTextPrompt({ title, initial, submit })
  }
  function submitTextPrompt(): void {
    const v = promptInputRef.current?.value.trim()
    const submit = textPrompt?.submit
    setTextPrompt(null)
    if (v && submit) submit(v)
  }

  // ---- 会话管理动作 ----
  async function pinSession(s: SessionListEntry, pinned: boolean): Promise<void> {
    await window.letscoding.session.setMeta({ sessionId: s.sessionId, pinned })
    void refreshSessions()
  }
  async function moveSession(s: SessionListEntry, group: string | null): Promise<void> {
    await window.letscoding.session.setMeta({ sessionId: s.sessionId, group_name: group })
    void refreshSessions()
  }
  function renameSession(s: SessionListEntry): void {
    askText('会话新标题', s.customTitle ?? s.summary, (next) => {
      void window.letscoding.session.rename(s.sessionId, next, s.cwd).then(refreshSessions)
    })
  }
  async function deleteSession(s: SessionListEntry): Promise<void> {
    if (!window.confirm(`删除会话「${s.customTitle ?? s.summary}」？此操作不可撤销。`)) return
    await window.letscoding.session.remove(s.sessionId, s.cwd)
    if (active?.sessionId === s.sessionId) setActive(null)
    void refreshSessions()
  }
  function createGroup(): void {
    askText('新建分组名称', '', (name) => {
      void window.letscoding.groups.create(name).then(refreshSessions)
    })
  }
  function renameGroup(name: string): void {
    askText('分组新名称', name, (next) => {
      if (next !== name) void window.letscoding.groups.rename(name, next).then(refreshSessions)
    })
  }
  async function deleteGroup(name: string): Promise<void> {
    if (!window.confirm(`删除分组「${name}」？组内会话将回到未分组（会话本身不删除）。`)) return
    await window.letscoding.groups.remove(name)
    void refreshSessions()
  }
  async function collapseGroup(name: string, collapsed: boolean): Promise<void> {
    await window.letscoding.groups.collapse(name, collapsed)
    void refreshSessions()
  }
  // 卡片拖拽投放：拖到置顶=置顶；拖到分组/未分组=归组（并取消置顶，符合直觉）
  async function dropSession(
    sessionId: string,
    target: { pinned?: boolean; group?: string | null }
  ): Promise<void> {
    if (target.pinned) {
      await window.letscoding.session.setMeta({ sessionId, pinned: true })
    } else {
      await window.letscoding.session.setMeta({ sessionId, pinned: false, group_name: target.group ?? null })
    }
    void refreshSessions()
  }

  // 「± 改动」面板：会话 cwd 的 git 工作区快照
  const [diffPanel, setDiffPanel] = useState<GitDiffResult | 'loading' | null>(null)
  async function openDiffPanel(): Promise<void> {
    if (!active?.cwd) return
    setDiffPanel('loading')
    try {
      setDiffPanel(await window.letscoding.git.diff(active.cwd))
    } catch (e) {
      setDiffPanel({ isRepo: false, stat: String(e), diffText: '', untracked: [] })
    }
  }

  // ---- 连续工具调用合并为批次列表（diff 块/文本/记忆事件自然断组）----
  type FlowBlock = { type: 'one'; it: FlowItem } | { type: 'batch'; key: string; tools: FlowItem[] }
  const blocks = useMemo<FlowBlock[]>(() => {
    const out: FlowBlock[] = []
    let run: FlowItem[] = []
    const flush = (): void => {
      if (run.length >= 2) out.push({ type: 'batch', key: run[0].id, tools: run })
      else for (const t of run) out.push({ type: 'one', it: t })
      run = []
    }
    for (const it of items) {
      if (it.kind === 'tool' && !it.diff && !it.sub?.length) run.push(it)
      else {
        flush()
        out.push({ type: 'one', it })
      }
    }
    flush()
    return out
  }, [items])
  const [openBatches, setOpenBatches] = useState<Set<string>>(new Set())
  const BATCH_SHOW = 5

  function toggleBatch(key: string): void {
    setOpenBatches((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  }

  const isLive = active && !active.handle.startsWith('view-') && !active.resumeFrom
  const canCompose = isLive || active?.resumeFrom
  // 可停止 ≠ isLive：续聊首轮（resumeFrom 在途）也要能停——interrupt 失败会有可见反馈兜底
  const canStop = !!active && !active.handle.startsWith('view-') && running

  // M20-A：非 Code 屏的权限请求以全局浮层就地处理（Code 屏保持聊天列内联，行为不变）
  const permMode = modeOfHandle(perm?.handle ?? null)
  const permOverlay = perm ? (
    <div className="perm-overlay">
      <PermCard perm={perm} onRespond={respondPerm} />
    </div>
  ) : null

  // ---- 全屏页路由（设计稿 ③④）----
  if (screen === 'memory') {
    return (
      <>
        <MemoryPane
          cwd={active?.cwd ?? null}
          onBack={() => {
            setScreen('work')
            void refreshStats()
            if (active?.cwd) void window.letscoding.memory.list(active.cwd).then(setRailMemories)
          }}
        />
        {permOverlay}
      </>
    )
  }
  if (screen === 'learn') {
    return (
      <>
        <LearnPane onBack={() => setScreen('work')} onOpenSettings={() => setScreen('settings')} />
        {permOverlay}
      </>
    )
  }
  if (screen === 'settings') {
    return (
      <>
        <SettingsPane
          activeCwd={active?.cwd ?? null}
          onBack={() => {
            setScreen('work')
            void refreshModels()
            void refreshStats()
          }}
          onChanged={() => {
            void refreshModels()
            void refreshStats()
          }}
        />
        {permOverlay}
      </>
    )
  }
  if (screen === 'design') {
    return (
      <>
        <DesignPane
          width={panel.sideW}
          chatW={panel.dzChatW}
          chatHidden={panel.dzChatHide}
          cwds={designCwds}
          permHandle={perm?.handle ?? null}
          permMode={permMode}
          onDragSide={(e) => startPanelDrag('side', e, { noCollapse: true })}
          onDragChat={(e) => startPanelDrag('dzChat', e)}
          onChatHide={(v) => setPanel((p) => ({ ...p, dzChatHide: v }))}
          onBack={() => {
            setScreen('work')
            void refreshSessions()
          }}
          onTaskWork={() => setScreen('taskwork')}
        />
        {permOverlay}
      </>
    )
  }
  if (screen === 'taskwork') {
    return (
      <>
        <TaskWorkPane
          width={panel.sideW}
          railW={panel.twRailW}
          railHidden={panel.twRailHide}
          defaultCwd={active?.cwd ?? null}
          defaultModel={defaultModel}
          permMode={permMode}
          onDragSide={(e) => startPanelDrag('side', e, { noCollapse: true })}
          onDragRail={(e) => startPanelDrag('twRail', e)}
          onRailHide={(v) => setPanel((p) => ({ ...p, twRailHide: v }))}
          onDesign={() => setScreen('design')}
          onBack={() => {
            setScreen('work')
            void refreshSessions()
          }}
        />
        {permOverlay}
      </>
    )
  }

  return (
    <div className="wb">
      {panel.sideHide && (
        <button
          className="edge-restore left"
          title="显示会话栏（⌘B）"
          onClick={() => setPanel((p) => ({ ...p, sideHide: false }))}
        >
          ›
        </button>
      )}
      {active && panel.railHide && (
        <button
          className="edge-restore right"
          title="显示信息栏（⌘⇧B）"
          onClick={() => setPanel((p) => ({ ...p, railHide: false }))}
        >
          ‹
        </button>
      )}
      {!panel.sideHide && (
      <Sidebar
        width={panel.sideW}
        onCustomize={openCustomize}
        sessions={sessions}
        groups={groups}
        activeSessionId={active?.sessionId}
        onOpen={(s) => void openSession(s)}
        onNew={() => setShowNew(true)}
        onSearch={() => setShowSwitcher(true)}
        onNavigate={setScreen}
        onModeSwitch={setScreen}
        connected={connected}
        stats={stats}
        permHandle={perm?.handle ?? null}
        permMode={permMode}
        unreadHandles={unreadHandles}
        onPin={(s, p) => void pinSession(s, p)}
        onMove={(s, g) => void moveSession(s, g)}
        onRename={(s) => void renameSession(s)}
        onDelete={(s) => void deleteSession(s)}
        onCreateGroup={() => void createGroup()}
        onRenameGroup={(n) => void renameGroup(n)}
        onDeleteGroup={(n) => void deleteGroup(n)}
        onCollapseGroup={(n, c) => void collapseGroup(n, c)}
        onDropSession={(id, t) => void dropSession(id, t)}
      />
      )}
      {!panel.sideHide && (
        <div
          className="col-rsz"
          title="拖动调宽 · 双击隐藏"
          onMouseDown={(e) => startPanelDrag('side', e)}
          onDoubleClick={() => setPanel((p) => ({ ...p, sideHide: true }))}
        />
      )}

      <main className="main">
        {!active ? (
          <div className="empty">
            <div style={{ fontSize: 15 }}>选择一个会话，或新建一个</div>
            <div style={{ fontSize: 12.5 }}>
              {connected ? '⌘K 快速切换会话' : '先在左下角设置里配置 LiteLLM 网关'}
            </div>
          </div>
        ) : (
          <>
            <div className="sess-head">
              <span className="sh-title">{active.title || '会话'}</span>
              <div className="sh-chips">
                {active.cwd && (
                  <span className="chip">
                    <code>{active.cwd.replace(/^\/Users\/[^/]+/, '~')}</code>
                  </span>
                )}
                {activeEntry?.gitBranch && (
                  <span className="chip">
                    <code>⎇ {activeEntry.gitBranch}</code>
                  </span>
                )}
              </div>
              <div className="sh-right">
                {active.cwd && (
                  <>
                    <button
                      className="mini"
                      title="在终端打开该目录"
                      onClick={() => void window.letscoding.shell.terminal(active.cwd)}
                    >
                      &gt;_
                    </button>
                    <button className="mini" title="查看工作区改动（git diff）" onClick={() => void openDiffPanel()}>
                      ±
                    </button>
                  </>
                )}
                {active.model && <ModelChip model={active.model} />}
                {isLive && active.uiMode && <span className="chip">{MODE_LABEL[active.uiMode]}</span>}
                {usage && (
                  <span className="chip mono">
                    ↑{fmtTokens(usage.inTok)} ↓{fmtTokens(usage.outTok)}
                  </span>
                )}
                {canStop && (
                  <button className="mini" disabled={stopping} onClick={() => void stopActive()}>
                    {stopping ? '停止中…' : '停止'}
                  </button>
                )}
                <button
                  className="mini"
                  title={`${panel.sideHide ? '显示' : '隐藏'}会话栏（⌘B）`}
                  onClick={() => setPanel((p) => ({ ...p, sideHide: !p.sideHide }))}
                >
                  ◧
                </button>
                <button
                  className="mini"
                  title={`${panel.railHide ? '显示' : '隐藏'}信息栏（⌘⇧B）`}
                  onClick={() => setPanel((p) => ({ ...p, railHide: !p.railHide }))}
                >
                  ◨
                </button>
              </div>
            </div>

            {!isLive && !active.resumeFrom && (
              <div className="banner">
                <span>只读回放 · 该会话未在运行</span>
                {enabledModels.length > 0 && (
                  <button className="mini acc" style={{ marginLeft: 12 }} onClick={beginResume}>
                    继续会话
                  </button>
                )}
              </div>
            )}
            {active.resumeFrom && (
              <div className="banner banner-ok">
                续聊模式 · 发送首条消息即以完整历史恢复会话（模型 {modelMeta(active.model).label}）
              </div>
            )}

            <div className="flow" ref={flowRef}>
              {blocks.map((b) => {
                if (b.type === 'batch') {
                  const open = openBatches.has(b.key)
                  const folded = b.tools.length > BATCH_SHOW + 1 && !open
                  const shown = folded ? b.tools.slice(-BATCH_SHOW) : b.tools
                  return (
                    <div key={b.key} className="tgroup">
                      {(folded || open) && (
                        <div className="tg-more" onClick={() => toggleBatch(b.key)}>
                          {folded ? `▸ 展开较早的 ${b.tools.length - shown.length} 条调用` : '▴ 收起'}
                        </div>
                      )}
                      {shown.map((t) => (
                        <div key={t.id} className="tg-row">
                          <span className="tico">{t.toolName === 'Bash' ? '$' : '›'}</span>
                          {t.toolName !== 'Bash' && <span className="tg-name">{t.toolName}</span>}
                          {t.toolInput && <code>{t.toolInput}</code>}
                          {t.tres && <span className="tres">{t.tres}</span>}
                        </div>
                      ))}
                    </div>
                  )
                }
                const it = b.it
                if (it.kind === 'user')
                  return (
                    <div key={it.id} className="msg-u">
                      {it.images?.map((src, i) => (
                        <img key={i} className="msg-img" src={src} alt="" />
                      ))}
                      {it.text}
                    </div>
                  )
                if (it.kind === 'assistant')
                  return (
                    <div key={it.id} className="msg-a">
                      <TypeText
                        text={it.text ?? ''}
                        animate={running && it.id === lastAssistantId}
                        onGrow={followTail}
                      />
                    </div>
                  )
                if (it.kind === 'tool') {
                  // 子 agent（Task）：容器头 + 步骤列表（长列表折叠，复用批次样式）
                  if (it.sub?.length) {
                    const key = `sub-${it.id}`
                    const open = openBatches.has(key)
                    const folded = it.sub.length > BATCH_SHOW + 1 && !open
                    const shown = folded ? it.sub.slice(-BATCH_SHOW) : it.sub
                    return (
                      <div key={it.id} className="tgroup">
                        <div className="tg-row tg-task">
                          <span className="tico">⚙</span>
                          <span className="tg-name">{it.toolName ?? 'Task'}</span>
                          {(it.subDesc || it.toolInput) && <code>{it.subDesc || it.toolInput}</code>}
                          <span className="tres">{it.tres ?? `${it.sub.length} 步`}</span>
                        </div>
                        {(folded || open) && (
                          <div className="tg-more" onClick={() => toggleBatch(key)}>
                            {folded ? `▸ 展开较早的 ${it.sub.length - shown.length} 步` : '▴ 收起'}
                          </div>
                        )}
                        {shown.map((label, i) => (
                          <div key={`${it.id}-s${i}`} className="tg-row tg-sub">
                            <span className="tico">·</span>
                            <code>{label}</code>
                          </div>
                        ))}
                      </div>
                    )
                  }
                  if (it.diff) {
                    // 代码改动默认收起：头部保留文件/徽标/±行数，点击展开
                    const dkey = `diff-${it.id}`
                    const dopen = openBatches.has(dkey)
                    return (
                      <div key={it.id} className="diff">
                        <div className="dh dh-toggle" onClick={() => toggleBatch(dkey)}>
                          <span className="dh-cv">{dopen ? '▾' : '▸'}</span>
                          <span className="dh-file">{it.diff.file}</span>
                          <span className="badge">{it.diff.badge}</span>
                          <span className="dh-sum">
                            <em className="plus">+{it.diff.addN}</em>
                            {it.diff.delN > 0 && <em className="minus">−{it.diff.delN}</em>}
                          </span>
                          {it.tres && <span className="dh-tres">{it.tres}</span>}
                        </div>
                        {dopen && (
                          <pre>
                            {it.diff.del.map((l, i) => (
                              <span key={`d${i}`} className="del">
                                - {l}
                              </span>
                            ))}
                            {it.diff.add.map((l, i) => (
                              <span key={`a${i}`} className="add">
                                + {l}
                              </span>
                            ))}
                          </pre>
                        )}
                      </div>
                    )
                  }
                  return (
                    <div key={it.id} className="tool">
                      <span className="tico">{it.toolName === 'Bash' ? '$' : '›'}</span>
                      {it.toolName !== 'Bash' && <span>{it.toolName}</span>}
                      {it.toolInput && <code>{it.toolInput}</code>}
                      {it.tres && <span className="tres">{it.tres}</span>}
                    </div>
                  )
                }
                if (it.kind === 'memory' && it.memory)
                  return (
                    <div key={it.id} className="mem-ev">
                      <span className="mv-ico">✦</span>
                      <span className="mv-body">
                        <b>记忆沉淀建议</b> · {it.memory.memType} ·「{it.memory.description}」
                      </span>
                      {it.memory.resolved === undefined ? (
                        <>
                          <button className="mini acc" onClick={() => void actOnMemory(it.memory!.inboxId, true)}>
                            确认落盘
                          </button>
                          <button className="mini" onClick={() => void actOnMemory(it.memory!.inboxId, false)}>
                            忽略
                          </button>
                        </>
                      ) : (
                        <span style={{ fontSize: 11.5, color: it.memory.resolved === 'error' ? 'var(--err)' : 'var(--dim)' }}>
                          {it.memory.resolved === 'accepted'
                            ? '已落盘'
                            : it.memory.resolved === 'discarded'
                              ? '已忽略'
                              : `失败：${it.memory.note}`}
                        </span>
                      )}
                    </div>
                  )
                return (
                  <div key={it.id} style={{ fontSize: 12.5, color: 'var(--dim)' }}>
                    {it.status}
                  </div>
                )
              })}
              {running && (
                <div className="runline">
                  <span className="spin" />
                  正在运行
                  {runningTool && <code>{runningTool.cmd || runningTool.name}</code>}
                </div>
              )}
            </div>

            {perm && (
              <div style={{ padding: '0 22px 8px' }}>
                <PermCard perm={perm} onRespond={respondPerm} />
              </div>
            )}

            <div className="composer">
              {canCompose && slashList.length > 0 && (
                <div className="slash-menu">
                  <div className="slash-hint">Skills · ↑↓ 选择 · ⏎ 填入 · Esc 关闭</div>
                  {slashList.map((o, i) => (
                    <div
                      key={o.name}
                      className={`slash-item${i === slashIdx ? ' on' : ''}`}
                      onMouseEnter={() => setSlashIdx(i)}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        pickSkill(o.name)
                      }}
                    >
                      <span className="sl-name">/{o.name}</span>
                      {o.description && <span className="sl-desc">{o.description}</span>}
                    </div>
                  ))}
                </div>
              )}
              <div
                className="cbox"
                onDragOver={(e) => {
                  if (canCompose) e.preventDefault()
                }}
                onDrop={(e) => {
                  if (!canCompose) return
                  e.preventDefault()
                  for (const f of Array.from(e.dataTransfer.files)) addImageFile(f)
                }}
              >
                {canCompose && atts.length > 0 && (
                  <div className="att-row">
                    {atts.map((a, i) => (
                      <span key={i} className="att-thumb">
                        <img src={a.preview} alt="" />
                        <button className="att-x" title="移除" onClick={() => removeAtt(i)}>
                          ✕
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <textarea
                  ref={composerRef}
                  rows={2}
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value)
                    setSlashDismissed(false)
                  }}
                  onPaste={(e) => {
                    const files = Array.from(e.clipboardData.items)
                      .filter((i) => i.kind === 'file')
                      .map((i) => i.getAsFile())
                      .filter((f): f is File => !!f && f.type.startsWith('image/'))
                    if (files.length) {
                      e.preventDefault()
                      files.forEach(addImageFile)
                    }
                  }}
                  onKeyDown={(e) => {
                    if (canCompose && slashList.length > 0) {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault()
                        setSlashIdx((i) => Math.min(i + 1, slashList.length - 1))
                        return
                      }
                      if (e.key === 'ArrowUp') {
                        e.preventDefault()
                        setSlashIdx((i) => Math.max(i - 1, 0))
                        return
                      }
                      if (e.key === 'Tab' || (e.key === 'Enter' && !e.metaKey && !e.ctrlKey)) {
                        e.preventDefault()
                        pickSkill(slashList[slashIdx]?.name ?? slashList[0].name)
                        return
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        setSlashDismissed(true)
                        return
                      }
                    }
                    if (e.key === 'Escape' && canStop) {
                      e.preventDefault()
                      void stopActive()
                      return
                    }
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault()
                      void sendDraft()
                    }
                  }}
                  placeholder={
                    canStop
                      ? '正在运行 · Esc 或 ⏹ 停止；输入消息可继续排队发送…'
                      : canCompose
                        ? '输入消息，/ 调用 Skill，⌘↵ 发送…'
                        : '只读回放 · 模型就绪后自动转续聊'
                  }
                  disabled={!canCompose}
                />
                <div className="cbar">
                  {active.model && <ModelChip model={active.model} />}
                  {(isLive || active.resumeFrom) && active.uiMode && (
                    <select
                      value={active.uiMode}
                      onChange={(e) =>
                        active.resumeFrom
                          ? setActive({ ...active, uiMode: e.target.value as UiPermissionMode })
                          : switchMode(e.target.value as UiPermissionMode)
                      }
                      className="chip-sel"
                    >
                      {(Object.keys(MODE_LABEL) as UiPermissionMode[]).map((m) => (
                        <option key={m} value={m}>
                          {MODE_LABEL[m]}
                        </option>
                      ))}
                    </select>
                  )}
                  <span className="sp" />
                  {canStop && (
                    <button className="send stop" disabled={stopping} onClick={() => void stopActive()}>
                      {stopping ? '⏹ 停止中…' : '⏹ 停止'}
                    </button>
                  )}
                  <button
                    className="send"
                    onClick={() => void sendDraft()}
                    disabled={!canCompose || (!draft.trim() && atts.length === 0)}
                  >
                    ⏎ 发送
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </main>

      {active && !panel.railHide && (
        <div
          className="col-rsz"
          title="拖动调宽 · 双击隐藏"
          onMouseDown={(e) => startPanelDrag('rail', e)}
          onDoubleClick={() => setPanel((p) => ({ ...p, railHide: true }))}
        />
      )}
      {active && !panel.railHide && (
        <aside className="rail" style={{ width: panel.railW }}>
          <div className="sec">
            <div className="sec-h" onClick={() => toggleRail('ctx')}>
              <span className="sec-cv">{railOpen.ctx ? '▾' : '▸'}</span>上下文
            </div>
            {railOpen.ctx && (
              <>
                <div className="rl">
                  <span className={ctx?.globalClaudeMd ? 'ok-t' : 'off-t'}>
                    {ctx?.globalClaudeMd ? '✓' : '—'}
                  </span>
                  全局 <code>~/.claude/CLAUDE.md</code>
                </div>
                <div className="rl">
                  <span className={ctx?.projectClaudeMd ? 'ok-t' : 'off-t'}>
                    {ctx?.projectClaudeMd ? '✓' : '—'}
                  </span>
                  项目 <code>./CLAUDE.md</code>
                </div>
                <div className="rl">
                  <span className={ctx?.decisionsMd ? 'ok-t' : 'off-t'}>
                    {ctx?.decisionsMd ? '✓' : '—'}
                  </span>
                  <code>DECISIONS.md</code>
                </div>
              </>
            )}
          </div>

          <div className="sec">
            <div className="sec-h" onClick={() => toggleRail('mem')}>
              <span className="sec-cv">{railOpen.mem ? '▾' : '▸'}</span>目录记忆
              <span className="sec-cnt">{ctx?.memoryCount ?? 0}</span>
              <span
                className="sec-hint"
                onClick={(e) => {
                  e.stopPropagation()
                  setScreen('memory')
                }}
              >
                打开记忆库 →
              </span>
            </div>
            {railOpen.mem && (
              <>
                {railMemories.slice(0, 3).map((m) => (
                  <div key={m.file} className="rmem" title={`${m.type} · ${m.description}`}>
                    <span className={`rm-dot ${m.type}`} />
                    <span className="rm-name">{m.name}</span>
                    <span className="rm-desc">{m.description}</span>
                  </div>
                ))}
                {railMemories.length > 3 && (
                  <div className="more-link" onClick={() => setScreen('memory')}>
                    全部 {railMemories.length} 条 →
                  </div>
                )}
              </>
            )}
          </div>

          {skillOptions.length > 0 && (
            <div className="sec">
              <div className="sec-h" onClick={() => toggleRail('skills')}>
                <span className="sec-cv">{railOpen.skills ? '▾' : '▸'}</span>Skills
                <span className="sec-cnt">{skillOptions.length}</span>
                <span className="sec-hint">输入 / 调用</span>
              </div>
              {railOpen.skills && (
                <>
                  {(skillsAll ? skillOptions : skillOptions.slice(0, 4)).map((s) => (
                    <div key={s.name} className="skrow" title={s.description}>
                      <code>/{s.name}</code>
                      {s.description && <span className="skdesc">{s.description}</span>}
                    </div>
                  ))}
                  {skillOptions.length > 4 && (
                    <div className="more-link" onClick={() => setSkillsAll((v) => !v)}>
                      {skillsAll ? '收起 ↑' : `全部 ${skillOptions.length} 个 →`}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {changedByFile.size > 0 && (
            <div className="sec">
              <div className="sec-h" onClick={() => toggleRail('changes')}>
                <span className="sec-cv">{railOpen.changes ? '▾' : '▸'}</span>本轮改动
                <span className="sec-cnt">{changedByFile.size}</span>
              </div>
              {railOpen.changes &&
                [...changedByFile.entries()].map(([file, diffs]) => {
                  const fkey = `rf-${file}`
                  const fopen = openBatches.has(fkey)
                  const addN = diffs.reduce((a, d) => a + d.addN, 0)
                  const delN = diffs.reduce((a, d) => a + d.delN, 0)
                  return (
                    <div key={file}>
                      <div className="frow" onClick={() => toggleBatch(fkey)} title={file}>
                        <span className="sec-cv">{fopen ? '▾' : '▸'}</span>
                        <span className="fbadge">
                          {diffs.some((d) => d.badge === 'EDIT') ? 'M' : 'W'}
                        </span>
                        <code className="fname">{file.split('/').pop()}</code>
                        <span className="fsum">
                          <em className="p">+{addN}</em>
                          {delN > 0 && <em className="m">−{delN}</em>}
                        </span>
                      </div>
                      {fopen &&
                        diffs.map((d, i) => (
                          <pre className="rail-diff" key={i}>
                            {d.del.map((l, j) => (
                              <span key={`d${j}`} className="del">
                                - {l}
                              </span>
                            ))}
                            {d.add.map((l, j) => (
                              <span key={`a${j}`} className="add">
                                + {l}
                              </span>
                            ))}
                          </pre>
                        ))}
                    </div>
                  )
                })}
            </div>
          )}

          {sessTasks.length > 0 && (
            <div className="sec">
              <div className="sec-h" onClick={() => toggleRail('tasks')}>
                <span className="sec-cv">{railOpen.tasks ? '▾' : '▸'}</span>待办
                <span className="sec-cnt">
                  {sessTasks.filter((t) => t.status === 'completed').length}/{sessTasks.length}
                </span>
              </div>
              {railOpen.tasks &&
                sessTasks.map((t) => (
                  <div key={t.id} className={`todo-row ${t.status}`} title={t.subject}>
                    <span className="td-ic">
                      {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : '○'}
                    </span>
                    <span className="td-t">
                      {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.subject}
                    </span>
                  </div>
                ))}
            </div>
          )}

          {subagentItems.length > 0 && (
            <div className="sec">
              <div className="sec-h" onClick={() => toggleRail('agents')}>
                <span className="sec-cv">{railOpen.agents ? '▾' : '▸'}</span>子 Agent
                <span className="sec-cnt">{subagentItems.length}</span>
              </div>
              {railOpen.agents &&
                subagentItems.map((it) => {
                  const key = `rsub-${it.id}`
                  const open = openBatches.has(key)
                  const steps = it.sub ?? []
                  return (
                    <div key={it.id}>
                      <div className="frow" onClick={() => toggleBatch(key)} title={it.subDesc ?? it.toolInput}>
                        <span className="sec-cv">{open ? '▾' : '▸'}</span>
                        <span className={`sa-dot${it.tres ? ' done' : ''}`}>{it.tres ? '✓' : '●'}</span>
                        <span className="fname">{it.subDesc ?? it.toolInput ?? '子任务'}</span>
                        <span className="sec-cnt">{steps.length} 步</span>
                      </div>
                      {open && steps.length > 0 && (
                        <div className="rsub-steps">
                          {steps.slice(-12).map((s, i) => (
                            <div key={i} className="rsub-step">
                              {s}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
            </div>
          )}

          <div className="sec">
            <div className="sec-h" onClick={() => toggleRail('sess')}>
              <span className="sec-cv">{railOpen.sess ? '▾' : '▸'}</span>会话
            </div>
            {railOpen.sess && (
              <div className="sess-meta">
                {active.sessionId && (
                  <div className="sm-row">
                    <code>{active.sessionId.slice(0, 18)}…</code>
                  </div>
                )}
                {transcript && active.sessionId && (
                  <div
                    className="sm-row sm-link"
                    title={`${transcript}\n点击在访达中显示`}
                    onClick={() =>
                      void window.letscoding.sessionInfo.revealTranscript(
                        active.sessionId as string,
                        active.cwd
                      )
                    }
                  >
                    <span className="sm-lab">记录</span>
                    <code className="sm-path">{transcript.split('/').pop()}</code>
                  </div>
                )}
                <div className="sm-row">
                  {active.model && <ModelChip model={active.model} />}
                  {active.uiMode && <span className="chip">{MODE_LABEL[active.uiMode]}</span>}
                </div>
                {usage && usage.ctxTok > 0 && (
                  <div
                    className="sm-row"
                    title={`上下文占用 ${fmtTokens(usage.ctxTok)} / ${fmtTokens(CTX_WINDOW)} tokens（按上轮真实用量）`}
                  >
                    上下文
                    <div className="tok-bar">
                      <i style={{ width: `${Math.min(100, Math.round((usage.ctxTok / CTX_WINDOW) * 100))}%` }} />
                    </div>
                    <span className="tok-pct">
                      {Math.min(100, Math.round((usage.ctxTok / CTX_WINDOW) * 100))}%
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>
      )}

      {showCustomize && (
        <div className="overlay" onClick={() => setShowCustomize(false)}>
          <div className="modal cust-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-h">
              <h3>自定义</h3>
              <button className="mini" onClick={() => setShowCustomize(false)}>
                ✕
              </button>
            </div>
            <div className="cust-body">
              <nav className="cust-nav">
                {(
                  [
                    ['skills', 'Skills', customize?.skills.length],
                    [
                      'connectors',
                      '连接器',
                      connectors
                        ? (connectors.gh.authed ? 1 : 0) + (connectors.glab.authed ? 1 : 0)
                        : undefined
                    ],
                    ['plugins', '插件', customize?.plugins.length]
                  ] as const
                ).map(([k, label, n]) => (
                  <div
                    key={k}
                    className={`cn-item${custTab === k ? ' on' : ''}`}
                    onClick={() => setCustTab(k)}
                  >
                    {label}
                    {n !== undefined && <span className="cn-cnt">{n}</span>}
                  </div>
                ))}
              </nav>
              <div className="cust-content">
                {!customize && <div className="cust-empty">加载中…</div>}
                {customize && custTab === 'skills' && (
                  <>
                    {customize.skills.length === 0 && (
                      <div className="cust-empty">
                        暂无技能 · 放入 ~/.claude/skills/&lt;名字&gt;/SKILL.md 即可被识别
                      </div>
                    )}
                    {customize.skills.map((s) => (
                      <div key={`${s.scope}-${s.name}`} className="cust-row">
                        <div className="cr-main">
                          <code>/{s.name}</code>
                          <span className={`ttag ${s.scope === 'project' ? 'project' : 'user'}`}>
                            {s.scope === 'project' ? '项目' : '全局'}
                          </span>
                          <span className="cr-desc">{s.description}</span>
                        </div>
                        <button
                          className="mini acc"
                          disabled={!canCompose}
                          title={canCompose ? `把 /${s.name} 填入输入框` : '先打开一个可续聊的会话'}
                          onClick={() => applySkill(s.name)}
                        >
                          使用
                        </button>
                      </div>
                    ))}
                  </>
                )}
                {custTab === 'connectors' && !connectors && (
                  <div className="cust-empty">正在检测 gh / glab 登录状态…</div>
                )}
                {custTab === 'connectors' && connectors && (
                  <>
                    {(
                      [
                        ['gh', 'GitHub', 'https://github.com', 'https://cli.github.com', connectors.gh, 'PR / Issue / 仓库'],
                        ['glab', 'GitLab', 'https://gitlab.com', 'https://gitlab.com/gitlab-org/cli#installation', connectors.glab, 'MR / Issue / 仓库']
                      ] as const
                    ).map(([tool, label, home, installUrl, st, caps]) => (
                      <div key={tool} className="cust-row">
                        <div className="cr-main">
                          <span className="cr-name">{label}</span>
                          {st.authed ? (
                            <span className="cr-ok">✓ 已连接 {st.account}</span>
                          ) : (
                            <span className="cr-off">{st.installed ? '未登录' : `未安装 ${tool} CLI`}</span>
                          )}
                          <span className="cr-desc">
                            {tool} CLI · {caps}操作走本机凭证
                          </span>
                        </div>
                        {st.installed && !st.authed && (
                          <button
                            className="mini acc"
                            title={`打开系统终端运行 ${tool} auth login`}
                            onClick={() => void window.letscoding.customize.bind(tool)}
                          >
                            绑定…
                          </button>
                        )}
                        {!st.installed && (
                          <button
                            className="mini"
                            onClick={() => void window.letscoding.shell.openUrl(installUrl)}
                          >
                            安装指引 ↗
                          </button>
                        )}
                        <button
                          className="mini"
                          onClick={() => void window.letscoding.shell.openUrl(home)}
                        >
                          打开 {label} ↗
                        </button>
                      </div>
                    ))}
                    <div className="cust-hint">
                      「绑定…」会打开系统终端跑 auth login（首次需允许控制 Terminal）；完成后
                      <button className="mini" style={{ marginLeft: 6 }} onClick={refreshConnectors}>
                        重新检测
                      </button>
                    </div>
                  </>
                )}
                {customize && custTab === 'plugins' && (
                  <>
                    {customize.plugins.length === 0 && (
                      <div className="cust-empty">暂无插件 · Claude Code 里 /plugin 安装后这里可见</div>
                    )}
                    {customize.plugins.map((p) => (
                      <div key={`${p.marketplace}-${p.name}`} className="cust-row">
                        <div className="cr-main">
                          <span className="cr-name">{p.name}</span>
                          <span className="chip mono">v{p.version}</span>
                          {p.skillCount > 0 && <span className="chip">{p.skillCount} skills</span>}
                          <span className="cr-desc">{p.description || p.marketplace}</span>
                        </div>
                        {p.repoUrl && (
                          <button
                            className="mini"
                            title={p.repoUrl}
                            onClick={() => void window.letscoding.shell.openUrl(p.repoUrl as string)}
                          >
                            仓库 ↗
                          </button>
                        )}
                      </div>
                    ))}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {textPrompt && (
        <div className="overlay" onClick={() => setTextPrompt(null)}>
          <div className="modal" style={{ width: 380 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-h">
              <h3>{textPrompt.title}</h3>
            </div>
            <div className="modal-b">
              <input
                ref={promptInputRef}
                className="edit-input"
                autoFocus
                defaultValue={textPrompt.initial}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitTextPrompt()
                  if (e.key === 'Escape') setTextPrompt(null)
                }}
              />
            </div>
            <div className="modal-f">
              <button className="mini" onClick={() => setTextPrompt(null)}>
                取消
              </button>
              <button className="mini acc" onClick={submitTextPrompt}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}
      {diffPanel && (
        <div className="overlay" onClick={() => setDiffPanel(null)}>
          <div className="modal" style={{ width: 780 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-h">
              <h3>
                工作区改动
                {typeof diffPanel === 'object' && diffPanel.branch ? ` · ⎇ ${diffPanel.branch}` : ''}
              </h3>
              <p>
                <code>{active?.cwd}</code>
              </p>
            </div>
            <div className="modal-b">
              {diffPanel === 'loading' ? (
                <div style={{ fontSize: 12.5, color: 'var(--dim)' }}>读取中…</div>
              ) : !diffPanel.isRepo ? (
                <div style={{ fontSize: 12.5, color: 'var(--dim)' }}>该目录不是 git 仓库</div>
              ) : (
                <>
                  {diffPanel.stat && (
                    <pre className="gitdiff-body" style={{ maxHeight: '16vh' }}>
                      {diffPanel.stat}
                    </pre>
                  )}
                  {diffPanel.untracked.length > 0 && (
                    <div style={{ fontSize: 12, color: 'var(--mut)' }}>
                      未跟踪文件：{diffPanel.untracked.join('、')}
                    </div>
                  )}
                  {diffPanel.diffText.trim() ? (
                    <div className="gitdiff-body">
                      {diffPanel.diffText.split('\n').slice(0, 4000).map((l, i) => (
                        <div
                          key={i}
                          className={
                            l.startsWith('diff --git') || l.startsWith('+++') || l.startsWith('---')
                              ? 'dl-file'
                              : l.startsWith('+')
                                ? 'dl-add'
                                : l.startsWith('-')
                                  ? 'dl-del'
                                  : l.startsWith('@@')
                                    ? 'dl-hunk'
                                    : ''
                          }
                        >
                          {l || ' '}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: 12.5, color: 'var(--dim)' }}>工作区干净，无未提交改动</div>
                  )}
                </>
              )}
            </div>
            <div className="modal-f">
              <button className="mini" onClick={() => void openDiffPanel()}>
                刷新
              </button>
              <button className="mini" onClick={() => setDiffPanel(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
      {showSwitcher && (
        <QuickSwitcher sessions={sessions} onPick={(s) => void openSession(s)} onClose={() => setShowSwitcher(false)} />
      )}
      {showNew && (
        <NewSessionModal
          models={enabledModels}
          defaultModel={defaultModel}
          defaultCwd={active?.cwd || ''}
          recentCwds={recentCwds}
          onCancel={() => setShowNew(false)}
          onCreate={onCreate}
        />
      )}
    </div>
  )
}
