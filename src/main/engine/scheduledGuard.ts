// TaskWork 定时会话的硬闸（DECISIONS D10 · 无人值守只读）。
// 定时任务在无人值守下自动执行，权限档为 auto（acceptEdits）——写工具会被自动放行且不经 canUseTool，
// 所以「只读」必须靠 disallowedTools 机制兜底（同 D9 整理会话的 G8 思路），不能只靠 prompt 软约束。
// 只读工具（Read/Grep/Glob）保留——复盘读 transcript / 项目文件足够。
// maxTurns 是成本护栏：单次运行轮数封顶，防失控烧 token。
export const SCHEDULED_DISALLOWED_TOOLS = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']
export const SCHEDULED_MAX_TURNS = 50
