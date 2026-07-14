import { useEffect, useMemo, useState } from 'react'
import type { GroupDto, SessionListEntry } from '../../shared/ipc'
import ModeTabs, { type ModeKey } from './ModeTabs'
import { modelMeta, relTime } from './ui'

interface FootStats {
  memoryCount: number
  pendingCount: number
  spendText: string | null
}

interface Props {
  sessions: SessionListEntry[]
  groups: GroupDto[]
  activeSessionId?: string
  onOpen: (s: SessionListEntry) => void
  onNew: () => void
  onSearch: () => void
  onNavigate: (screen: 'memory' | 'settings') => void
  /** 模式切换（TaskWork / Design 整页） */
  onModeSwitch: (mode: 'taskwork' | 'design') => void
  connected: boolean
  stats: FootStats
  /** 正在等待权限确认的 live handle（会话行显示琥珀 wait 点） */
  permHandle: string | null
  /** 等权限的会话所属模式（对应 mode tab 亮红点） */
  permMode: ModeKey | null
  /** 后台完成未读的 live handles（卡片未读点） */
  unreadHandles: string[]
  // 会话/分组管理
  onPin: (s: SessionListEntry, pinned: boolean) => void
  onMove: (s: SessionListEntry, group: string | null) => void
  onRename: (s: SessionListEntry) => void
  onDelete: (s: SessionListEntry) => void
  onCreateGroup: () => void
  onRenameGroup: (name: string) => void
  onDeleteGroup: (name: string) => void
  onCollapseGroup: (name: string, collapsed: boolean) => void
  /** 卡片拖拽投放：拖到置顶区/某分组/未分组 */
  onDropSession: (sessionId: string, target: { pinned?: boolean; group?: string | null }) => void
  /** 面板拖宽（App 统一管理，未传用 CSS 默认宽） */
  width?: number
  /** 「自定义」弹窗（Skills/连接器/插件） */
  onCustomize: () => void
}

interface MenuState {
  s: SessionListEntry
  x: number
  y: number
}

export default function Sidebar(props: Props): React.JSX.Element {
  const { sessions, groups, stats } = props
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [moveOpen, setMoveOpen] = useState(false)
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false)
  // 卡片拖拽：正在拖的会话 id + 悬停中的投放区 key
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropKey, setDropKey] = useState<string | null>(null)

  function zoneProps(key: string, target: { pinned?: boolean; group?: string | null }): {
    className: string
    onDragOver: (e: React.DragEvent) => void
    onDragLeave: () => void
    onDrop: (e: React.DragEvent) => void
  } {
    return {
      className: `drop-zone${dropKey === key ? ' over' : ''}`,
      onDragOver: (e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDropKey(key)
      },
      onDragLeave: () => setDropKey((k) => (k === key ? null : k)),
      onDrop: (e) => {
        e.preventDefault()
        const id = e.dataTransfer.getData('text/lc-session')
        setDropKey(null)
        setDragId(null)
        if (id) props.onDropSession(id, target)
      }
    }
  }

  const groupNames = useMemo(() => groups.map((g) => g.name), [groups])

  // 分区：置顶 / 各命名分组 / 未分组
  const { pinned, byGroup, ungrouped } = useMemo(() => {
    const pinned: SessionListEntry[] = []
    const byGroup = new Map<string, SessionListEntry[]>()
    const ungrouped: SessionListEntry[] = []
    for (const g of groupNames) byGroup.set(g, [])
    for (const s of sessions) {
      if (s.archived) continue
      if (s.pinned) pinned.push(s)
      else if (s.groupName && byGroup.has(s.groupName)) byGroup.get(s.groupName)!.push(s)
      else ungrouped.push(s)
    }
    const sortT = (a: SessionListEntry, b: SessionListEntry): number => b.lastModified - a.lastModified
    pinned.sort(sortT)
    ungrouped.sort(sortT)
    for (const list of byGroup.values()) list.sort(sortT)
    return { pinned, byGroup, ungrouped }
  }, [sessions, groupNames])

  // 未分组区按工作目录自动分组（目录名为组名，组间按最近活跃排序）；手动分组/置顶优先
  const autoGroups = useMemo(() => {
    const m = new Map<string, { cwd: string; list: SessionListEntry[] }>()
    for (const s of ungrouped) {
      const cwd = s.cwd ?? ''
      const key = cwd ? (cwd.split('/').filter(Boolean).pop() ?? cwd) : '其他'
      const g = m.get(key) ?? { cwd, list: [] }
      g.list.push(s)
      m.set(key, g)
    }
    return [...m.entries()].sort((a, b) => b[1].list[0].lastModified - a[1].list[0].lastModified)
  }, [ungrouped])
  // M21c：目录组默认折叠（记「已展开」集合，初始为空）——上百条未分组会话不再进来就摊开；
  // 活跃会话所在组自动展开（选中项可见），之后仍可手动收起
  const [autoOpen, setAutoOpen] = useState<Set<string>>(new Set())
  function toggleAuto(key: string): void {
    setAutoOpen((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const activeAutoKey = useMemo(() => {
    const s = ungrouped.find((x) => x.sessionId === props.activeSessionId)
    if (!s) return null
    const cwd = s.cwd ?? ''
    return cwd ? (cwd.split('/').filter(Boolean).pop() ?? cwd) : '其他'
  }, [ungrouped, props.activeSessionId])
  useEffect(() => {
    if (activeAutoKey) setAutoOpen((prev) => (prev.has(activeAutoKey) ? prev : new Set(prev).add(activeAutoKey)))
  }, [activeAutoKey])

  function openMenu(e: React.MouseEvent, s: SessionListEntry): void {
    e.preventDefault()
    e.stopPropagation()
    setMoveOpen(false)
    setMenu({ s, x: e.clientX, y: e.clientY })
  }

  function Row({ s }: { s: SessionListEntry }): React.JSX.Element {
    const waiting = s.live && props.permHandle === s.live.handle
    const meta = s.live ? modelMeta(s.live.model) : null
    return (
      <div
        className={`sess${props.activeSessionId === s.sessionId ? ' on' : ''}${dragId === s.sessionId ? ' dragging' : ''}`}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('text/lc-session', s.sessionId)
          e.dataTransfer.effectAllowed = 'move'
          setDragId(s.sessionId)
        }}
        onDragEnd={() => {
          setDragId(null)
          setDropKey(null)
        }}
        onClick={() => props.onOpen(s)}
        onContextMenu={(e) => openMenu(e, s)}
      >
        <span className={`st ${s.live ? (waiting ? 'wait' : 'run') : 'idle'}`} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="sess-t">{s.customTitle ?? s.summary}</div>
          <div className="sess-m">
            {meta && (
              <>
                <span className={`pdot ${meta.dot}`} />
                <span className="mn">{meta.label}</span>
              </>
            )}
            <span>
              {meta ? '· ' : ''}
              {waiting ? '待确认' : s.live ? '运行中' : relTime(s.lastModified)}
            </span>
          </div>
        </div>
        {s.live && props.unreadHandles.includes(s.live.handle) && <span className="udot" title="有新完成的回答" />}
        <span className="sess-more" onClick={(e) => openMenu(e, s)} title="更多">
          ⋯
        </span>
      </div>
    )
  }

  function GroupHead({
    name,
    count,
    collapsed,
    onToggle,
    actions
  }: {
    name: string
    count: number
    collapsed?: boolean
    onToggle?: () => void
    actions?: React.ReactNode
  }): React.JSX.Element {
    return (
      <div className="grp">
        {onToggle ? (
          <span className="cv" onClick={onToggle}>
            {collapsed ? '▸' : '▾'}
          </span>
        ) : (
          <span className="cv" />
        )}
        <span className="gname" onClick={onToggle}>
          {name}
        </span>
        {actions}
        <span className="cnt">{count}</span>
      </div>
    )
  }

  return (
    <aside className="side" style={props.width ? { width: props.width } : undefined}>
      <div className="side-top">
        <div className="brand">
          <i />
          LetsCoding
        </div>
        <ModeTabs active="work" alert={props.permMode} onSwitch={(k) => k !== 'work' && props.onModeSwitch(k)} />
        <div className="side-acts">
          <button className="side-act sa-new" onClick={props.onNew}>
            <span className="sa-ic">＋</span>新建会话
          </button>
          <button className="side-act sa-cust" onClick={props.onCustomize} title="Skills · 连接器 · 插件">
            <span className="sa-ic">◇</span>自定义
          </button>
        </div>
        <div className="search" onClick={props.onSearch}>
          ⌕ 搜索会话与记忆…
          <span style={{ marginLeft: 'auto' }} className="mono">
            ⌘K
          </span>
        </div>
      </div>

      <div className="side-scroll">
        {(pinned.length > 0 || dragId !== null) && (
          <div {...zoneProps('pinned', { pinned: true })}>
            <GroupHead
              name="置顶"
              count={pinned.length}
              collapsed={pinnedCollapsed}
              onToggle={() => setPinnedCollapsed((v) => !v)}
            />
            {!pinnedCollapsed && pinned.map((s) => <Row key={s.sessionId} s={s} />)}
          </div>
        )}

        {groups.map((g) => {
          const list = byGroup.get(g.name) ?? []
          return (
            <div key={g.name} {...zoneProps(`g:${g.name}`, { group: g.name })}>
              <GroupHead
                name={g.name}
                count={list.length}
                collapsed={g.collapsed}
                onToggle={() => props.onCollapseGroup(g.name, !g.collapsed)}
                actions={
                  <>
                    <span className="grp-act" onClick={() => props.onRenameGroup(g.name)} title="重命名分组">
                      ✎
                    </span>
                    <span className="grp-act" onClick={() => props.onDeleteGroup(g.name)} title="删除分组">
                      ✕
                    </span>
                  </>
                }
              />
              {!g.collapsed && list.map((s) => <Row key={s.sessionId} s={s} />)}
            </div>
          )
        })}

        <div {...zoneProps('ungrouped', { group: null })}>
          <GroupHead
            name="未分组 · 按目录"
            count={ungrouped.length}
            actions={
              <span className="grp-act" onClick={props.onCreateGroup} title="新建分组">
                ＋
              </span>
            }
          />
          {autoGroups.map(([key, g]) => (
            <div key={key} className="auto-grp">
              <div className="auto-head" title={g.cwd || '无工作目录'} onClick={() => toggleAuto(key)}>
                <span className="ag-cv">{autoOpen.has(key) ? '▾' : '▸'}</span>
                <span className="ag-name">{key}</span>
                <span className="cnt">{g.list.length}</span>
              </div>
              {autoOpen.has(key) && g.list.map((s) => <Row key={s.sessionId} s={s} />)}
            </div>
          ))}
        </div>
        {sessions.length === 0 && (
          <div style={{ padding: 14, fontSize: 12.5, color: 'var(--dim)' }}>暂无会话</div>
        )}
      </div>

      <div className="side-foot">
        <button className="foot-row" onClick={() => props.onNavigate('memory')}>
          ◈ 记忆库
          <span className="k">
            {stats.memoryCount} 条{stats.pendingCount > 0 ? ` · ${stats.pendingCount} 待确认` : ''}
          </span>
        </button>
        <button className="foot-row" onClick={() => props.onNavigate('settings')}>
          <span className="conn" style={{ background: props.connected ? 'var(--ok)' : 'var(--idle)' }} />
          {props.connected ? 'LiteLLM 已连接' : 'LiteLLM 未连接'}
          <span className="k">设置</span>
        </button>
        <button className="foot-row" onClick={() => props.onNavigate('settings')}>
          $ 累计用量
          <span className="k">{stats.spendText ?? '—'}</span>
        </button>
      </div>

      {menu && (
        <>
          <div className="menu-scrim" onClick={() => setMenu(null)} onContextMenu={() => setMenu(null)} />
          <div className="ctx-menu" style={{ left: Math.min(menu.x, window.innerWidth - 180), top: menu.y }}>
            <div className="ctx-item" onClick={() => { props.onPin(menu.s, !menu.s.pinned); setMenu(null) }}>
              {menu.s.pinned ? '取消置顶' : '置顶'}
            </div>
            <div className="ctx-item" onClick={() => setMoveOpen((v) => !v)}>
              移动到分组 ▸
            </div>
            {moveOpen && (
              <div className="ctx-sub">
                <div className="ctx-item" onClick={() => { props.onMove(menu.s, null); setMenu(null) }}>
                  未分组
                </div>
                {groupNames.map((g) => (
                  <div key={g} className="ctx-item" onClick={() => { props.onMove(menu.s, g); setMenu(null) }}>
                    {g}
                  </div>
                ))}
                <div className="ctx-item ctx-dim" onClick={() => { props.onCreateGroup(); setMenu(null) }}>
                  ＋ 新建分组…
                </div>
              </div>
            )}
            <div className="ctx-item" onClick={() => { props.onRename(menu.s); setMenu(null) }}>
              重命名
            </div>
            <div className="ctx-item ctx-danger" onClick={() => { props.onDelete(menu.s); setMenu(null) }}>
              删除
            </div>
          </div>
        </>
      )}
    </aside>
  )
}
