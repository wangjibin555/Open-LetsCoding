// Claude Code 待办（TaskCreate 落盘）只读读取：~/.claude/tasks/<sessionId>/<n>.json
// 每个文件 = { id, subject, description, activeForm?, status, blocks, blockedBy }
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface SessionTask {
  id: string
  subject: string
  status: string
  activeForm: string | null
}

const MAX_TASKS = 200

export function readSessionTasks(tasksRoot: string, sessionId: string): SessionTask[] {
  // sessionId 形如 uuid；防路径穿越（只允许 uuid 字符集）
  if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) return []
  const dir = join(tasksRoot, sessionId)
  try {
    if (!existsSync(dir)) return []
    const files = readdirSync(dir)
      .filter((f) => /^\d+\.json$/.test(f))
      .sort((a, b) => Number.parseInt(a) - Number.parseInt(b))
      .slice(0, MAX_TASKS)
    const out: SessionTask[] = []
    for (const f of files) {
      try {
        const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>
        if (typeof raw['subject'] !== 'string') continue
        out.push({
          id: String(raw['id'] ?? f.replace('.json', '')),
          subject: raw['subject'],
          status: typeof raw['status'] === 'string' ? raw['status'] : 'pending',
          activeForm: typeof raw['activeForm'] === 'string' ? raw['activeForm'] : null
        })
      } catch {
        /* 单文件坏 JSON 跳过 */
      }
    }
    return out
  } catch {
    return []
  }
}
