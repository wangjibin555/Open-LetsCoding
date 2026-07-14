// 会话列表「主会话」判定（用户诉求：列表对齐 Claude Code 的人类主会话）。
// 排除两类非主会话：
//  ① cwd 在系统临时目录 —— 探针/冒烟/workflow 等一次性自动化会话
//  ② cwd 在 agent worktree（<repo>/.claude/worktrees/…）—— 后台 agent 的隔离工作树会话
// 子 agent transcript 本身存放在 <sessionId>/subagents/ 子目录，listSessions 不会列出，无需在此排除。
const TMP_PREFIXES = ['/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/']

export function isMainSession(cwd?: string): boolean {
  if (!cwd) return true
  const c = cwd.endsWith('/') ? cwd : `${cwd}/`
  if (TMP_PREFIXES.some((p) => c.startsWith(p))) return false
  if (c.includes('/.claude/worktrees/')) return false
  return true
}
