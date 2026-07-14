// 渲染层展示助手：相对时间与模型提供方识别（设计稿的 pdot 语义色 + .mn 短名）。

export function relTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 172_800_000) return '昨天'
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)} 天前`
  const d = new Date(ts)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export interface ModelMeta {
  /** pdot 色类：an=Anthropic oa=OpenAI ds=DeepSeek qw=Qwen xx=其他 */
  dot: 'an' | 'oa' | 'ds' | 'qw' | 'xx'
  provider: string
  /** 路由 id 最后一段，作显示短名 */
  label: string
}

export function modelMeta(id: string): ModelMeta {
  const low = id.toLowerCase()
  const label = id.split('/').pop() ?? id
  if (low.includes('claude') || low.includes('anthropic')) return { dot: 'an', provider: 'Anthropic', label }
  if (low.includes('gpt') || low.includes('openai') || low.includes('codex') || /\bo[134]\b/.test(low))
    return { dot: 'oa', provider: 'OpenAI', label }
  if (low.includes('deepseek')) return { dot: 'ds', provider: 'DeepSeek', label }
  if (low.includes('qwen')) return { dot: 'qw', provider: 'Qwen', label }
  const seg = id.split('/')
  return { dot: 'xx', provider: seg.length > 1 ? seg[seg.length - 2] : '未知', label }
}

export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}
