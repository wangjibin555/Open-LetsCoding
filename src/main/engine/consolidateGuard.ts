// 整理会话的工具硬闸（DECISIONS D9 · 模型对既有文件零写权）。
// 整理会话只需读 prompt 里已喂入的记忆全文 + 调 propose_consolidation（免权限、只进收件箱）。
// 它绝不该直接改盘：以 disallowedTools 硬禁所有写/执行工具，让「模型只提议不碰 fs」有机制兜底
// 而非仅靠 prompt 软约束（acceptEdits 下 Edit/Write 会自动放行、不经 canUseTool，PreToolUse 只拦 Bash）。
// 只读工具（Read/Grep/Glob）不在此列——允许模型核对，但不能改。
export const CONSOLIDATE_DISALLOWED_TOOLS = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']
