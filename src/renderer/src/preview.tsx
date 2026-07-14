// 纯视觉预览入口（不进生产包）：用样例数据渲染 Sidebar，供截图核对与设计稿的对齐度。
import ReactDOM from 'react-dom/client'
import './theme.css'
import Sidebar from './Sidebar'
import type { GroupDto, SessionListEntry } from '../../shared/ipc'

const noop = (): void => {}
const now = Date.now()

const groups: GroupDto[] = [
  { name: 'payments-api', collapsed: false },
  { name: 'web-console', collapsed: false },
  { name: 'sync-service', collapsed: true }
]

function mk(id: string, summary: string, opts: Partial<SessionListEntry> = {}): SessionListEntry {
  return {
    sessionId: id,
    summary,
    lastModified: now - 3 * 86_400_000,
    groupName: null,
    pinned: false,
    archived: false,
    ...opts
  }
}

const sessions: SessionListEntry[] = [
  mk('p1', 'LetsCoding 脚手架初始化', {
    pinned: true,
    lastModified: now - 2 * 3_600_000,
    live: { handle: 'h', model: 'anthropic/claude-fable-5', uiMode: 'auto' }
  }),
  mk('g1', '订单回调重试修复', {
    groupName: 'payments-api',
    lastModified: now - 60_000,
    live: { handle: 'h2', model: 'openrouter/anthropic/claude-sonnet-4.6', uiMode: 'bypass' }
  }),
  mk('g2', '对账字段映射梳理', {
    groupName: 'payments-api',
    lastModified: now - 26 * 60_000,
    live: { handle: 'h3', model: 'openrouter/openai/gpt-5.2-codex', uiMode: 'auto' }
  }),
  mk('g3', 'adapter 错误码统一', { groupName: 'payments-api', lastModified: now - 86_400_000 }),
  mk('c1', '记忆模块延迟预算评审', { groupName: 'web-console', lastModified: now - 3 * 86_400_000 }),
  mk('c2', '消息层重构 plan', { groupName: 'web-console', lastModified: now - 7 * 86_400_000 }),
  mk('u1', 'Workflows exploration', { lastModified: now - 5 * 3_600_000 }),
  mk('u2', 'Agent-cap-provider phone number', { lastModified: now - 2 * 86_400_000 })
]

ReactDOM.createRoot(document.getElementById('root')!).render(
  <div style={{ height: '100vh', display: 'flex' }}>
    <Sidebar
      sessions={sessions}
      groups={groups}
      activeSessionId="g1"
      onOpen={noop}
      onNew={noop}
      onSearch={noop}
      onNavigate={noop}
      onModeSwitch={noop}
      connected
      stats={{ memoryCount: 37, pendingCount: 2, spendText: '$42.18' }}
      permHandle="h3"
      permMode="taskwork"
      onPin={noop}
      onMove={noop}
      onRename={noop}
      onDelete={noop}
      onCreateGroup={noop}
      onRenameGroup={noop}
      onDeleteGroup={noop}
      onCollapseGroup={noop}
      onDropSession={noop}
      onCustomize={noop}
      unreadHandles={[]}
    />
  </div>
)
