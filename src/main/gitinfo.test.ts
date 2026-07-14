import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gitDiffInfo } from './gitinfo'

const repo = mkdtempSync(join(tmpdir(), 'lc-gitinfo-'))
const plain = mkdtempSync(join(tmpdir(), 'lc-gitinfo-plain-'))

beforeAll(() => {
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', repo, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
  }
  git('init', '-b', 'main')
  git('config', 'user.email', 't@t.local')
  git('config', 'user.name', 't')
  writeFileSync(join(repo, 'a.txt'), 'line1\n')
  git('add', '.')
  git('commit', '-m', 'init')
  writeFileSync(join(repo, 'a.txt'), 'line1-changed\n')
  writeFileSync(join(repo, 'new.txt'), 'untracked\n')
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(plain, { recursive: true, force: true })
})

describe('gitDiffInfo（± 改动面板数据源）', () => {
  it('返回分支/stat/diff/未跟踪文件', async () => {
    const r = await gitDiffInfo(repo)
    expect(r.isRepo).toBe(true)
    expect(r.branch).toBe('main')
    expect(r.stat).toContain('a.txt')
    expect(r.diffText).toContain('-line1')
    expect(r.diffText).toContain('+line1-changed')
    expect(r.untracked).toEqual(['new.txt'])
  })

  it('非 git 目录显式 isRepo=false，不抛错', async () => {
    const r = await gitDiffInfo(plain)
    expect(r.isRepo).toBe(false)
    expect(r.diffText).toBe('')
  })
})
