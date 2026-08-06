// 助手消息正文的 Markdown 渲染（GFM：表格/删除线/任务列表/自动链接）。
// react-markdown 默认不渲染内嵌原始 HTML —— 模型输出无 XSS 面；
// 链接一律经 main 侧 shell:open-url 白名单（http/https）交系统浏览器。
//
// ⚡ 性能红线（#12）：本组件在长会话里是**主要成本**。
// 流式期间每个 text_delta 都会让整个 App 重渲染一次，届时全部消息的 Markdown 会被
// 重新解析——实测 512 条消息一次全量解析 105 ms，按 10 delta/s 就是主线程打满。
// 两件事缺一不可，且**顺序有依赖**：
//   ① `components` / `remarkPlugins` 必须是**模块级常量**。写成内联对象字面量的话，
//      prop 身份每次渲染都变，② 的 memo 会被它整个失效掉——这正是原实现的形态。
//   ② 组件用 React.memo：文本没变的消息直接跳过解析。
import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** 模块级常量：身份稳定，memo 才生效（见文件头 ①） */
const REMARK_PLUGINS = [remarkGfm]

const COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault()
        if (href) void window.letscoding.shell.openUrl(href)
      }}
    >
      {children}
    </a>
  ),
  // 宽表格在自身容器内横向滚动，不撑破消息列
  table: ({ children }) => (
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  )
}

function MarkdownView({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

// 唯一 prop 是 text，且渲染结果只由它决定 —— 浅比较即正确。
export default memo(MarkdownView)
