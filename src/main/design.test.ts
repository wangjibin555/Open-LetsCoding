import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { designFilePath, isSafeDesignFile, listDesignFiles, readDesignFile } from './design'

const root = mkdtempSync(join(tmpdir(), 'lc-design-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

mkdirSync(join(root, 'design'))
writeFileSync(join(root, 'design', 'a.html'), '<h1>A</h1>')
writeFileSync(join(root, 'design', '中文稿.html'), '<h1>zh</h1>')
writeFileSync(join(root, 'design', 'note.md'), 'not html')
writeFileSync(join(root, 'design', '.hidden.html'), 'hidden')
writeFileSync(join(root, 'secret.html'), '<h1>outside design/</h1>')

describe('isSafeDesignFile（D11 红线：渲染层不传任意路径）', () => {
  it('裸 html 文件名放行（含中文）', () => {
    expect(isSafeDesignFile('a.html')).toBe(true)
    expect(isSafeDesignFile('中文稿.html')).toBe(true)
    expect(isSafeDesignFile('rail-redesign.html')).toBe(true)
  })

  it('路径穿越/分隔/隐藏/非 html 一律拒绝', () => {
    for (const bad of [
      '../a.html',
      'x/../a.html',
      'sub/a.html',
      'sub\\a.html',
      '..',
      '.hidden.html',
      'a.js',
      'a.html ',
      ' a.html',
      '',
      'a'.repeat(201) + '.html'
    ]) {
      expect(isSafeDesignFile(bad), bad).toBe(false)
    }
  })
})

describe('listDesignFiles / readDesignFile / designFilePath', () => {
  it('仅列 design/ 下合法 html，按 mtime 降序', () => {
    const files = listDesignFiles(root)
    expect(files.map((f) => f.file).sort()).toEqual(['a.html', '中文稿.html'])
    expect(files[0].mtime).toBeGreaterThanOrEqual(files[1].mtime)
    expect(listDesignFiles(join(root, 'nope'))).toEqual([])
  })

  it('读取往返；缺失/穿越返回 null', () => {
    expect(readDesignFile(root, 'a.html')).toMatchObject({ html: '<h1>A</h1>' })
    expect(readDesignFile(root, 'missing.html')).toEqual({ html: null, mtime: null })
    // secret.html 在 design/ 之外——任何写法都够不着
    expect(readDesignFile(root, '../secret.html')).toEqual({ html: null, mtime: null })
    expect(designFilePath(root, '../secret.html')).toBeNull()
    expect(designFilePath(root, 'a.html')).toContain(join('design', 'a.html'))
  })
})
