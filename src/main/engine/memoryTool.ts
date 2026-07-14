// propose_memory 工具通道（DECISIONS D6 / SPEC §3.2）：模型认为值得沉淀时调用本工具，
// engine 拦截入收件箱 —— 本模块绝不写盘，落盘唯一发生在 MemoryService.accept（用户确认后）。
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

export const MEMORY_TOOL_NAME = 'mcp__letscoding__propose_memory'

export interface MemoryProposal {
  handle: string
  cwd: string
  name: string
  type: 'user' | 'feedback' | 'project' | 'reference'
  description: string
  body: string
}

const TOOL_DESCRIPTION = [
  '向用户提议沉淀一条跨会话可复用的记忆。绝大多数会话不需要沉淀 —— 仅当本次会话',
  '啃懂了非平凡知识、踩了非平凡的坑、或确立了可复用模式时才调用（宁缺毋滥）。',
  '不要沉淀：代码结构等仓库可查的事实、只对本次会话有意义的细节、未经确认的猜测。',
  '调用后建议进入用户收件箱等待人工确认，不会立即写盘；不要假设它已被保存。'
].join('')

export function buildMemoryServer(
  handle: string,
  cwd: string,
  onProposal: (p: MemoryProposal) => void
): ReturnType<typeof createSdkMcpServer> {
  const proposeMemory = tool(
    'propose_memory',
    TOOL_DESCRIPTION,
    {
      name: z
        .string()
        .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'kebab-case slug required')
        .describe('短横线小写 slug，如 order-bind-idempotency'),
      description: z.string().min(4).describe('一行摘要，用于索引与召回判断'),
      type: z
        .enum(['user', 'feedback', 'project', 'reference'])
        .describe('user=用户画像 feedback=工作方式反馈 project=项目事实 reference=外部资源'),
      body: z
        .string()
        .min(8)
        .describe('正文；feedback/project 类型须包含 **Why:** 与 **How to apply:** 行')
    },
    async (args) => {
      onProposal({ handle, cwd, ...args })
      return {
        content: [
          {
            type: 'text' as const,
            text: '已提交用户确认（收件箱），当前未写盘。请勿假设该记忆已保存。'
          }
        ]
      }
    }
  )

  return createSdkMcpServer({ name: 'letscoding', version: '1.0.0', tools: [proposeMemory] })
}
