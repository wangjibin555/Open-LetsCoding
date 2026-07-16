import { useCallback, useEffect, useState } from 'react'
import type { LearnStateDto } from '../../shared/ipc'

interface Props {
  onBack: () => void
  onOpenSettings: () => void
}

// D16 学习平台整页：iframe 只指向 127.0.0.1 + main 返回的配置端口，禁任意地址
export default function LearnPane({ onBack, onOpenSettings }: Props): React.JSX.Element {
  const [st, setSt] = useState<LearnStateDto | null>(null)

  const load = useCallback(() => {
    setSt(null)
    window.letscoding.learn
      .ensure()
      .then(setSt)
      .catch((e) => setSt({ status: 'error', url: null, message: String(e) }))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const port = st?.status === 'ready' && st.url ? new URL(st.url).port : null

  return (
    <div className="learn-page">
      <div className="learn-top">
        <button className="mini" onClick={onBack}>
          ← 返回
        </button>
        <h3>学习平台</h3>
        <span className="learn-sub">本地服务 · 127.0.0.1{port ? `:${port}` : ''}</span>
        <button className="mini" onClick={load}>
          刷新
        </button>
      </div>
      {!st && <div className="learn-hint">正在探测 / 启动本地服务…</div>}
      {st?.status === 'unconfigured' && (
        <div className="learn-hint">
          <p>还没配置学习平台：在设置里填写平台目录（含 start.sh）与端口即可。</p>
          <button className="mini acc" onClick={onOpenSettings}>
            去设置
          </button>
        </div>
      )}
      {st?.status === 'error' && (
        <div className="learn-hint">
          <p>启动失败：{st.message}</p>
          <button className="mini" onClick={load}>
            重试
          </button>
        </div>
      )}
      {port && <iframe className="learn-frame" src={`http://127.0.0.1:${port}`} title="学习平台" />}
    </div>
  )
}
