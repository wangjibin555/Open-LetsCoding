// propose_consolidation 工具通道（DECISIONS D9 · 整理）：整理会话读全部记忆后，
// 对每组可合并的记忆调用本工具给出合并方案。engine 拦截入整理收件箱 —— 本模块绝不写盘，
// 落盘/软删唯一发生在 MemoryService.acceptConsolidation（用户逐条确认后）。
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

export const CONSOLIDATE_TOOL_NAME = 'mcp__letscoding__propose_consolidation'

export interface ConsolidationProposal {
  handle: string
  cwd: string
  name: string
  type: 'user' | 'feedback' | 'project' | 'reference'
  description: string
  body: string
  /** 被合并的旧记忆文件名（如 foo.md）；确认后这些文件软删入回收站 */
  sources: string[]
  rationale: string
}

const TOOL_DESCRIPTION = [
  '提议把若干条重复 / 主题重叠的既有记忆合并成一条。仅在确有冗余时调用（宁缺毋滥）：',
  '主题不同、各自独立的记忆不要合并；拿不准就不合并。每组重复调用一次本工具。',
  'sources 必须逐字填被合并的旧记忆文件名（形如 foo.md）；合并后的新条目在 name/description/type/body 里给出。',
  '调用后进入用户整理收件箱等待逐条确认，不会立即写盘或删除任何文件。'
].join('')

export function buildConsolidationServer(
  handle: string,
  cwd: string,
  onProposal: (p: ConsolidationProposal) => void
): ReturnType<typeof createSdkMcpServer> {
  const propose = tool(
    'propose_consolidation',
    TOOL_DESCRIPTION,
    {
      name: z
        .string()
        .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'kebab-case slug required')
        .describe('合并后新记忆的短横线小写 slug'),
      description: z.string().min(4).describe('合并后一行摘要'),
      type: z
        .enum(['user', 'feedback', 'project', 'reference'])
        .describe('合并后类型：user/feedback/project/reference'),
      body: z.string().min(8).describe('合并后正文；保留各源记忆的关键信息，不要丢内容'),
      sources: z
        .array(z.string())
        .min(2)
        .describe('被合并的旧记忆文件名数组（如 ["a.md","b.md"]），至少两条'),
      rationale: z.string().min(4).describe('为什么这些可以合并（供用户判断）')
    },
    async (args) => {
      onProposal({ handle, cwd, ...args })
      return {
        content: [
          {
            type: 'text' as const,
            text: '合并方案已提交用户整理收件箱（未写盘、未删除）。请勿假设已生效。'
          }
        ]
      }
    }
  )

  return createSdkMcpServer({ name: 'letscoding', version: '1.0.0', tools: [propose] })
}
