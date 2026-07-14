// 全屏视觉核对：以 LC_SHOT_PROBE 启动真实应用（真实本机数据），
// main 侧把各屏 PNG 以 base64 打到 stdout，这里解码落盘。
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import electron from 'electron'

const outDir = process.env.SHOT_DIR || '/tmp/lc-shots'
mkdirSync(outDir, { recursive: true })

// LC_SHOT_SCROLL（D12.3 全环路）：预置一份超高设计稿；主进程打 SCROLL_TOUCH 时给它追加注释
// （mtime+内容变化 → 预览重载），跑完清理
const scrollProbe = process.env.LC_SHOT_SCROLL
  ? join(homedir(), 'Desktop', 'design', 'scroll-probe.html')
  : null
if (scrollProbe) {
  mkdirSync(dirname(scrollProbe), { recursive: true })
  writeFileSync(
    scrollProbe,
    '<!doctype html><html><body style="height:300vh;margin:0;background:linear-gradient(#fff,#94a3b8)"><h1 style="padding:24px">scroll probe</h1></body></html>'
  )
}
function cleanupScrollProbe() {
  if (!scrollProbe) return
  try {
    rmSync(scrollProbe, { force: true })
    rmdirSync(dirname(scrollProbe)) // 仅目录为空时移除，不动用户已有稿
  } catch {
    /* 目录非空 = 用户自有设计稿，保留 */
  }
}

const child = spawn(electron, ['.', '--no-sandbox'], {
  env: { ...process.env, LC_SHOT_PROBE: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
})

let buf = ''
child.stdout.on('data', (d) => {
  buf += d
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx)
    buf = buf.slice(idx + 1)
    if (line.startsWith('SHOT:')) {
      const name = line.slice(5, line.indexOf(':', 5))
      const b64 = line.slice(6 + name.length)
      writeFileSync(join(outDir, `${name}.png`), Buffer.from(b64, 'base64'))
      console.log('saved', join(outDir, `${name}.png`))
    }
    if (line.startsWith('SCROLL_TOUCH') && scrollProbe) {
      appendFileSync(scrollProbe, '\n<!-- touch -->')
    }
    if (line.startsWith('SHOTS_DONE')) {
      child.kill('SIGTERM')
      cleanupScrollProbe()
      process.exit(0)
    }
    // 探针的其余打点（如 DOMCOUNTS）原样透传，便于断言
    if (!line.startsWith('SHOT:') && line.trim()) console.log(line)
  }
})

// 默认 40s；带真实定时任务运行的核对（TaskWork e2e）用 SHOT_TIMEOUT_MS 放宽
setTimeout(() => {
  child.kill('SIGTERM')
  cleanupScrollProbe()
  console.error('shot-app: timeout')
  process.exit(1)
}, Number(process.env.SHOT_TIMEOUT_MS ?? 40_000))
