// Design 模式（DECISIONS D11）：<cwd>/design/*.html 只读扫描与读取。
// 全模块零 fs 写（G7 不涉）；file 参数一律裸文件名，路径由这里拼——
// 「渲染层不传任意路径」红线的落点（同 ShellReveal/transcript 约定）。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 预览的体量上限：设计稿是自包含 HTML，2MB 足够；超限不读（防误选巨型文件卡渲染） */
const MAX_HTML_BYTES = 2_000_000

/** 预览专用协议（D12.3）：srcdoc 会继承宿主 CSP（default-src 'self' → 内联脚本被禁，
 * 设计稿交互与滚动脚本都跑不了），换独立 scheme 由这里只读供稿、带自己的收紧 CSP */
export const DESIGN_SCHEME = 'lcdesign'

/** 预览文档 CSP：网络全禁（防模型生成的 HTML 外联/外泄），仅放行内联样式/脚本与 data 图字 */
export const DESIGN_PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:"

// D12.3 滚动保持：供稿时尾部注入——滚动节流上报父窗口 + 监听恢复指令 + 加载即上报归位。
// iframe sandbox 仍仅 allow-scripts（G10 不动），postMessage 是父子仅有的通道。
const DZ_SCROLL_JS = `<script>(function(){var t=null;addEventListener('scroll',function(){if(t)return;t=setTimeout(function(){t=null;parent.postMessage({t:'dz-scroll',y:scrollY},'*')},120)},{passive:true});addEventListener('message',function(e){var d=e.data;if(d&&d.t==='dz-restore')scrollTo(0,d.y||0)});parent.postMessage({t:'dz-scroll',y:scrollY},'*')})()</script>`

/** lcdesign:// 请求 → 预览 HTML（校验同 DesignRead：裸文件名 + design/ 域内）；失败给占位文档 */
export function designPreviewHtml(urlStr: string): { status: number; body: string } {
  try {
    const u = new URL(urlStr)
    const cwd = u.searchParams.get('cwd') ?? ''
    const file = u.searchParams.get('f') ?? ''
    const { html } = readDesignFile(cwd, file)
    if (html === null) return { status: 404, body: '<!doctype html><p>稿件不存在或超过 2MB</p>' }
    return { status: 200, body: html + DZ_SCROLL_JS }
  } catch {
    return { status: 400, body: '<!doctype html><p>无效预览地址</p>' }
  }
}

/** 裸 html 文件名白名单：拒绝路径分隔、父目录、隐藏文件、非 html */
export function isSafeDesignFile(file: string): boolean {
  if (typeof file !== 'string' || file.length === 0 || file.length > 200) return false
  if (file.includes('/') || file.includes('\\') || file.includes('..')) return false
  if (file.startsWith('.') || file.trim() !== file) return false
  return /\.html$/i.test(file)
}

export function listDesignFiles(cwd: string): { file: string; mtime: number }[] {
  try {
    const dir = join(cwd, 'design')
    if (!existsSync(dir)) return []
    const out: { file: string; mtime: number }[] = []
    for (const f of readdirSync(dir)) {
      if (!isSafeDesignFile(f)) continue
      try {
        const st = statSync(join(dir, f))
        if (st.isFile()) out.push({ file: f, mtime: st.mtimeMs })
      } catch {
        /* 单文件 stat 失败跳过 */
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime)
  } catch {
    return []
  }
}

export function readDesignFile(cwd: string, file: string): { html: string | null; mtime: number | null } {
  const p = designFilePath(cwd, file)
  if (!p) return { html: null, mtime: null }
  try {
    const st = statSync(p)
    if (st.size > MAX_HTML_BYTES) return { html: null, mtime: st.mtimeMs }
    return { html: readFileSync(p, 'utf8'), mtime: st.mtimeMs }
  } catch {
    return { html: null, mtime: null }
  }
}

/** 校验通过且存在才返回绝对路径（浏览器打开/访达定位共用） */
export function designFilePath(cwd: string, file: string): string | null {
  if (!isSafeDesignFile(file)) return null
  const p = join(cwd, 'design', file)
  return existsSync(p) ? p : null
}
