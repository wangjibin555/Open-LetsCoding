// SPEC §3.4 / DECISIONS D2：本目录是全仓唯一允许接触 @anthropic-ai/claude-agent-sdk 的模块，
// verify.sh 的 dep-lint gate 强制此边界。M2 起在此实现 SessionService。
export async function engineHealth(): Promise<{ sdk: 'loadable' | 'unavailable' }> {
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    return { sdk: typeof sdk.query === 'function' ? 'loadable' : 'unavailable' }
  } catch {
    return { sdk: 'unavailable' }
  }
}
