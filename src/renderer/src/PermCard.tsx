// 权限确认卡（M20-A 从 App 抽出）：Code 屏内联在聊天列，非 Code 屏由 App 以全局浮层渲染——
// 任何屏都能就地允许/拒绝，不再需要切回 Code 处理。
import type { PermissionRequestPayload } from '../../shared/ipc'

export default function PermCard({
  perm,
  onRespond
}: {
  perm: PermissionRequestPayload
  onRespond: (allow: boolean, always?: boolean) => void
}): React.JSX.Element {
  return (
    <div className={`perm-card${perm.reason === 'danger_list' ? ' danger' : ''}`}>
      <div className={`ph${perm.reason === 'danger_list' ? ' danger' : ''}`}>
        {perm.reason === 'danger_list' ? '⚠ 危险命令，需确认' : '权限请求'} · {perm.toolName}
      </div>
      {typeof perm.input['command'] === 'string' && <code>{perm.input['command'] as string}</code>}
      {perm.dangerPattern && (
        <div style={{ fontSize: 11, color: 'var(--err)' }}>匹配规则：{perm.dangerPattern}</div>
      )}
      <div className="perm-acts">
        <button
          className={perm.reason === 'danger_list' ? 'mini danger' : 'mini acc'}
          onClick={() => onRespond(true)}
        >
          允许一次
        </button>
        {perm.reason !== 'danger_list' && perm.hasSuggestions && (
          <button className="mini" onClick={() => onRespond(true, true)}>
            总是允许（本会话）
          </button>
        )}
        <button className="mini" onClick={() => onRespond(false)}>
          拒绝
        </button>
      </div>
    </div>
  )
}
