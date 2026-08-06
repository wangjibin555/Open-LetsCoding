// #12 性能红线的机器判定。这两条**看不出功能差别**——回退了界面照样正确，
// 只是长会话重新变卡。没有断言的话它会被下一次「顺手清理」悄悄改回去。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Markdown from './Markdown'

const SRC = readFileSync(resolve(__dirname, 'Markdown.tsx'), 'utf8')

describe('Markdown 性能红线（#12）', () => {
  // 实测：512 条消息全量重解析 132ms，而流式期间每个 text_delta 都会触发一次。
  // memo 命中后只解析变化的那一条 → 0.5ms，267×。
  it('组件必须被 memo 包住 —— 否则每个 token 重解析全部历史消息', () => {
    // 打在**导出的对象**上，不是 grep 源码：memo() 的产物带 $$typeof memo 标记
    const t = (Markdown as unknown as { $$typeof?: symbol }).$$typeof
    expect(String(t)).toContain('memo')
  })

  it('components / remarkPlugins 必须是模块级常量 —— 内联字面量会让 memo 整个失效', () => {
    // 这条**先于** memo 成立：prop 身份每次渲染都变的话，memo 永远比较不通过。
    // 断言形态：JSX 里只能引用常量名，不能出现内联的对象/数组字面量。
    expect(SRC).toMatch(/remarkPlugins=\{REMARK_PLUGINS\}/)
    expect(SRC).toMatch(/components=\{COMPONENTS\}/)
    expect(SRC).not.toMatch(/remarkPlugins=\{\[/)
    expect(SRC).not.toMatch(/components=\{\{/)
  })
})
