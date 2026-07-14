// 助手消息正文的 Markdown 渲染（GFM：表格/删除线/任务列表/自动链接）。
// react-markdown 默认不渲染内嵌原始 HTML —— 模型输出无 XSS 面；
// 链接一律经 main 侧 shell:open-url 白名单（http/https）交系统浏览器。
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export default function Markdown({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
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
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
