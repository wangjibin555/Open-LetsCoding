import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionListEntry } from '../../shared/ipc'

// ⌘K 快速切换：按标题/分组模糊过滤，↑↓ 选择，↵ 打开，Esc 关闭。
export default function QuickSwitcher({
  sessions,
  onPick,
  onClose
}: {
  sessions: SessionListEntry[]
  onPick: (s: SessionListEntry) => void
  onClose: () => void
}): React.JSX.Element {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const pool = sessions.filter((s) => !s.archived)
    if (!needle) return pool.slice(0, 12)
    return pool
      .filter((s) => {
        const hay = `${s.customTitle ?? s.summary} ${s.groupName ?? ''} ${s.cwd ?? ''}`.toLowerCase()
        return hay.includes(needle)
      })
      .slice(0, 12)
  }, [q, sessions])

  useEffect(() => {
    if (idx >= results.length) setIdx(Math.max(0, results.length - 1))
  }, [results, idx])

  function onKey(e: React.KeyboardEvent): void {
    if (e.key === 'Escape') onClose()
    else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIdx((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && results[idx]) {
      onPick(results[idx])
    }
  }

  return (
    <div className="overlay" onClick={onClose} style={{ alignItems: 'flex-start', paddingTop: 100 }}>
      <div className="switcher" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          placeholder="搜索会话（标题 / 分组 / 目录）…"
          spellCheck={false}
        />
        <div className="switcher-list">
          {results.length === 0 && (
            <div style={{ padding: 14, fontSize: 12.5, color: 'var(--dim)' }}>无匹配会话</div>
          )}
          {results.map((s, i) => (
            <div
              key={s.sessionId}
              className={`switcher-row${i === idx ? ' on' : ''}`}
              onMouseEnter={() => setIdx(i)}
              onClick={() => onPick(s)}
            >
              <span className={`st ${s.live ? 'run' : 'idle'}`} />
              <span className="sw-title">{s.customTitle ?? s.summary}</span>
              {s.groupName && <span className="sw-grp">{s.groupName}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
