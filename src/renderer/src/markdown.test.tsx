// Markdown 渲染回归：助手消息的 GFM 结构必须真的渲染成对应 HTML 元素，
// 且内嵌原始 HTML 不得透传（XSS 面）。renderToStaticMarkup 纯 node 可跑，无需 jsdom。
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from './Markdown'

function html(text: string): string {
  return renderToStaticMarkup(<Markdown text={text} />)
}

describe('Markdown 组件', () => {
  it('标题/加粗/行内代码/列表渲染为对应元素', () => {
    const out = html('## 结论\n\n**要点** `code`\n\n- 甲\n- 乙')
    expect(out).toContain('<h2>结论</h2>')
    expect(out).toContain('<strong>要点</strong>')
    expect(out).toContain('<code>code</code>')
    expect(out).toMatch(/<ul>[\s\S]*<li>甲<\/li>[\s\S]*<li>乙<\/li>[\s\S]*<\/ul>/)
  })

  it('代码块与引用块渲染', () => {
    const out = html('> 引用行\n\n```ts\nconst a = 1\n```')
    expect(out).toContain('<blockquote>')
    expect(out).toMatch(/<pre><code[^>]*>const a = 1/)
  })

  it('GFM 表格包在横向滚动容器里', () => {
    const out = html('| A | B |\n|---|---|\n| 1 | 2 |')
    expect(out).toContain('md-table-wrap')
    expect(out).toMatch(/<th[^>]*>A<\/th>/)
    expect(out).toMatch(/<td[^>]*>1<\/td>/)
  })

  it('链接渲染为 <a>（点击走 shell:open-url，不在此处触发）', () => {
    const out = html('[官网](https://example.com)')
    expect(out).toMatch(/<a[^>]*href="https:\/\/example\.com"/)
  })

  it('内嵌原始 HTML 转义为纯文本，不产生可执行元素（无 XSS 面）', () => {
    const out = html('正文 <script>alert(1)</script> <img src=x onerror=alert(1)>')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;script&gt;')
  })
})
