import { describe, expect, it } from 'vitest'
import type { ReplayMessage } from '../../shared/ipc'
import { replayToFlow } from './replay'

function msg(type: 'user' | 'assistant', content: unknown): ReplayMessage {
  return { type, uuid: 'u', message: { content }, parent_tool_use_id: null }
}

describe('replayToFlow（D12.4：Code 回放与 Design 历史回放共用）', () => {
  it('user 字符串 / assistant 文本块 / 工具块按序还原', () => {
    const flow = replayToFlow([
      msg('user', '把工具条改成深色'),
      msg('assistant', [
        { type: 'text', text: '好的，直接改稿。' },
        { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'design/a.html', old_string: 'x', new_string: 'y' } }
      ]),
      msg('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok\nok2' }])
    ])
    expect(flow.map((f) => f.kind)).toEqual(['user', 'assistant', 'tool'])
    expect(flow[0].text).toBe('把工具条改成深色')
    expect(flow[2].toolName).toBe('Edit')
    expect(flow[2].diff?.badge).toBe('EDIT')
    // tool_result 回填到对应工具行摘要
    expect(flow[2].tres).toBe('2 行')
  })

  it('纯空白文本块跳过，出错 tool_result 标「出错」', () => {
    const flow = replayToFlow([
      msg('assistant', [
        { type: 'text', text: '   \n' },
        { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'a.html' } }
      ]),
      msg('user', [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'boom' }])
    ])
    expect(flow).toHaveLength(1)
    expect(flow[0].kind).toBe('tool')
    expect(flow[0].tres).toBe('出错')
  })

  it('用户图片块挂到同消息文本项；纯图片消息独立成项', () => {
    const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
    const withText = replayToFlow([msg('user', [img, { type: 'text', text: '照这个改' }])])
    expect(withText).toHaveLength(1)
    expect(withText[0].images).toHaveLength(1)
    expect(withText[0].text).toBe('照这个改')
    const bare = replayToFlow([msg('user', [img])])
    expect(bare).toHaveLength(1)
    expect(bare[0].images?.[0].startsWith('data:image/png;base64,')).toBe(true)
  })
})
