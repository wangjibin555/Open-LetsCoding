// MemoryService（DECISIONS D6 / D9）：记忆文件的唯一写盘 / 编辑 / 删除路径。
// 红线：确认前不写盘；模型 / 沉淀 / 整理路径永不碰既有文件；仅用户显式 UI 操作可编辑或软删。
// 软删 = 内容转存 App 自有 SQLite 回收站（D5：不在 ~/.claude 下建 .trash 目录），可恢复。
// verify.sh G7 静态断言：src/main 下对文件系统的写 / 删仅允许本文件与 store/secrets.ts。
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import type { MemoryType, StateStore, InboxItem } from './store'

export interface MemoryFileInfo {
  file: string
  name: string
  description: string
  type: string
  body: string
  scope: string
  /** 记忆目录名（定位键，编辑/删除回传） */
  slug: string
  mtime: number
}

export interface TrashFileInfo {
  id: number
  slug: string
  file: string
  name: string
  description: string
  deletedAt: string
}

/** 编辑记忆的可改字段（D9：不含 name——改名=重命名+重写索引，风险高，本期不做） */
export interface MemoryPatch {
  description?: string
  type?: MemoryType
  body?: string
}

/** 整理收件箱条目（D9）：模型的合并方案，供 UI 逐条确认 */
export interface ConsolidationInboxInfo {
  id: number
  cwd: string
  name: string
  type: string
  description: string
  body: string
  sources: string[]
  rationale: string
  createdAt: string
}

function cwdSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export class MemoryService {
  constructor(
    private readonly projectsDir: string,
    private readonly store: StateStore
  ) {}

  memoryDir(cwd: string): string {
    return join(this.projectsDir, cwdSlug(cwd), 'memory')
  }

  private memoryDirBySlug(slug: string): string {
    return join(this.projectsDir, slug, 'memory')
  }

  /**
   * 校验 slug/file 均安全并返回绝对路径，杜绝路径穿越（D9/D5 边界）。
   * slug 为 cwd 的 slug 化结果，合法字符仅 [A-Za-z0-9-]；file 必须是同目录 .md 文件名（非 MEMORY.md）。
   * 双保险：解析后仍须落在 projectsDir 内。渲染层经 IPC 传入的坐标一律先过此关。
   */
  private safeMemoryFile(slug: string, file: string): { dir: string; filePath: string } {
    if (!/^[A-Za-z0-9-]+$/.test(slug)) throw new Error(`非法记忆目录：${slug}`)
    if (file !== basename(file) || !file.endsWith('.md') || file === 'MEMORY.md') {
      throw new Error(`非法记忆文件名：${file}`)
    }
    const dir = this.memoryDirBySlug(slug)
    const filePath = join(dir, file)
    const root = resolve(this.projectsDir) + sep
    if (!resolve(filePath).startsWith(root)) throw new Error(`记忆路径越界：${file}`)
    return { dir, filePath }
  }

  /** 唯一写盘路径：校验在前、写盘在中、状态翻转在后（写失败不留下 accepted 假状态） */
  accept(id: number): { filePath: string } {
    const item = this.store.getInboxItem(id)
    if (!item) throw new Error(`inbox item ${id} not found`)
    if (item.status !== 'pending') throw new Error(`inbox item ${id} already ${item.status}`)

    const dir = this.memoryDir(item.cwd)
    const filePath = join(dir, `${item.name}.md`)
    if (existsSync(filePath)) {
      throw new Error(`同名记忆已存在：${item.name}.md（请丢弃本条或改名后重新沉淀）`)
    }

    mkdirSync(dir, { recursive: true })
    writeFileSync(filePath, renderMemoryFile(item))
    this.updateIndex(dir, item)
    this.store.setInboxStatus(id, 'accepted')
    return { filePath }
  }

  discard(id: number): void {
    this.store.setInboxStatus(id, 'discarded')
  }

  /**
   * 编辑既有记忆（D9，用户显式操作）：仅改 body/description/type，name 与文件名不变。
   * description 变更同步 MEMORY.md 索引行。
   */
  updateMemory(slug: string, file: string, patch: MemoryPatch): void {
    const { dir, filePath } = this.safeMemoryFile(slug, file)
    if (!existsSync(filePath)) throw new Error(`记忆文件不存在：${file}`)
    const text = readFileSync(filePath, 'utf8')
    const name = matchFm(text, 'name') ?? file.replace(/\.md$/, '')
    const bodyStart = text.indexOf('---', text.indexOf('---') + 3)
    const merged: Pick<InboxItem, 'name' | 'description' | 'type' | 'body'> = {
      name,
      description: patch.description ?? matchFm(text, 'description') ?? '',
      type: patch.type ?? ((matchFm(text, 'type') as MemoryType | null) ?? 'reference'),
      body: patch.body ?? (bodyStart >= 0 ? text.slice(bodyStart + 3).trim() : text.trim())
    }
    writeFileSync(filePath, renderMemoryFile(merged))
    this.setIndexLine(dir, name, merged.description)
  }

  /**
   * 软删（D9，可恢复）：内容转存 SQLite 回收站 → 删原文件 → 移除索引行。
   * 不在 ~/.claude 下建 .trash（D5 红线）。
   */
  softDeleteMemory(slug: string, file: string): { trashId: number } {
    const { dir, filePath } = this.safeMemoryFile(slug, file)
    if (!existsSync(filePath)) throw new Error(`记忆文件不存在：${file}`)
    const content = readFileSync(filePath, 'utf8')
    const name = matchFm(content, 'name') ?? file.replace(/\.md$/, '')
    const trashId = this.store.addTrashItem({ slug, file, name, content })
    try {
      unlinkSync(filePath)
    } catch (err) {
      this.store.deleteTrashItem(trashId) // 删文件失败则回滚回收站条目，不留孤儿
      throw err
    }
    this.removeIndexLine(dir, name)
    return { trashId }
  }

  /** 从回收站恢复（D9）：写回原路径 + 恢复索引 + 清回收站条目；同名已存在则拒绝 */
  restoreMemory(trashId: number): { filePath: string } {
    const item = this.store.getTrashItem(trashId)
    if (!item) throw new Error(`回收站条目 ${trashId} 不存在`)
    // 纵深防御：回收站坐标同样过边界校验，恢复不做越界写
    const { dir, filePath } = this.safeMemoryFile(item.slug, item.file)
    if (existsSync(filePath)) {
      throw new Error(`同名记忆已存在，无法恢复：${item.file}（请先处理现有文件）`)
    }
    mkdirSync(dir, { recursive: true })
    writeFileSync(filePath, item.content)
    this.setIndexLine(dir, item.name, matchFm(item.content, 'description') ?? '')
    this.store.deleteTrashItem(trashId)
    return { filePath }
  }

  /** 回收站列表（供 UI 恢复）；content 只在恢复时用，列表仅回摘要 */
  listTrash(cwd: string | null): TrashFileInfo[] {
    return this.store.listTrash(cwd ? cwdSlug(cwd) : undefined).map((t) => ({
      id: t.id,
      slug: t.slug,
      file: t.file,
      name: t.name,
      description: matchFm(t.content, 'description') ?? '',
      deletedAt: t.deleted_at
    }))
  }

  /** 整理收件箱（D9）：待确认的合并方案，按 cwd 过滤 */
  listConsolidation(cwd: string | null): ConsolidationInboxInfo[] {
    const items = this.store.listConsolidation('pending')
    return items
      .filter((i) => (cwd ? i.cwd === cwd : true))
      .map((i) => ({
        id: i.id,
        cwd: i.cwd,
        name: i.name,
        type: i.type,
        description: i.description,
        body: i.body,
        sources: safeParseSources(i.sources),
        rationale: i.rationale,
        createdAt: i.created_at
      }))
  }

  /**
   * 确认合并方案（D9，用户逐条确认后的唯一落盘/软删点）：
   * 校验所有源存在 → 软删所有源（可恢复）→ 写合并结果 + 索引。
   * 源已变动 / 目标名与无关记忆冲突 → 拒绝，不动任何文件。
   */
  acceptConsolidation(id: number): { filePath: string } {
    const item = this.store.getConsolidationItem(id)
    if (!item) throw new Error(`整理条目 ${id} 不存在`)
    if (item.status !== 'pending') throw new Error(`整理条目 ${id} 已${item.status}`)

    const slug = cwdSlug(item.cwd)
    const sources = safeParseSources(item.sources)
    if (sources.length < 2) throw new Error('整理需至少两条源记忆')

    // 校验所有源合法且仍存在（记忆在整理期间被改动则拒绝，避免误删/漂移）
    for (const src of sources) {
      const { filePath } = this.safeMemoryFile(slug, src)
      if (!existsSync(filePath)) {
        throw new Error(`源记忆已不存在：${src}（记忆可能已改动，请丢弃本条重新整理）`)
      }
    }
    const newFile = `${item.name}.md`
    const { dir, filePath: newPath } = this.safeMemoryFile(slug, newFile)
    // 目标名撞到不在合并列表里的既有记忆 → 拒绝（不覆盖无关文件）
    if (existsSync(newPath) && !sources.includes(newFile)) {
      throw new Error(`合并目标名与既有记忆冲突：${newFile}（改名或丢弃本条）`)
    }

    // 先软删所有源（可从回收站恢复），再写合并结果——顺序保证目标名与某源相同时路径已空出
    for (const src of sources) this.softDeleteMemory(slug, src)
    writeFileSync(
      newPath,
      renderMemoryFile({
        name: item.name,
        description: item.description,
        type: item.type,
        body: item.body
      })
    )
    this.setIndexLine(dir, item.name, item.description)
    this.store.setConsolidationStatus(id, 'accepted')
    return { filePath: newPath }
  }

  discardConsolidation(id: number): void {
    this.store.setConsolidationStatus(id, 'discarded')
  }

  /** 读取某目录已落盘的记忆（frontmatter 摘要 + 正文），供记忆库 UI 展示 */
  listMemories(cwd: string): MemoryFileInfo[] {
    const slug = cwdSlug(cwd)
    return readMemoryDir(this.memoryDirBySlug(slug), cwd.split('/').filter(Boolean).pop() ?? cwd, slug)
  }

  /** 扫描 projects 下所有目录的记忆（记忆库「全部项目」视图，只读） */
  listAllMemories(): MemoryFileInfo[] {
    if (!existsSync(this.projectsDir)) return []
    const out: MemoryFileInfo[] = []
    for (const slug of readdirSync(this.projectsDir)) {
      const dir = join(this.projectsDir, slug, 'memory')
      const scope = slug.replace(/^-Users-[^-]+-?/, '') || slug
      try {
        out.push(...readMemoryDir(dir, scope, slug))
      } catch {
        /* 单个项目目录读失败不影响整体 */
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime)
  }

  private updateIndex(dir: string, item: InboxItem): void {
    const indexPath = join(dir, 'MEMORY.md')
    const line = `- [${item.name}](${item.name}.md) — ${item.description}`
    let content = existsSync(indexPath)
      ? readFileSync(indexPath, 'utf8')
      : '# Memory Index\n\n'
    if (content.includes(`](${item.name}.md)`)) return
    if (!content.endsWith('\n')) content += '\n'
    writeFileSync(indexPath, content + line + '\n')
  }

  /** upsert 索引行（编辑/恢复用）：存在则替换该行，否则追加 */
  private setIndexLine(dir: string, name: string, description: string): void {
    const indexPath = join(dir, 'MEMORY.md')
    const line = `- [${name}](${name}.md) — ${description}`
    const re = new RegExp(`^- \\[[^\\]]*\\]\\(${escapeRegex(name)}\\.md\\).*$`, 'm')
    let content = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '# Memory Index\n\n'
    if (re.test(content)) {
      content = content.replace(re, line)
    } else {
      if (!content.endsWith('\n')) content += '\n'
      content += line + '\n'
    }
    writeFileSync(indexPath, content)
  }

  /** 移除索引行（软删用） */
  private removeIndexLine(dir: string, name: string): void {
    const indexPath = join(dir, 'MEMORY.md')
    if (!existsSync(indexPath)) return
    const re = new RegExp(`^- \\[[^\\]]*\\]\\(${escapeRegex(name)}\\.md\\).*\\n?`, 'm')
    writeFileSync(indexPath, readFileSync(indexPath, 'utf8').replace(re, ''))
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 解析整理条目的 sources JSON；容错为字符串数组（file 合法性由 safeMemoryFile 把关） */
function safeParseSources(json: string): string[] {
  try {
    const arr = JSON.parse(json)
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function renderMemoryFile(item: Pick<InboxItem, 'name' | 'description' | 'type' | 'body'>): string {
  return [
    '---',
    `name: ${item.name}`,
    `description: ${item.description}`,
    'metadata:',
    `  type: ${item.type}`,
    '---',
    '',
    item.body.trimEnd(),
    ''
  ].join('\n')
}

function matchFm(text: string, key: string): string | null {
  const m = new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm').exec(text)
  return m ? m[1].trim() : null
}

function readMemoryDir(dir: string, scope: string, slug: string): MemoryFileInfo[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
    .map((f) => {
      const path = join(dir, f)
      const text = readFileSync(path, 'utf8')
      const bodyStart = text.indexOf('---', text.indexOf('---') + 3)
      return {
        file: f,
        name: matchFm(text, 'name') ?? f.replace(/\.md$/, ''),
        description: matchFm(text, 'description') ?? '',
        type: matchFm(text, 'type') ?? 'reference',
        body: bodyStart >= 0 ? text.slice(bodyStart + 3).trim() : text.trim(),
        scope,
        slug,
        mtime: statSync(path).mtimeMs
      }
    })
}
