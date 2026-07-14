// 子 agent 步骤读取器（只读）：<projects>/<slug>/<sessionId>/subagents/ 下
// agent-*.meta.json 携带 toolUseId（关联主会话里的 Task tool_use），
// 同名 .jsonl 是子 agent 自己的 transcript —— 摘要成步骤列表供回放展示。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SubagentStep {
  t: 'text' | 'tool'
  label: string
}

export interface SubagentInfo {
  description: string
  agentType: string
  steps: SubagentStep[]
}

const STEP_CAP = 150
const LABEL_CAP = 90

function briefOf(input: Record<string, unknown>): string {
  for (const k of ['command', 'file_path', 'pattern', 'description']) {
    if (typeof input[k] === 'string') return input[k] as string
  }
  return ''
}

export function readSubagents(
  projectsDir: string,
  cwd: string,
  sessionId: string
): Record<string, SubagentInfo> {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const dir = join(projectsDir, slug, sessionId, 'subagents')
  const out: Record<string, SubagentInfo> = {}
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.meta.json')) continue
    try {
      const meta = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
        toolUseId?: string
        description?: string
        agentType?: string
      }
      if (!meta.toolUseId) continue
      const steps: SubagentStep[] = []
      const jsonl = join(dir, f.replace(/\.meta\.json$/, '.jsonl'))
      if (existsSync(jsonl)) {
        for (const line of readFileSync(jsonl, 'utf8').split('\n')) {
          if (steps.length >= STEP_CAP) break
          if (!line.trim()) continue
          let d: { type?: string; message?: { content?: unknown } }
          try {
            d = JSON.parse(line) as typeof d
          } catch {
            continue
          }
          if (d.type !== 'assistant' || !Array.isArray(d.message?.content)) continue
          for (const b of d.message.content as {
            type: string
            text?: string
            name?: string
            input?: Record<string, unknown>
          }[]) {
            if (b.type === 'text' && b.text?.trim()) {
              steps.push({ t: 'text', label: b.text.trim().slice(0, LABEL_CAP) })
            } else if (b.type === 'tool_use') {
              steps.push({
                t: 'tool',
                label: `${b.name ?? ''} ${briefOf(b.input ?? {})}`.trim().slice(0, LABEL_CAP)
              })
            }
          }
        }
      }
      out[meta.toolUseId] = {
        description: meta.description ?? '',
        agentType: meta.agentType ?? '',
        steps
      }
    } catch {
      // 单个损坏的 meta/jsonl 不影响其余子 agent
    }
  }
  return out
}
