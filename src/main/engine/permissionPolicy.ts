// D14 权限档决策纯函数：UI 档位 → SDK 模式映射 + 全权委托（bypass）档的放行判定。
// 独立于 sessions.ts：无运行时 SDK 依赖（类型 import 编译期擦除），可离线单测。
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'

export type UiPermissionMode = 'confirm-each' | 'plan-first' | 'auto' | 'bypass'

// D14 红线：bypass 不映射 SDK 的裸跳权限档——PreToolUse 'ask' 在该档下能否仍强制弹卡
// 属 SDK 未承诺语义，赌错则危险清单硬门（D7）失去执行点。映射 acceptEdits，
// 其余放行收敛在 canUseTool 层（shouldAutoAllow），行为完全客户端确定。
export const UI_TO_SDK_MODE: Record<UiPermissionMode, PermissionMode> = {
  'confirm-each': 'default',
  'plan-first': 'plan',
  auto: 'acceptEdits',
  bypass: 'acceptEdits'
}

/** 全权委托档自动放行；命中危险清单（D7）一律不放，照常弹卡人肉确认。 */
export function shouldAutoAllow(
  uiMode: UiPermissionMode | undefined,
  dangerMatched: string | null | undefined
): boolean {
  return uiMode === 'bypass' && !dangerMatched
}
