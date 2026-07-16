// D16 学习平台集成：App 负责本地服务生命周期——探测 → 缺则拉起 start.sh → 健康轮询。
// 红线：只 spawn 用户配置目录下的固定脚本名 start.sh（不接受任意命令）；仅回收自己拉起的进程。
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface LearnConfig {
  dir: string
  port: number
}

export interface LearnState {
  status: 'ready' | 'unconfigured' | 'error'
  url: string | null
  message?: string
}

/** settings.learn 原始 JSON → 配置；任何不完整/非法输入一律视为未配置（端口缺省 8989） */
export function parseLearnConfig(raw: string | null | undefined): LearnConfig | null {
  if (!raw) return null
  try {
    const j = JSON.parse(raw) as { dir?: unknown; port?: unknown }
    if (typeof j.dir !== 'string' || !j.dir.trim()) return null
    const port = j.port === undefined || j.port === null || j.port === '' ? 8989 : Number(j.port)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
    return { dir: j.dir.trim(), port }
  } catch {
    return null
  }
}

let child: ChildProcess | null = null

async function probe(port: number, timeoutMs = 1200): Promise<boolean> {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ctl.signal })
    clearTimeout(t)
    return res.ok
  } catch {
    return false
  }
}

export async function ensureLearn(cfg: LearnConfig | null): Promise<LearnState> {
  if (!cfg) return { status: 'unconfigured', url: null }
  const url = `http://127.0.0.1:${cfg.port}`
  // 已在跑（含用户自己起的）→ 直接用，不重复拉起、不接管
  if (await probe(cfg.port)) return { status: 'ready', url }
  const script = join(cfg.dir, 'start.sh')
  if (!existsSync(script)) return { status: 'error', url: null, message: `未找到 ${script}` }
  if (!child || child.exitCode !== null) {
    child = spawn('/bin/bash', [script], { cwd: cfg.dir, stdio: 'ignore' })
  }
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500))
    if (await probe(cfg.port)) return { status: 'ready', url }
  }
  return {
    status: 'error',
    url: null,
    message: '服务 10s 内未就绪：可在终端手动运行 start.sh 查看报错'
  }
}

/** App 退出时回收自己 spawn 的进程（用户自己起的服务不在管辖内） */
export function stopLearn(): void {
  if (child && child.exitCode === null) {
    try {
      child.kill()
    } catch {
      // 进程已消亡则忽略
    }
  }
  child = null
}
