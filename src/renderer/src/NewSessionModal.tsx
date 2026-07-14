import { useEffect, useState } from 'react'
import type { CreateSessionPayload, CtxInfoDto, UiPermissionMode } from '../../shared/ipc'
import { modelMeta } from './ui'

interface Props {
  models: string[]
  defaultModel: string | null
  defaultCwd: string
  recentCwds: string[]
  onCancel: () => void
  onCreate: (p: CreateSessionPayload) => void
}

const MODES: { key: UiPermissionMode; label: string; hint: string }[] = [
  { key: 'auto', label: '自动执行', hint: '文件编辑自动放行；命令与外联仍逐项确认' },
  { key: 'bypass', label: '全权委托', hint: '全部自动放行，仅危险清单命令仍需确认' },
  { key: 'plan-first', label: '计划先行', hint: '只读分析、先出计划再动手' },
  { key: 'confirm-each', label: '每步确认', hint: '每个需授权的工具都逐项确认' }
]

// 新建会话（设计稿 ②）：目录 + 模型卡片 + 权限模式 + 真实继承探测。
export default function NewSessionModal({
  models,
  defaultModel,
  defaultCwd,
  recentCwds,
  onCancel,
  onCreate
}: Props): React.JSX.Element {
  const [cwd, setCwd] = useState(defaultCwd)
  const [model, setModel] = useState(defaultModel && models.includes(defaultModel) ? defaultModel : (models[0] ?? ''))
  const [customModel, setCustomModel] = useState('')
  const [uiMode, setUiMode] = useState<UiPermissionMode>('auto')
  const [prompt, setPrompt] = useState('')
  const [ctx, setCtx] = useState<CtxInfoDto | null>(null)

  // 清单外型号直填（D14.2）：网关通配路由（如 openrouter/*）可调未列出的模型
  const effModel = customModel.trim() || model

  useEffect(() => {
    if (!model && models.length) setModel(models[0])
  }, [models, model])

  // 目录变化 → 探测继承（全局/项目 CLAUDE.md、目录记忆），轻防抖
  useEffect(() => {
    const dir = cwd.trim()
    if (!dir.startsWith('/')) {
      setCtx(null)
      return
    }
    const t = setTimeout(() => {
      void window.letscoding.ctx.info(dir).then(setCtx).catch(() => setCtx(null))
    }, 250)
    return () => clearTimeout(t)
  }, [cwd])

  const canStart = cwd.trim() && effModel && prompt.trim()

  // 默认模型排最前，开弹窗即见选中卡
  const ordered = defaultModel && models.includes(defaultModel)
    ? [defaultModel, ...models.filter((m) => m !== defaultModel)]
    : models

  return (
    <div className="overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-h">
          <h3>新建会话</h3>
          <p>会话按工作目录归档，指令与记忆从对应 .claude 目录继承</p>
        </div>
        <div className="modal-b">
          <div className="fld">
            <label>工作目录</label>
            <div className="dirbox">
              <input
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="/Users/…/项目目录"
                spellCheck={false}
              />
              <button
                className="mini"
                style={{ marginRight: 6, flexShrink: 0 }}
                onClick={() => {
                  void window.letscoding.dialog
                    .pickDir(cwd.trim() || undefined)
                    .then((d) => {
                      if (d) setCwd(d)
                    })
                    .catch(() => {})
                }}
              >
                选择…
              </button>
            </div>
            {recentCwds.length > 0 && (
              <div className="recents">
                {recentCwds.map((d, i) => (
                  <span key={d} className="chip" onClick={() => setCwd(d)}>
                    {i === 0 ? '最近：' : ''}
                    {d.split('/').pop()}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="fld">
            <label>模型 · 经 LiteLLM 路由</label>
            {models.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--dim)' }}>暂无可用模型：先在设置里配置网关</div>
            ) : (
              <div className="mgrid">
                {ordered.map((m) => {
                  const meta = modelMeta(m)
                  return (
                    <div
                      key={m}
                      className={`mcard${model === m && !customModel.trim() ? ' on' : ''}`}
                      onClick={() => {
                        setModel(m)
                        setCustomModel('')
                      }}
                    >
                      <div className="mc-top">
                        <span className={`pdot ${meta.dot}`} />
                        <span className="nm">{meta.label}</span>
                        {defaultModel === m && <span className="tag">默认</span>}
                      </div>
                      <div className="mc-sub">
                        {meta.provider} · {m}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            <input
              style={{ marginTop: 8 }}
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              placeholder="自定义模型 id（清单外直填，如 openrouter/anthropic/claude-opus-4.8）"
              spellCheck={false}
            />
          </div>

          <div className="fld">
            <label>权限模式</label>
            <div className="seg">
              {MODES.map((m) => (
                <span key={m.key} title={m.hint} className={uiMode === m.key ? 'on' : ''} onClick={() => setUiMode(m.key)}>
                  {m.label}
                </span>
              ))}
            </div>
          </div>

          <div className="fld">
            <label>继承</label>
            <div className="checks">
              <span className="ck">
                <i className={ctx?.globalClaudeMd ? '' : 'off'}>{ctx?.globalClaudeMd ? '✓' : '—'}</i>全局 CLAUDE.md
              </span>
              <span className="ck">
                <i className={ctx?.projectClaudeMd ? '' : 'off'}>{ctx?.projectClaudeMd ? '✓' : '—'}</i>项目 CLAUDE.md
              </span>
              <span className="ck">
                <i className={ctx && ctx.memoryCount > 0 ? '' : 'off'}>{ctx && ctx.memoryCount > 0 ? '✓' : '—'}</i>
                目录记忆{ctx ? `（${ctx.memoryCount} 条）` : ''}
              </span>
            </div>
          </div>

          <div className="fld">
            <label>首条消息</label>
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="描述要做的事…"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canStart) {
                  onCreate({
                    handle: `h-${Date.now()}`,
                    cwd: cwd.trim(),
                    model: effModel,
                    uiMode,
                    firstPrompt: prompt.trim()
                  })
                }
              }}
            />
          </div>
        </div>
        <div className="modal-f">
          <button className="mini" onClick={onCancel}>
            取消
          </button>
          <button
            className="mini acc"
            disabled={!canStart}
            onClick={() =>
              onCreate({
                handle: `h-${Date.now()}`,
                cwd: cwd.trim(),
                model: effModel,
                uiMode,
                firstPrompt: prompt.trim()
              })
            }
          >
            开始会话
          </button>
        </div>
      </div>
    </div>
  )
}
