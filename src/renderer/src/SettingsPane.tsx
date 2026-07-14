import { useCallback, useEffect, useState } from 'react'
import type {
  DangerRuleDto,
  GatewayTestResult,
  ModelInfoDto,
  SecretStatusResult,
  SpendInfoDto
} from '../../shared/ipc'
import { modelMeta } from './ui'
import {
  applyAppearance,
  parseAppearance,
  BG_PRESETS,
  CARD_FS_OPTIONS,
  ZOOM_OPTIONS,
  type Appearance
} from './appearance'

interface Props {
  activeCwd: string | null
  onBack: () => void
  onChanged: () => void
}

// 模型与连接全屏页（设计稿 ④）：网关 / 默认模型 / 路由表 / 本地数据 / 用量 + 权限规则（D7）。
export default function SettingsPane({ activeCwd, onBack, onChanged }: Props): React.JSX.Element {
  const [baseUrl, setBaseUrl] = useState('')
  const [key, setKey] = useState('')
  const [status, setStatus] = useState<SecretStatusResult | null>(null)
  const [test, setTest] = useState<GatewayTestResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [models, setModels] = useState<ModelInfoDto[]>([])
  const [spend, setSpend] = useState<SpendInfoDto | null>(null)
  const [defaultModel, setDefaultModel] = useState('')
  const [smallFastModel, setSmallFastModel] = useState('')
  const [appearance, setAppearance] = useState<Appearance | null>(null)

  const refreshPanel = useCallback(async () => {
    setModels(await window.letscoding.models.list())
    setSpend(await window.letscoding.spend.summary())
  }, [])

  useEffect(() => {
    void window.letscoding.settings.get().then((s) => {
      setBaseUrl(s.baseUrl ?? '')
      setDefaultModel(s.defaultModel ?? '')
      setSmallFastModel(s.smallFastModel ?? '')
      setAppearance(parseAppearance(s.appearance))
    })
    void window.letscoding.settings.secretStatus().then(setStatus)
    void refreshPanel()
  }, [refreshPanel])

  async function saveGateway(): Promise<void> {
    setBusy(true)
    await window.letscoding.settings.set({ baseUrl: baseUrl.trim() })
    if (key.trim()) await window.letscoding.settings.setSecret(key.trim())
    const t = await window.letscoding.settings.testGateway()
    setTest(t)
    setStatus(await window.letscoding.settings.secretStatus())
    setBusy(false)
    if (t.ok) {
      setKey('')
      await refreshPanel()
      onChanged()
    }
  }

  async function pickDefault(kind: 'default' | 'small', id: string): Promise<void> {
    if (kind === 'default') {
      setDefaultModel(id)
      await window.letscoding.settings.set({ defaultModel: id })
    } else {
      setSmallFastModel(id)
      await window.letscoding.settings.set({ smallFastModel: id })
    }
  }

  // 外观变更：立即生效 + 落 settings（state.db，D5）
  function patchAppearance(patch: Partial<Appearance>): void {
    setAppearance((cur) => {
      const next = { ...(cur ?? parseAppearance(null)), ...patch }
      applyAppearance(next)
      void window.letscoding.settings.set({ appearance: JSON.stringify(next) })
      return next
    })
  }

  const enabled = models.filter((m) => m.enabled)

  return (
    <div className="pane">
      <div className="pane-head">
        <button className="back" onClick={onBack}>
          ‹ 工作台
        </button>
        <h2>模型与连接</h2>
      </div>

      <div className="set-wrap">
        <div className="card">
          <h3>
            <span className="conn" style={{ background: test?.ok || models.length > 0 ? 'var(--ok)' : 'var(--idle)' }} />
            LiteLLM 网关
            {test?.ok && <span className="sub">延迟 {test.latencyMs}ms</span>}
          </h3>
          <div className="kv">
            <span className="lab">Base URL</span>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://llm.example.com"
              spellCheck={false}
            />
          </div>
          <div className="kv">
            <span className="lab">API Key</span>
            <input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              type="password"
              placeholder={status?.gatewayKeySet ? '已设置 · 留空保留' : 'sk-…'}
              spellCheck={false}
            />
          </div>
          <div className="kv">
            <span className="lab" />
            <button className="mini" disabled={busy} onClick={() => void saveGateway()}>
              {busy ? '测试中…' : '保存并测试'}
            </button>
            {test && !test.ok && <span style={{ fontSize: 11.5, color: 'var(--err)' }}>{test.error}</span>}
            {test?.ok && (
              <span style={{ fontSize: 11.5, color: 'var(--ok)' }}>连接成功 · {test.modelCount} 个模型</span>
            )}
          </div>
          {status && !status.encryptionAvailable && (
            <div style={{ fontSize: 12, color: 'var(--err)' }}>系统加密存储不可用，无法安全保存 key</div>
          )}
        </div>

        <div className="card">
          <h3>默认模型</h3>
          <div className="kv">
            <span className="lab">会话默认</span>
            <select value={defaultModel} onChange={(e) => void pickDefault('default', e.target.value)}>
              <option value="">（未设置，取启用列表第一个）</option>
              {enabled.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          </div>
          <div className="kv">
            <span className="lab">轻任务</span>
            <select value={smallFastModel} onChange={(e) => void pickDefault('small', e.target.value)}>
              <option value="">（未设置）</option>
              {enabled.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--dim)' }}>轻任务模型经 ANTHROPIC_SMALL_FAST_MODEL 注入</div>
        </div>

        <div className="card">
          <h3>外观</h3>
          <div className="kv">
            <span className="lab">背景</span>
            <div className="swatches">
              {Object.entries(BG_PRESETS).map(([k, p]) => (
                <button
                  key={k}
                  className={`swatch${appearance?.bg === k ? ' on' : ''}`}
                  title={p.label}
                  onClick={() => patchAppearance({ bg: k })}
                >
                  <i style={{ background: p.swatch }} />
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="kv">
            <span className="lab">界面缩放</span>
            <select
              value={String(appearance?.zoom ?? 1)}
              onChange={(e) => patchAppearance({ zoom: Number(e.target.value) })}
            >
              {ZOOM_OPTIONS.map((z) => (
                <option key={z} value={z}>
                  {Math.round(z * 100)}%
                </option>
              ))}
            </select>
          </div>
          <div className="kv">
            <span className="lab">会话卡片字号</span>
            <select
              value={String(appearance?.cardFs ?? 13)}
              onChange={(e) => patchAppearance({ cardFs: Number(e.target.value) })}
            >
              {CARD_FS_OPTIONS.map((f) => (
                <option key={f} value={f}>
                  {f}px{f === 13 ? '（标准）' : ''}
                </option>
              ))}
            </select>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--dim)' }}>即改即生效，随应用重启保持</div>
        </div>

        <div className="card full">
          <h3>
            模型路由 <span className="sub">同步自 LiteLLM /v1/models · 停用的不出现在新会话选单</span>
          </h3>
          {models.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--dim)' }}>暂无模型：先在上方配置网关并测试连接</div>
          ) : (
            <table className="rt">
              <thead>
                <tr>
                  <th>显示名</th>
                  <th>LiteLLM 路由 ID</th>
                  <th>提供方</th>
                  <th>启用</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m) => {
                  const meta = modelMeta(m.id)
                  return (
                    <tr key={m.id} style={{ opacity: m.enabled ? 1 : 0.55 }}>
                      <td className="nm">
                        <span className={`pdot ${meta.dot}`} style={{ marginRight: 7 }} />
                        {meta.label}
                      </td>
                      <td>
                        <code>{m.id}</code>
                      </td>
                      <td>{meta.provider}</td>
                      <td>
                        <span
                          className={`tgl${m.enabled ? '' : ' off'}`}
                          onClick={() =>
                            void window.letscoding.models.toggle(m.id, !m.enabled).then(refreshPanel)
                          }
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <h3>
            本地数据 <span className="sub">与 Claude Code CLI 共用</span>
          </h3>
          <div className="paths">
            <div className="rl">
              <code>~/.claude/CLAUDE.md</code>
              <span style={{ fontSize: 11.5 }}>全局指令</span>
              <span className="op" onClick={() => void window.letscoding.shell.reveal('claude-root')}>
                在 Finder 打开
              </span>
            </div>
            <div className="rl">
              <code>~/.claude/projects/{activeCwd ? `${activeCwd.split('/').pop()}…` : '<目录>'}/</code>
              <span style={{ fontSize: 11.5 }}>会话记录</span>
              <span
                className="op"
                onClick={() => void window.letscoding.shell.reveal('projects', activeCwd ?? undefined)}
              >
                在 Finder 打开
              </span>
            </div>
            <div className="rl">
              <code>…/memory/</code>
              <span style={{ fontSize: 11.5 }}>记忆</span>
              <span
                className="op"
                onClick={() =>
                  void window.letscoding.shell.reveal(activeCwd ? 'memory' : 'claude-root', activeCwd ?? undefined)
                }
              >
                在 Finder 打开
              </span>
            </div>
          </div>
        </div>

        <div className="card">
          <h3>
            用量 <span className="sub">只认网关 /spend · 不采用 SDK 估算</span>
          </h3>
          <div style={{ fontSize: 12.5, color: spend?.available ? 'var(--text)' : 'var(--dim)', lineHeight: 1.7 }}>
            {spend === null
              ? '查询中…'
              : spend.available
                ? `本 key 累计消费 $${spend.spendUsd?.toFixed(4)}`
                : `用量查询不可用：${spend.reason ?? '未知原因'}${
                    /key_info|permission|403|Forbidden/i.test(spend.reason ?? '')
                      ? '（当前 key 无 key_info 权限，如需面板请发放带该权限的 key）'
                      : ''
                  }`}
          </div>
        </div>

        <RulesCard />
      </div>
    </div>
  )
}

// 权限规则（D7）：危险清单（builtin 不可关不可删）+ 命令白名单。
function RulesCard(): React.JSX.Element {
  const [rules, setRules] = useState<DangerRuleDto[]>([])
  const [whitelist, setWhitelist] = useState<string[]>([])
  const [newDanger, setNewDanger] = useState('')
  const [newAllow, setNewAllow] = useState('')
  const [err, setErr] = useState('')

  const refresh = useCallback(async () => {
    setRules(await window.letscoding.rules.dangerList())
    setWhitelist(await window.letscoding.rules.whitelist())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function guard(fn: () => Promise<void>): Promise<void> {
    setErr('')
    try {
      await fn()
      await refresh()
    } catch (e) {
      setErr(String(e))
    }
  }

  return (
    <div className="card full">
      <h3>
        权限规则 <span className="sub">危险清单在所有档位强制弹窗 · 白名单绕不过 · 内置规则恒生效</span>
      </h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 11, fontFamily: 'var(--mono)', letterSpacing: '.12em', color: 'var(--dim)', textTransform: 'uppercase' }}>
            危险清单（正则，匹配 Bash 命令）
          </div>
          {rules.map((r) => (
            <div key={r.id} className="rule-row" style={{ opacity: r.builtin ? 0.75 : 1 }}>
              <code>{r.pattern}</code>
              {r.builtin ? (
                <span className="chip" style={{ fontSize: 10.5 }}>
                  内置 · 恒生效
                </span>
              ) : (
                <>
                  <button
                    className="mini"
                    onClick={() => void guard(() => window.letscoding.rules.dangerToggle(r.id, !r.enabled))}
                  >
                    {r.enabled ? '停用' : '启用'}
                  </button>
                  <button className="mini" onClick={() => void guard(() => window.letscoding.rules.dangerRemove(r.id))}>
                    删除
                  </button>
                </>
              )}
            </div>
          ))}
          <div className="rule-add">
            <input
              value={newDanger}
              onChange={(e) => setNewDanger(e.target.value)}
              placeholder="新增危险正则，如 drop\s+database"
              spellCheck={false}
            />
            <button
              className="mini"
              disabled={!newDanger.trim()}
              onClick={() =>
                void guard(async () => {
                  await window.letscoding.rules.dangerAdd(newDanger.trim())
                  setNewDanger('')
                })
              }
            >
              添加
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 11, fontFamily: 'var(--mono)', letterSpacing: '.12em', color: 'var(--dim)', textTransform: 'uppercase' }}>
            命令白名单（自动放行，形如 git status:*）
          </div>
          {whitelist.map((p) => (
            <div key={p} className="rule-row">
              <code>{p}</code>
              <button className="mini" onClick={() => void guard(() => window.letscoding.rules.whitelistRemove(p))}>
                移除
              </button>
            </div>
          ))}
          <div className="rule-add">
            <input
              value={newAllow}
              onChange={(e) => setNewAllow(e.target.value)}
              placeholder="如 npm run test:*"
              spellCheck={false}
            />
            <button
              className="mini"
              disabled={!newAllow.trim()}
              onClick={() =>
                void guard(async () => {
                  await window.letscoding.rules.whitelistAdd(newAllow.trim())
                  setNewAllow('')
                })
              }
            >
              添加
            </button>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--dim)' }}>
            白名单在新会话生效；危险清单实时生效，命中即使在白名单内也强制弹窗。
          </div>
        </div>
      </div>
      {err && <div style={{ fontSize: 12, color: 'var(--err)' }}>{err}</div>}
    </div>
  )
}
