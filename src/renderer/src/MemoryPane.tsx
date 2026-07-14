import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ConsolidationItemDto,
  InboxItemDto,
  MemoryFileDto,
  MemoryType,
  TrashItemDto
} from '../../shared/ipc'
import { relTime } from './ui'

/** SQLite CURRENT_TIMESTAMP（"YYYY-MM-DD HH:MM:SS"，UTC）→ 毫秒时间戳 */
function sqliteUtcMs(s: string): number {
  const t = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').getTime()
  return Number.isNaN(t) ? Date.now() : t
}

const TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference']

// 记忆库全屏页（设计稿 ③，D6/D9）：沉淀收件箱 + 已落盘记忆列表/详情/编辑/软删 + 回收站。
export default function MemoryPane({
  cwd,
  onBack
}: {
  cwd: string | null
  onBack: () => void
}): React.JSX.Element {
  const [scope, setScope] = useState<'cwd' | 'all' | 'trash'>(cwd ? 'cwd' : 'all')
  const [q, setQ] = useState('')
  const [inbox, setInbox] = useState<InboxItemDto[]>([])
  const [memories, setMemories] = useState<MemoryFileDto[]>([])
  const [trash, setTrash] = useState<TrashItemDto[]>([])
  const [consolidations, setConsolidations] = useState<ConsolidationItemDto[]>([])
  const [consolidating, setConsolidating] = useState(false)
  const [model, setModel] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [editDesc, setEditDesc] = useState('')
  const [editType, setEditType] = useState<MemoryType>('reference')
  const [editBody, setEditBody] = useState('')
  const [err, setErr] = useState('')

  const refresh = useCallback(async () => {
    setInbox(await window.letscoding.memory.inbox())
    if (scope === 'trash') {
      setTrash(await window.letscoding.memory.trash(cwd))
    } else {
      const list = await window.letscoding.memory.list(scope === 'cwd' && cwd ? cwd : null)
      setMemories(list)
    }
    setConsolidations(
      scope === 'cwd' && cwd ? await window.letscoding.memory.consolidationList(cwd) : []
    )
  }, [cwd, scope])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 默认模型（整理会话用）
  useEffect(() => {
    void window.letscoding.settings.get().then(async (s) => {
      if (s.defaultModel) return setModel(s.defaultModel)
      const ms = await window.letscoding.models.list()
      const first = ms.find((m) => m.enabled)
      if (first) setModel(first.id)
    })
  }, [])

  // 整理进行中：轮询整理收件箱，让模型陆续产出的合并建议尽快显示（最多约 60s）
  useEffect(() => {
    if (!consolidating || !cwd) return
    let ticks = 0
    const iv = setInterval(async () => {
      ticks++
      setConsolidations(await window.letscoding.memory.consolidationList(cwd))
      if (ticks >= 20) {
        clearInterval(iv)
        setConsolidating(false)
      }
    }, 3000)
    return () => clearInterval(iv)
  }, [consolidating, cwd])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return memories
    return memories.filter((m) =>
      `${m.name} ${m.description} ${m.type} ${m.scope}`.toLowerCase().includes(needle)
    )
  }, [memories, q])

  const detail = useMemo(
    () => filtered.find((m) => `${m.slug}/${m.file}` === selected) ?? filtered[0] ?? null,
    [filtered, selected]
  )

  async function act(fn: () => Promise<unknown>): Promise<void> {
    setErr('')
    try {
      await fn()
      await refresh()
    } catch (e) {
      setErr(String(e))
    }
  }

  function beginEdit(): void {
    if (!detail) return
    setEditDesc(detail.description)
    setEditType((detail.type as MemoryType) ?? 'reference')
    setEditBody(detail.body)
    setEditing(true)
  }

  async function saveEdit(): Promise<void> {
    if (!detail) return
    await act(async () => {
      await window.letscoding.memory.update({
        slug: detail.slug,
        file: detail.file,
        description: editDesc,
        type: editType,
        body: editBody
      })
      setEditing(false)
    })
  }

  async function deleteMemory(): Promise<void> {
    if (!detail) return
    if (!window.confirm(`删除记忆「${detail.name}」？可在回收站恢复。`)) return
    await act(async () => {
      await window.letscoding.memory.remove(detail.slug, detail.file)
      setSelected(null)
      setEditing(false)
    })
  }

  async function startConsolidate(): Promise<void> {
    if (!cwd || !model) return
    setErr('')
    try {
      await window.letscoding.memory.consolidateStart(cwd, model)
      setConsolidating(true)
    } catch (e) {
      setErr(String(e))
    }
  }

  const canConsolidate = scope === 'cwd' && !!cwd && memories.length >= 2 && !!model

  return (
    <div className="pane">
      <div className="pane-head">
        <button className="back" onClick={onBack}>
          ‹ 工作台
        </button>
        <h2>记忆库</h2>
        <div className="scope">
          <span
            className={`chip${scope === 'cwd' ? ' on' : ''}`}
            onClick={() => cwd && (setScope('cwd'), setEditing(false))}
            style={cwd ? undefined : { opacity: 0.5, cursor: 'default' }}
            title={cwd ? undefined : '未选择会话目录'}
          >
            当前目录
          </span>
          <span
            className={`chip${scope === 'all' ? ' on' : ''}`}
            onClick={() => (setScope('all'), setEditing(false))}
          >
            全部项目
          </span>
          <span
            className={`chip${scope === 'trash' ? ' on' : ''}`}
            onClick={() => (setScope('trash'), setEditing(false))}
          >
            回收站{trash.length > 0 && scope === 'trash' ? ` · ${trash.length}` : ''}
          </span>
        </div>
        {scope !== 'trash' && (
          <div className="ph-right">
            <span className="search">
              ⌕
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索记忆…" spellCheck={false} />
            </span>
            {scope === 'cwd' && (
              <button
                className="mini"
                disabled={!canConsolidate || consolidating}
                onClick={() => void startConsolidate()}
                title={
                  memories.length < 2
                    ? '记忆不足两条，无需整理'
                    : '让模型读全部记忆，提议合并重复项（逐条确认，确认前不写盘）'
                }
              >
                {consolidating ? '整理中…' : '整理记忆'}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="mem-wrap">
        {scope !== 'trash' && inbox.length > 0 && (
          <div className="inbox">
            <div className="inbox-h">
              ✦ 沉淀收件箱 <span className="n">· {inbox.length} 条待确认（确认前不写盘）</span>
            </div>
            {inbox.map((it) => (
              <div className="ib-item" key={it.id}>
                <span className={`ttag ${it.type}`}>{it.type}</span>
                <span className="nm">{it.name}</span>
                <span className="ds">{it.description}</span>
                <span className="src">
                  {it.cwd.split('/').pop()} · {relTime(sqliteUtcMs(it.created_at))}
                </span>
                <button className="mini acc" onClick={() => void act(() => window.letscoding.memory.accept(it.id))}>
                  落盘
                </button>
                <button className="mini" onClick={() => void act(() => window.letscoding.memory.discard(it.id))}>
                  丢弃
                </button>
              </div>
            ))}
          </div>
        )}

        {scope === 'cwd' && (consolidations.length > 0 || consolidating) && (
          <div className="inbox consol">
            <div className="inbox-h consol">
              ⤳ 整理建议
              <span className="n">
                {consolidations.length > 0
                  ? `· ${consolidations.length} 组待确认（确认前不写盘、不删源；合并后源进回收站可恢复）`
                  : '· 模型正在分析记忆…'}
              </span>
            </div>
            {consolidating && consolidations.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--dim)', display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="spin" />
                整理会话运行中，合并建议会陆续出现
              </div>
            )}
            {consolidations.map((c) => (
              <div className="consol-item" key={c.id}>
                <div className="consol-top">
                  <span className={`ttag ${c.type}`}>{c.type}</span>
                  <span className="nm">合并为 {c.name}</span>
                  <span className="ds">{c.description}</span>
                </div>
                <div className="consol-meta">
                  合并 {c.sources.length} 条：{c.sources.join('、')}
                </div>
                <div className="consol-meta dim">理由：{c.rationale}</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="mini acc"
                    onClick={() => void act(() => window.letscoding.memory.consolidationAccept(c.id))}
                  >
                    确认合并
                  </button>
                  <button
                    className="mini"
                    onClick={() => void act(() => window.letscoding.memory.consolidationDiscard(c.id))}
                  >
                    丢弃
                  </button>
                </div>
              </div>
            ))}
            {err && <div style={{ fontSize: 12, color: 'var(--err)' }}>{err}</div>}
          </div>
        )}

        {scope === 'trash' ? (
          <div className="mem-body">
            <div className="mem-list" style={{ flex: 1, paddingRight: 0 }}>
              {trash.length === 0 && (
                <div style={{ padding: 14, fontSize: 12.5, color: 'var(--dim)' }}>回收站为空</div>
              )}
              {trash.map((t) => (
                <div key={t.id} className="mrow" style={{ cursor: 'default' }}>
                  <div className="mr-main">
                    <span className="mr-name">{t.name}</span>
                    <span className="mr-desc">{t.description || '（无描述）'}</span>
                  </div>
                  <span className="mr-meta">
                    {t.slug.replace(/^-Users-[^-]+-?/, '') || t.slug} · 删于 {relTime(sqliteUtcMs(t.deletedAt))}
                  </span>
                  <button
                    className="mini"
                    onClick={() => void act(() => window.letscoding.memory.restore(t.id))}
                  >
                    恢复
                  </button>
                </div>
              ))}
              {err && <div style={{ fontSize: 12, color: 'var(--err)' }}>{err}</div>}
            </div>
          </div>
        ) : (
          <div className="mem-body">
            <div className="mem-list">
              {filtered.length === 0 && (
                <div style={{ padding: 14, fontSize: 12.5, color: 'var(--dim)' }}>
                  {scope === 'cwd' ? '该目录暂无记忆文件' : '暂无记忆文件'}
                </div>
              )}
              {filtered.map((m) => {
                const key = `${m.slug}/${m.file}`
                const on = detail && `${detail.slug}/${detail.file}` === key
                return (
                  <div
                    key={key}
                    className={`mrow${on ? ' on' : ''}`}
                    onClick={() => {
                      setSelected(key)
                      setEditing(false)
                    }}
                  >
                    <span className={`ttag ${m.type}`}>{m.type}</span>
                    <div className="mr-main">
                      <span className="mr-name">{m.name}</span>
                      <span className="mr-desc">{m.description || '（无描述）'}</span>
                    </div>
                    <span className="mr-meta">
                      {m.scope} · {relTime(m.mtime)}
                    </span>
                  </div>
                )
              })}
            </div>

            <div className="mem-detail">
              {detail ? (
                editing ? (
                  <>
                    <div className="md-head">
                      <span className={`ttag ${editType}`}>{editType}</span>
                      <span className="mr-name">{detail.file}</span>
                      <div className="acts">
                        <button className="mini acc" onClick={() => void saveEdit()}>
                          保存
                        </button>
                        <button className="mini" onClick={() => setEditing(false)}>
                          取消
                        </button>
                      </div>
                    </div>
                    <label className="edit-label">类型</label>
                    <div className="seg">
                      {TYPES.map((t) => (
                        <span key={t} className={editType === t ? 'on' : ''} onClick={() => setEditType(t)}>
                          {t}
                        </span>
                      ))}
                    </div>
                    <label className="edit-label">描述（frontmatter · 同步索引）</label>
                    <input
                      className="edit-input"
                      value={editDesc}
                      onChange={(e) => setEditDesc(e.target.value)}
                      spellCheck={false}
                    />
                    <label className="edit-label">正文</label>
                    <textarea
                      className="edit-area"
                      value={editBody}
                      onChange={(e) => setEditBody(e.target.value)}
                      spellCheck={false}
                    />
                    <div style={{ fontSize: 11.5, color: 'var(--dim)' }}>
                      name「{detail.name}」不可改——它是文件名与索引键。如需改名请删除后重新沉淀。
                    </div>
                    {err && <div style={{ fontSize: 12, color: 'var(--err)' }}>{err}</div>}
                  </>
                ) : (
                  <>
                    <div className="md-head">
                      <span className={`ttag ${detail.type}`}>{detail.type}</span>
                      <span className="mr-name">{detail.file}</span>
                      <div className="acts">
                        <button className="mini" onClick={beginEdit}>
                          编辑
                        </button>
                        <button className="mini danger" onClick={() => void deleteMemory()}>
                          删除
                        </button>
                      </div>
                    </div>
                    <div className="fm">
                      <pre>
                        <b>---</b>
                        {'\n'}
                        <b>name:</b> {detail.name}
                        {'\n'}
                        <b>description:</b> {detail.description}
                        {'\n'}
                        <b>metadata:</b>
                        {'\n'}
                        {'  '}
                        <b>type:</b> {detail.type}
                        {'\n'}
                        <b>---</b>
                      </pre>
                    </div>
                    <div className="md-body">{detail.body || '（正文为空）'}</div>
                    {err && <div style={{ fontSize: 12, color: 'var(--err)' }}>{err}</div>}
                  </>
                )
              ) : (
                <div style={{ fontSize: 12.5, color: 'var(--dim)' }}>选择左侧记忆查看详情</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
