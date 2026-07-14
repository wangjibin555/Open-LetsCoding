import { useCallback, useEffect, useRef, useState } from 'react'
import { DESIGN_HANDLE_PREFIX, type DesignFileDto } from '../../shared/ipc'
import ChatFlow, { lastAssistantIdOf } from './ChatFlow'
import ModeTabs, { type ModeKey } from './ModeTabs'
import { replayToFlow } from './replay'
import { useSessionStream, type FlowItem } from './useStream'
import { relTime } from './ui'

// Design 模式（DECISIONS D11 / design/design-mode.html v2）：
// 三栏 = design/*.html 文件列表 ｜ sandbox iframe 预览（三档宽度）｜ 设计对话。
// 对话 = 真实会话（auto 档全工具，直接改稿）；按稿绑会话（settings.designSessions）；
// 改稿落盘 → mtime 轮询自动刷新预览。

interface Props {
  onBack: () => void
  onTaskWork: () => void
  /** 可切换的项目目录（active cwd 优先，其余按最近活跃去重）——设计稿按项目找 design/ */
  cwds: string[]
  /** 左列宽度跟随 Code 左栏 */
  width?: number
  /** 设计对话列宽度与隐藏态（M21b 可拖拽；隐藏 = 纯预览模式） */
  chatW: number
  chatHidden: boolean
  onDragSide: (e: React.MouseEvent) => void
  onDragChat: (e: React.MouseEvent) => void
  onChatHide: (hidden: boolean) => void
  /** 正在等待权限确认的 live handle（配合右下角全局权限卡给行内提示） */
  permHandle: string | null
  /** 等权限的会话所属模式（mode tab 红点） */
  permMode: ModeKey | null
}

const DESIGN_GROUP = '设计稿'

/** 历史回放上限：设计对话是轻量视图，只带最近这些条（完整历史仍在 Code 模式） */
const HISTORY_CAP = 80

/** 首条消息模板：钉住目标文件与风格约定（新会话才注入；resume 续聊已有上下文） */
function firstPromptFor(file: string | null, userText: string): string {
  const head = file
    ? `你在维护本项目 design/${file} 这份 HTML 设计稿。用户会持续提修改意见：直接编辑该文件实现，保持文件里既有的 :root 主题 token 与整体风格，改完用一两句话说明改了什么，不要贴大段代码。`
    : `你要在本项目 design/ 目录下产出一份自包含的 HTML 设计稿（内联全部样式，:root 定义主题 token，浅色基调）。写完用一两句话说明文件名和内容要点。`
  // 无人值守约束：设计对话只该读写设计稿文件；终端命令会触发权限弹窗（Design 屏不可见 → 悬挂）
  return `${head}\n只通过直接读写文件完成，不要执行任何终端命令。\n\n用户要求：${userText}`
}

export default function DesignPane(props: Props): React.JSX.Element {
  const [files, setFiles] = useState<DesignFileDto[]>([])
  const [sel, setSel] = useState<string | null>(null)
  const [cwd, setCwd] = useState<string | null>(null)
  const [html, setHtml] = useState<string | null>(null)
  const [mtime, setMtime] = useState<number | null>(null)
  const [fresh, setFresh] = useState(false)
  const [widthMode, setWidthMode] = useState<'full' | 768 | 390>('full')
  const [draft, setDraft] = useState('')
  const [handle, setHandle] = useState<string | null>(null)
  const [model, setModel] = useState<string | null>(null)
  /** 会话未建立时的提示（pushStatus 需要已存在的桶，建桶前用本地态） */
  const [note, setNote] = useState<string | null>(null)
  /** D12.4 既往对话回放（已绑会话的稿、无 live 对话时载入；live 桶只有新消息，不重复） */
  const [history, setHistory] = useState<FlowItem[]>([])
  /** designSessions 映射已从 settings 读完（避免启动竞态：首稿自动选中早于映射到位） */
  const [mapReady, setMapReady] = useState(false)
  const mapRef = useRef<Record<string, string>>({})

  const { items, running, pushUser, pushStatus, setRunning, seed } = useSessionStream(handle)
  const msgsRef = useRef<HTMLDivElement>(null)
  /** sel 变更判定用：上一个选中 + 当前会话的 session_id + 运行态（effect 里读最新值不进依赖） */
  const prevSelRef = useRef<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const runningRef = useRef(running)
  runningRef.current = running

  const mapKey = cwd && sel ? `${cwd}::${sel}` : null
  const mapKeyRef = useRef<string | null>(null)
  mapKeyRef.current = mapKey
  const handleRef = useRef<string | null>(null)
  handleRef.current = handle

  // D12.3：预览滚动位置按 `cwd::file` 记忆（会话内），srcDoc 重载后 onLoad 回发恢复
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const scrollMem = useRef<Record<string, number>>({})

  /** 回放 mapKey 绑定会话的 transcript 到对话列；无绑定/换稿在途则清空（seq 防迟到覆盖） */
  const histSeq = useRef(0)
  const loadHistoryFor = useCallback((key: string | null): void => {
    const seq = ++histSeq.current
    setHistory([])
    const sid = key ? mapRef.current[key] : undefined
    if (!sid) return
    window.letscoding.session
      .replay(sid)
      .then((msgs) => {
        if (histSeq.current !== seq) return
        const flow = replayToFlow(msgs).filter((it) => it.kind !== 'memory')
        setHistory(flow.slice(-HISTORY_CAP).map((it, i) => ({ ...it, id: `h${i}` })))
      })
      .catch(() => {}) /* transcript 被清理 → 无历史可回放，静默（resume 仍可续） */
  }, [])

  // 目录初始化：默认第一个（active cwd 优先）；用户切过则不覆盖
  useEffect(() => {
    setCwd((c) => c ?? props.cwds[0] ?? null)
  }, [props.cwds])

  function switchCwd(next: string): void {
    if (next === cwd) return
    setCwd(next)
    setSel(null)
    prevSelRef.current = null
    setFiles([])
    setHandle(null)
    sessionIdRef.current = null
    loadHistoryFor(null)
  }

  // 模型与会话映射：挂载读一次（保存映射时回写 settings）
  useEffect(() => {
    window.letscoding.settings
      .get()
      .then((st) => {
        if (st.designSessions) {
          try {
            mapRef.current = JSON.parse(st.designSessions) as Record<string, string>
          } catch {
            mapRef.current = {}
          }
        }
        if (st.defaultModel) setModel(st.defaultModel)
      })
      .catch(() => {})
      .finally(() => setMapReady(true))
    window.letscoding.models
      .list()
      .then((ms) => {
        const enabled = ms.filter((m) => m.enabled).map((m) => m.id)
        setModel((cur) => (cur && enabled.includes(cur) ? cur : (enabled[0] ?? cur)))
      })
      .catch(() => {})
  }, [])

  const loadFiles = useCallback(async (): Promise<void> => {
    if (!cwd) return
    try {
      setFiles(await window.letscoding.design.list(cwd))
    } catch {
      /* 下轮轮询重试 */
    }
  }, [cwd])

  const loadHtml = useCallback(
    async (silent: boolean): Promise<void> => {
      if (!cwd || !sel) return
      try {
        const r = await window.letscoding.design.read(cwd, sel)
        setHtml(r.html)
        setMtime((prev) => {
          if (silent && prev !== null && r.mtime !== null && r.mtime !== prev) {
            setFresh(true)
            setTimeout(() => setFresh(false), 4000)
          }
          return r.mtime
        })
      } catch {
        /* 下轮轮询重试 */
      }
    },
    [cwd, sel]
  )

  // 文件列表：挂载 + 4s 轮询（会话新建稿时自动出现）
  useEffect(() => {
    void loadFiles()
    const t = setInterval(() => void loadFiles(), 4000)
    return () => clearInterval(t)
  }, [loadFiles])

  // 默认选中最新一份
  useEffect(() => {
    if (sel === null && files.length > 0) setSel(files[0].file)
  }, [files, sel])

  // 选中变化：读稿 + 绑定该稿的对话。两种情况保留当前对话不清空：
  // (a) 首稿自动选中（对话刚出的新稿，prev 为 null）——顺手把会话映射补到新稿名下；
  // (b) 对话运行中（改稿进行时切走会话会失联）。其余 = 用户主动切稿 → 切上下文。
  useEffect(() => {
    const prev = prevSelRef.current
    prevSelRef.current = sel
    keyChangedAt.current = Date.now()
    setHtml(null)
    setMtime(null)
    const keepChat = handle !== null && (prev === null || runningRef.current)
    if (!keepChat) {
      setHandle(null)
      sessionIdRef.current = null
      // D12.4：切到别的稿（无 live 对话保留）→ 回放新稿绑定会话的既往对话
      loadHistoryFor(mapKey)
    } else if (mapKey && sessionIdRef.current && !mapRef.current[mapKey]) {
      mapRef.current[mapKey] = sessionIdRef.current
      window.letscoding.settings.set({ designSessions: JSON.stringify(mapRef.current) }).catch(() => {})
    }
    void loadHtml(false)
    // 仅 sel/cwd 变化时执行；handle/running 经 ref 读最新值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, cwd])

  // 启动竞态兜底：首稿自动选中可能早于 designSessions 读完 → 映射到位后补载一次历史
  useEffect(() => {
    if (mapReady && handleRef.current === null) loadHistoryFor(mapKeyRef.current)
  }, [mapReady, loadHistoryFor])

  // D12.3：接收 sandbox 预览的滚动上报（来源校验：只认当前 iframe），按 cwd::file 记忆。
  // keyChangedAt：切稿后的短窗内丢弃上报——旧文档 120ms 节流的迟到消息会串到新稿 key 下
  const keyChangedAt = useRef(0)
  useEffect(() => {
    const onMsg = (e: MessageEvent): void => {
      if (e.source !== iframeRef.current?.contentWindow) return
      const d = e.data as { t?: string; y?: unknown }
      if (d?.t !== 'dz-scroll') return
      if (Date.now() - keyChangedAt.current < 300) return
      const y = Math.max(0, Number(d.y) || 0)
      if (mapKeyRef.current) scrollMem.current[mapKeyRef.current] = y
      // 滚动记忆同步到 DOM data 属性：探针可读（D12.3 目的断言），不进 window 全局
      const canvas = document.querySelector('.dz-canvas') as HTMLElement | null
      if (canvas) canvas.dataset['scrollY'] = String(Math.round(y))
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // 预览自动刷新：会话运行中 2s、空闲 6s 轮询 mtime
  useEffect(() => {
    if (!sel) return
    const t = setInterval(() => void loadHtml(true), running ? 2000 : 6000)
    return () => clearInterval(t)
  }, [sel, running, loadHtml])

  // 新消息/历史载入滚到底
  useEffect(() => {
    const el = msgsRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items, history])

  // 捕获设计会话的 init：存映射（按稿绑会话）+ 归「设计稿」分组
  useEffect(() => {
    if (!handle) return
    const unsub = window.letscoding.session.onStream((e) => {
      if (e.handle !== handle) return
      const m = e.msg as { type?: string; subtype?: string; session_id?: string }
      if (m.type === 'system' && m.subtype === 'init' && m.session_id) {
        sessionIdRef.current = m.session_id
        if (mapKey) {
          mapRef.current[mapKey] = m.session_id
          window.letscoding.settings
            .set({ designSessions: JSON.stringify(mapRef.current) })
            .catch(() => {})
        }
        window.letscoding.groups.create(DESIGN_GROUP).catch(() => {})
        window.letscoding.session
          .setMeta({ sessionId: m.session_id, group_name: DESIGN_GROUP })
          .catch(() => {})
      }
    })
    return unsub
  }, [handle, mapKey])

  async function send(): Promise<void> {
    const text = draft.trim()
    if (!text || running) return
    if (!cwd) {
      setNote('先在 Code 模式打开一个会话（确定项目目录）再用设计对话')
      return
    }
    if (!model) {
      setNote('模型清单未就绪，稍候再试')
      return
    }
    setNote(null)
    setDraft('')
    if (handle) {
      // 本次 Design 停留期间已有会话：直接续
      pushUser(text)
      setRunning(handle, true)
      try {
        await window.letscoding.session.send(handle, text)
      } catch (err) {
        setRunning(handle, false)
        pushStatus(`发送失败：${String(err).slice(0, 120)}`)
      }
      return
    }
    // 新会话：seed/setRunning 显式带 handle（同 App onCreate 模式），不依赖 active 桶切换时序
    const h = `${DESIGN_HANDLE_PREFIX}${Date.now()}`
    const resume = mapKey ? mapRef.current[mapKey] : undefined
    setHandle(h)
    seed(h, [
      // 历史已可见时不再重复提示；仅回放失败（transcript 缺失）而 resume 仍可续时保留说明
      ...(resume && history.length === 0
        ? [{ id: 's0', kind: 'status' as const, status: '已续上这份稿的既有对话（完整历史在 Code 模式可看）' }]
        : []),
      { id: 'u0', kind: 'user' as const, text }
    ])
    setRunning(h, true)
    try {
      await window.letscoding.session.create({
        handle: h,
        cwd,
        model,
        uiMode: 'auto',
        ...(resume ? { resume } : {}),
        firstPrompt: resume ? text : firstPromptFor(sel, text)
      })
    } catch (err) {
      setRunning(h, false)
      setHandle(null)
      setNote(`会话启动失败：${String(err).slice(0, 120)}`)
      setDraft(text)
    }
  }

  async function stop(): Promise<void> {
    if (!handle) return
    try {
      await window.letscoding.session.interrupt(handle)
    } catch {
      pushStatus('停止失败，会话可能已结束')
    }
  }

  // 消息渲染走共享 ChatFlow（M21 抽出）；memory 提议不在设计对话展示。
  // 打字机只动画运行中的最后一条 assistant（history 的 h* id 永不命中）
  const visible = items.filter((it) => it.kind !== 'memory')
  const lastAssistantId = lastAssistantIdOf(items)
  const followTail = (): void => {
    const el = msgsRef.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight
  }

  return (
    <div className="designz">
      <div className="dz-list" style={props.width ? { width: props.width } : undefined}>
        <div className="dz-top">
          <div className="brand">
            <i />
            LetsCoding
          </div>
          <ModeTabs
            active="design"
            alert={props.permMode}
            onSwitch={(k) => (k === 'work' ? props.onBack() : k === 'taskwork' ? props.onTaskWork() : undefined)}
          />
        </div>
        <div className="dz-body">
          {props.cwds.length > 0 && (
            <select
              className="dz-cwd"
              value={cwd ?? ''}
              title={cwd ?? ''}
              onChange={(e) => switchCwd(e.target.value)}
            >
              {props.cwds.map((c) => (
                <option key={c} value={c}>
                  {c.split('/').filter(Boolean).pop() ?? c}
                </option>
              ))}
            </select>
          )}
          <div className="dz-grp">
            design/ <span className="hint">{files.length} 份</span>
          </div>
          {!cwd && <div className="dz-empty">先在 Code 模式打开一个会话，这里会显示该项目的设计稿</div>}
          {cwd && files.length === 0 && (
            <div className="dz-empty">还没有设计稿——右边对话里说想要什么，让它出第一份</div>
          )}
          {files.map((f) => (
            <div key={f.file} className={`dz-frow${sel === f.file ? ' on' : ''}`} onClick={() => setSel(f.file)}>
              <span className="fic">◈</span>
              <span className="fname" title={f.file}>
                {f.file}
              </span>
              <span className="fwhen">{relTime(f.mtime)}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="col-rsz" title="拖动调宽" onMouseDown={props.onDragSide} />

      <div className="dz-main">
        <div className="dz-bar">
          {sel ? (
            <span className="dz-file">
              <span className="dir">design/</span>
              {sel}
            </span>
          ) : (
            <span className="dz-file dir">未选择设计稿</span>
          )}
          <div className="wseg">
            {(['full', 768, 390] as const).map((w) => (
              <span key={w} className={widthMode === w ? 'on' : ''} onClick={() => setWidthMode(w)}>
                {w === 'full' ? '桌面' : w}
              </span>
            ))}
          </div>
          <div className="bar-act">
            <span className="dz-mini" title="刷新预览" onClick={() => void loadHtml(false)}>
              ↻
            </span>
            <span
              className="dz-mini"
              title="在浏览器打开"
              onClick={() => cwd && sel && void window.letscoding.design.open(cwd, sel)}
            >
              浏览器 ↗
            </span>
            <span
              className="dz-mini"
              title="在访达中显示"
              onClick={() => cwd && sel && void window.letscoding.design.reveal(cwd, sel)}
            >
              ⌖
            </span>
          </div>
        </div>
        <div className="dz-canvas">
          {html && cwd && sel && mtime !== null ? (
            // D11 硬闸（G10 gate）：sandbox 仅 allow-scripts、不给 same-origin 权限——模型生成的 HTML 与 App 环境隔离。
            // 供稿走 lcdesign:// 专用协议（D12.3）：main 只读供稿 + 响应自带网络全禁 CSP；
            // v=mtime 使改稿落盘即换 URL 重载（srcdoc 会继承宿主 CSP，内联脚本全被禁——设计稿交互与滚动脚本都要真 scheme 才能跑）
            <iframe
              ref={iframeRef}
              className="dz-iframe"
              sandbox="allow-scripts"
              src={`lcdesign://preview/?cwd=${encodeURIComponent(cwd)}&f=${encodeURIComponent(sel)}&v=${mtime}`}
              style={{ width: widthMode === 'full' ? '100%' : widthMode }}
              title={sel ?? 'design'}
              onLoad={() => {
                // 改稿刷新重载后回到原滚动位置（D12.3）
                const y = mapKey ? (scrollMem.current[mapKey] ?? 0) : 0
                if (y > 0) iframeRef.current?.contentWindow?.postMessage({ t: 'dz-restore', y }, '*')
              }}
            />
          ) : (
            <div className="dz-guide">
              <div className="dz-guide-t">◇ Design</div>
              <div className="dz-guide-d">
                选择左侧一份设计稿预览，或在右侧对话里描述想法——它会直接产出/修改 design/ 下的 HTML
                设计稿，改完这里即时刷新。
              </div>
            </div>
          )}
        </div>
        <div className="dz-status">
          {fresh ? (
            <span className="fresh">● 稿子刚更新 · 预览已自动刷新</span>
          ) : (
            <span>{running ? '对话正在改稿…' : 'sandbox 预览 · 与应用环境隔离'}</span>
          )}
          {mtime && <span style={{ marginLeft: 'auto' }}>最后修改 {relTime(mtime)}</span>}
        </div>
      </div>

      {props.chatHidden && (
        <button className="edge-restore right" title="显示设计对话" onClick={() => props.onChatHide(false)}>
          ‹
        </button>
      )}
      {!props.chatHidden && (
        <>
      <div
        className="col-rsz"
        title="拖动调宽 · 双击隐藏"
        onMouseDown={props.onDragChat}
        onDoubleClick={() => props.onChatHide(true)}
      />
      <div className="dz-chat" style={{ width: props.chatW }}>
        <div className="dz-chat-h">
          <div>
            <div className="t">设计对话</div>
            <div className="sub">{sel ? `绑定 ${sel} · 持续上下文` : '出新稿 / 改选中的稿'}</div>
          </div>
          {running ? (
            <span className="dz-stop" onClick={() => void stop()}>
              ⏹ 停止
            </span>
          ) : (
            <span
              className="dz-newchat"
              title="不带旧上下文重开对话"
              onClick={() => {
                if (mapKey) {
                  delete mapRef.current[mapKey]
                  window.letscoding.settings
                    .set({ designSessions: JSON.stringify(mapRef.current) })
                    .catch(() => {})
                }
                setHandle(null)
                loadHistoryFor(null) // 主动弃旧上下文：既往对话一并收起
              }}
            >
              ＋ 新对话
            </span>
          )}
        </div>
        <div className="dz-msgs" ref={msgsRef}>
          {history.length === 0 && visible.length === 0 && (
            <div className="dz-chat-empty">
              描述要改的地方（"工具条改成深色"），或让它出新一版。它会直接改文件，左边预览即时刷新。
            </div>
          )}
          <ChatFlow items={history} running={false} lastAssistantId={null} />
          {history.length > 0 && (
            <div className="dz-m-status">—— 以上为这份稿的既往对话，发消息接着聊 ——</div>
          )}
          <ChatFlow items={visible} running={running} lastAssistantId={lastAssistantId} onGrow={followTail} />
          {running &&
            (props.permHandle && props.permHandle === handle ? (
              <div className="dz-m-status warn">⚠ 对话在等待权限确认——处理右下角的权限卡即可继续</div>
            ) : (
              <div className="dz-m-status">● 正在思考/改稿…</div>
            ))}
          {note && <div className="dz-m-status warn">{note}</div>}
        </div>
        <div className="dz-comp">
          <textarea
            className="dz-in"
            placeholder="描述要改的地方，或让它出新一版…（⌘↵ 发送）"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault()
                void send()
              }
            }}
          />
          <div className="dz-comp-f">
            {model && <span className="dz-chip">{model.split('/').pop()}</span>}
            <span className="dz-chip">自动执行</span>
            <button className="dz-send" disabled={running || !draft.trim()} onClick={() => void send()}>
              ↵ 发送
            </button>
          </div>
        </div>
      </div>
        </>
      )}
    </div>
  )
}
