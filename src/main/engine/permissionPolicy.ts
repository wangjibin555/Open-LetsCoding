// D14 权限档决策纯函数：UI 档位 → SDK 模式映射 + 全权委托（bypass）档的放行判定。
// 独立于 sessions.ts：无运行时 SDK 依赖（类型 import 编译期擦除），可离线单测。
import type {
  PermissionMode,
  PermissionResult,
  PermissionUpdate
} from '@anthropic-ai/claude-agent-sdk'

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

/**
 * 放行结果的**唯一构造点**（issue #5）。
 *
 * SDK 的 `PermissionResult` 是个 union，allow 分支在**运行时 schema 里必填**
 * `updatedInput: record`——`sdk.d.ts` 把它标成可选，与运行时不一致，以运行时为准。
 * 少这个字段，union 两条分支都不匹配，整个权限请求以
 * `ZodError: expected record, received undefined` 失败：用户点了「同意」，工具照样执行不了。
 * 旧版 CLI 有一句 `updatedInput is undefined, falling back to original tool input` 的兜底，
 * 本仓随 SDK 打包的 `2.1.202` **没有**——所以「以前能跑」不代表现在能跑。
 *
 * `updatedInput` 原样回传 `canUseTool` 收到的入参：既满足 schema，
 * 又**绝不改写用户的命令**（改写等于替用户偷改要执行的东西）。
 */
export function allowResult(
  toolInput: Record<string, unknown>,
  updatedPermissions?: PermissionUpdate[]
): PermissionResult {
  return updatedPermissions?.length
    ? { behavior: 'allow', updatedInput: toolInput, updatedPermissions }
    : { behavior: 'allow', updatedInput: toolInput }
}

/** 全权委托档自动放行；命中危险清单（D7）一律不放，照常弹卡人肉确认。 */
export function shouldAutoAllow(
  uiMode: UiPermissionMode | undefined,
  dangerMatched: string | null | undefined
): boolean {
  return uiMode === 'bypass' && !dangerMatched
}

// D18 AskUserQuestion：把用户在问题卡上的选择整形成 SDK 的工具结果。
// 契约（SDK user-input）：allow 分支必须回传 { questions, answers }——SDK 用 updatedInput 当 tool_result；
// 取消/无答案 → deny（模型收到拒绝，不会拿到空结果而报错）。纯函数，离线可测。
export function buildQuestionResult(
  questions: unknown,
  answers: Record<string, string | string[]> | undefined,
  cancel?: boolean
): PermissionResult {
  if (cancel || !answers || Object.keys(answers).length === 0) {
    return { behavior: 'deny', message: '用户在 LetsCoding 中取消了提问' }
  }
  return { behavior: 'allow', updatedInput: { questions, answers } }
}
