// 模式 Tab（Code / TaskWork / Design）——三个模式页共用同一结构与位置，切换时左上角不跳。
import { CRON_HANDLE_PREFIX, CRONCHAT_HANDLE_PREFIX, DESIGN_HANDLE_PREFIX } from '../../shared/ipc'

export type ModeKey = 'work' | 'taskwork' | 'design'

/** live 会话 handle → 所属模式（权限红点定位：cron-/cronchat-=TaskWork、design-=Design，其余=Code） */
export function modeOfHandle(handle: string | null): ModeKey | null {
  if (!handle) return null
  if (handle.startsWith(CRON_HANDLE_PREFIX) || handle.startsWith(CRONCHAT_HANDLE_PREFIX)) return 'taskwork'
  if (handle.startsWith(DESIGN_HANDLE_PREFIX)) return 'design'
  return 'work'
}

// sym：Unicode 符号字形（◷◇）比 mono 文本图标（</>）视觉偏小，CSS 单独放大适配
const TABS: { k: ModeKey; ic: string; lab: string; title: string; sym?: boolean }[] = [
  { k: 'work', ic: '</>', lab: 'Code', title: 'Code · 编码会话' },
  { k: 'taskwork', ic: '◷', lab: 'TaskWork', title: 'TaskWork · 定时任务', sym: true },
  { k: 'design', ic: '◇', lab: 'Design', title: 'Design · 设计稿', sym: true }
]

export default function ModeTabs({
  active,
  onSwitch,
  alert
}: {
  active: ModeKey
  onSwitch: (k: ModeKey) => void
  /** 该模式下有会话在等权限确认 → tab 上亮红点（当前屏不亮：卡片本身可见） */
  alert?: ModeKey | null
}): React.JSX.Element {
  return (
    <div className="mode-tabs">
      {TABS.map((t) => (
        <div
          key={t.k}
          className={`mtab${active === t.k ? ' on' : ''}`}
          title={t.title}
          onClick={() => active !== t.k && onSwitch(t.k)}
        >
          <span className={`ic${t.sym ? ' sym' : ''}`}>{t.ic}</span>
          <span className="lab">{t.lab}</span>
          {alert === t.k && t.k !== active && <span className="mdot" title="有会话在等待权限确认" />}
        </div>
      ))}
    </div>
  )
}
