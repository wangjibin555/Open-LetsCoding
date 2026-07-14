// LiteLLM 网关只读客户端（D8 最小切片：模型清单 + 连通性；spend 面板随 M5）。

/**
 * Anthropic SDK 语义下 ANTHROPIC_BASE_URL 必须是 root——SDK 自行追加 `/v1/messages`。
 * 用户常按 OpenAI 习惯把 base 填成带 `/v1` 的地址（LiteLLM 也这么给），
 * 直接注入会让 SDK 拼成 `/v1/v1/messages` → 404，且 SDK 把它误报成「模型不存在」。
 * 这里剥掉尾部空白/斜杠/`/v1`，使无论填 root 还是 `/v1` 都能连上。
 * gateway.ts 自身用 `new URL('/v1/models', base)`（绝对路径），对本规范化免疫，行为不变。
 */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '').replace(/\/v1$/, '').replace(/\/+$/, '')
}

export interface GatewayTestResult {
  ok: boolean
  latencyMs: number
  modelCount: number
  error?: string
}

export async function fetchModels(baseUrl: string, authToken: string): Promise<string[]> {
  const res = await fetch(new URL('/v1/models', baseUrl), {
    headers: { authorization: `Bearer ${authToken}` }
  })
  if (!res.ok) throw new Error(`gateway /v1/models responded ${res.status}`)
  const data = (await res.json()) as { data?: Array<{ id: string }> }
  return (data.data ?? [])
    .map((m) => m.id)
    .filter((id) => !id.includes('*'))
    .sort()
}

export async function testGateway(baseUrl: string, authToken: string): Promise<GatewayTestResult> {
  const t0 = Date.now()
  try {
    const models = await fetchModels(baseUrl, authToken)
    return { ok: true, latencyMs: Date.now() - t0, modelCount: models.length }
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - t0, modelCount: 0, error: String(err) }
  }
}

export interface SpendInfo {
  available: boolean
  /** 金额只认网关（D8）；不可用时为 null，绝不回退 SDK 估算值 */
  spendUsd: number | null
  reason?: string
}

/** LiteLLM /key/info：虚拟 key 自身的累计消费。key 权限不足时显式降级，不蒙混。 */
export async function fetchSpend(baseUrl: string, authToken: string): Promise<SpendInfo> {
  try {
    const res = await fetch(new URL('/key/info', baseUrl), {
      headers: { authorization: `Bearer ${authToken}` }
    })
    const data = (await res.json()) as {
      info?: { spend?: number; max_budget?: number | null }
      detail?: string
    }
    if (!res.ok || !data.info) {
      return { available: false, spendUsd: null, reason: data.detail ?? `HTTP ${res.status}` }
    }
    return { available: true, spendUsd: data.info.spend ?? 0 }
  } catch (err) {
    return { available: false, spendUsd: null, reason: String(err) }
  }
}
