// 会话工具栏「± 改动」的数据源：对会话 cwd 只读执行 git 命令，
// 汇总分支/变更统计/完整 diff（截断保护）/未跟踪文件。非 git 目录显式返回 isRepo=false。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitDiffResult } from '../shared/ipc'

const run = promisify(execFile)
const MAX_DIFF_CHARS = 200_000

export async function gitDiffInfo(cwd: string): Promise<GitDiffResult> {
  try {
    const { stdout: branch } = await run('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'])
    const opts = { maxBuffer: 8 * 1024 * 1024 }
    const [{ stdout: stat }, { stdout: diff }, { stdout: untracked }] = await Promise.all([
      run('git', ['-C', cwd, 'diff', 'HEAD', '--stat'], opts),
      run('git', ['-C', cwd, 'diff', 'HEAD'], opts),
      run('git', ['-C', cwd, 'ls-files', '--others', '--exclude-standard'], opts)
    ])
    return {
      isRepo: true,
      branch: branch.trim(),
      stat: stat.trimEnd(),
      diffText:
        diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… （diff 过长已截断）` : diff,
      untracked: untracked.split('\n').filter(Boolean).slice(0, 100)
    }
  } catch {
    return { isRepo: false, stat: '', diffText: '', untracked: [] }
  }
}
