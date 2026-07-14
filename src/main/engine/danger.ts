// 危险命令匹配（DECISIONS D7）：纯函数，供 PreToolUse 硬门与权限桥双端复用。
export interface DangerRuleLike {
  pattern: string
  enabled: number | boolean
}

export function matchDanger(
  rules: DangerRuleLike[],
  toolName: string,
  input: Record<string, unknown>
): string | null {
  if (toolName !== 'Bash') return null
  const command = typeof input['command'] === 'string' ? (input['command'] as string) : ''
  if (!command) return null
  for (const rule of rules) {
    if (!rule.enabled) continue
    try {
      if (new RegExp(rule.pattern, 'i').test(command)) return rule.pattern
    } catch {
      // 无效正则不炸整个闸门，忽略该条
    }
  }
  return null
}
