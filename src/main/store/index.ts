// StateStore（DECISIONS D5 / SPEC §3.3）：App 自有状态，落 App Support 下 SQLite。
// 源数据主权在 ~/.claude（transcript/memory），本库只存装饰与队列。
import Database from 'better-sqlite3'

export interface SessionMeta {
  session_id: string
  group_name: string | null
  pinned: number
  archived: number
  /** M21：cron 报告及其续聊 fork——Code 会话列表不展示 */
  hidden: number
  fallback_note: string | null
}

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'
export type InboxStatus = 'pending' | 'accepted' | 'discarded'

export interface InboxItem {
  id: number
  session_id: string
  cwd: string
  name: string
  type: MemoryType
  description: string
  body: string
  status: InboxStatus
  created_at: string
}

export interface DangerRule {
  id: number
  pattern: string
  enabled: number
  builtin: number
}

/** 整理收件箱（D9）：模型的合并方案，确认前不写盘、不删源。sources 存 JSON 数组文本。 */
export interface ConsolidationItem {
  id: number
  session_id: string
  cwd: string
  name: string
  type: MemoryType
  description: string
  body: string
  sources: string
  rationale: string
  status: InboxStatus
  created_at: string
}

/** 记忆软删回收站（D9）：内容转存 App 自有 SQLite，不在 ~/.claude 建 .trash（D5 红线）。 */
export interface TrashItem {
  id: number
  /** 记忆目录名（cwd 经 slug 化，= 定位键；cwd→slug 不可逆，故直接存 slug） */
  slug: string
  file: string
  name: string
  /** 完整原始文件内容（含 frontmatter），恢复时逐字节写回 */
  content: string
  deleted_at: string
}

/** TaskWork 定时任务（D10）：时间戳一律 epoch ms（INTEGER），due 计算在 cron.ts 纯函数 */
export interface CronJobRow {
  id: number
  name: string
  prompt: string
  cwd: string
  model: string | null
  schedule_kind: string
  schedule_arg: string
  enabled: number
  catch_up: number
  last_run_at: number | null
  created_at: number
}

export interface CronRunRow {
  id: number
  job_id: number
  job_name: string
  session_id: string | null
  started_at: number
  status: string
  summary: string | null
  out_tokens: number | null
  /** 落跑时的 cwd 快照（续聊 resume 用；旧记录为 null → 回退 job.cwd） */
  cwd: string | null
}

export interface CronJobInput {
  id?: number
  name: string
  prompt: string
  cwd: string
  model: string | null
  schedule_kind: string
  schedule_arg: string
  enabled: number
  catch_up: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session_meta (
  session_id TEXT PRIMARY KEY,
  group_name TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  fallback_note TEXT
);
CREATE TABLE IF NOT EXISTS memory_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('user','feedback','project','reference')),
  description TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','discarded')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS danger_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  builtin INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cmd_whitelist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS model_toggles (
  model_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS session_groups (
  name TEXT PRIMARY KEY,
  collapsed INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS memory_trash (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  file TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS cron_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  cwd TEXT NOT NULL,
  model TEXT,
  schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('daily','weekly','hourly')),
  schedule_arg TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  catch_up INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cron_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  session_id TEXT,
  started_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','error')),
  summary TEXT,
  out_tokens INTEGER,
  cwd TEXT
);
CREATE TABLE IF NOT EXISTS consolidation_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('user','feedback','project','reference')),
  description TEXT NOT NULL,
  body TEXT NOT NULL,
  sources TEXT NOT NULL,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','discarded')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`

// DECISIONS D7 危险清单 v1：大范围删除 / git 破坏性操作 / sudo / 部署类 / SSH·远程写。
const BUILTIN_DANGER_PATTERNS = [
  'rm\\s+(-[a-zA-Z]*[rf][a-zA-Z]*)(\\s|$)',
  'git\\s+reset\\s+--hard',
  'git\\s+push\\b.*(--force|-f)\\b',
  '^\\s*sudo\\s+',
  '\\bssh\\b.+\\b(rm|mv|tee|dd|systemctl|service|kill)\\b',
  '\\brsync\\b.+--delete',
  '\\b(kubectl|helm)\\s+(apply|delete|rollout)\\b',
  '\\bterraform\\s+(apply|destroy)\\b'
]

export class StateStore {
  private db: Database.Database

  constructor(dbPath: string) {
    // LC_BS3_BINDING：显式指定 .node 二进制路径（vitest/node 探针用 .cache/bs3 里的 node ABI 副本，
    // 不再与 Electron 争抢 node_modules 里的同一份二进制 —— ABI 切换竞态的根治点）
    const nativeBinding = process.env['LC_BS3_BINDING']
    this.db = nativeBinding ? new Database(dbPath, { nativeBinding }) : new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(SCHEMA)
    this.migrate()
    this.seedBuiltinDangerRules()
  }

  /** 存量库列迁移（SCHEMA 的 IF NOT EXISTS 只管新库）：幂等，缺列才 ALTER */
  private migrate(): void {
    const hasCol = (table: string, col: string): boolean =>
      (this.db.pragma(`table_info(${table})`) as { name: string }[]).some((c) => c.name === col)
    if (!hasCol('session_meta', 'hidden')) {
      // M21 存量迁移：cron 报告不再进 Code 栏——「定时任务」分组（cron.ts 旧 CRON_GROUP_NAME）
      // 整组转隐藏，空组随之删除；此后 cron 会话 init 即标 hidden。
      // 事务化：hasCol 是幂等判据，ALTER 后数据段若因崩溃缺失将永不补跑——三句必须原子
      this.db.transaction(() => {
        this.db.exec('ALTER TABLE session_meta ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0')
        this.db.exec("UPDATE session_meta SET hidden = 1, group_name = NULL WHERE group_name = '定时任务'")
        this.db.exec("DELETE FROM session_groups WHERE name = '定时任务'")
      })()
    }
    if (!hasCol('cron_runs', 'out_tokens')) {
      this.db.exec('ALTER TABLE cron_runs ADD COLUMN out_tokens INTEGER')
    }
    if (!hasCol('cron_runs', 'cwd')) {
      // run 落跑时的 cwd 快照：续聊 resume 必须用会话真实所在目录（任务目录可能事后被改）
      this.db.exec('ALTER TABLE cron_runs ADD COLUMN cwd TEXT')
    }
  }

  private seedBuiltinDangerRules(): void {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO danger_rules (pattern, enabled, builtin) VALUES (?, 1, 1)'
    )
    const tx = this.db.transaction(() => {
      for (const p of BUILTIN_DANGER_PATTERNS) insert.run(p)
    })
    tx()
  }

  // ---- danger rules (D7) ----
  listDangerRules(): DangerRule[] {
    return this.db.prepare('SELECT * FROM danger_rules ORDER BY id').all() as DangerRule[]
  }

  addDangerRule(pattern: string): void {
    const p = pattern.trim()
    if (!p) throw new Error('danger pattern cannot be empty')
    try {
      new RegExp(p)
    } catch {
      throw new Error('danger pattern must be a valid regex')
    }
    this.db
      .prepare('INSERT OR IGNORE INTO danger_rules (pattern, enabled, builtin) VALUES (?, 1, 0)')
      .run(p)
  }

  setDangerRuleEnabled(id: number, enabled: boolean): void {
    const rule = this.db.prepare('SELECT builtin FROM danger_rules WHERE id = ?').get(id) as
      | { builtin: number }
      | undefined
    if (!rule) throw new Error(`danger rule ${id} not found`)
    // DECISIONS D7 负向红线：内置规则不可关闭
    if (rule.builtin === 1 && !enabled) {
      throw new Error('builtin danger rules cannot be disabled (DECISIONS D7)')
    }
    this.db.prepare('UPDATE danger_rules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
  }

  removeDangerRule(id: number): void {
    const rule = this.db.prepare('SELECT builtin FROM danger_rules WHERE id = ?').get(id) as
      | { builtin: number }
      | undefined
    if (!rule) return
    // DECISIONS D7 负向红线：内置规则不可删除
    if (rule.builtin === 1) throw new Error('builtin danger rules cannot be removed (DECISIONS D7)')
    this.db.prepare('DELETE FROM danger_rules WHERE id = ?').run(id)
  }

  // ---- command whitelist (D7) ----
  listWhitelist(): string[] {
    return (this.db.prepare('SELECT pattern FROM cmd_whitelist ORDER BY id').all() as {
      pattern: string
    }[]).map((r) => r.pattern)
  }

  addWhitelist(pattern: string): void {
    const p = pattern.trim()
    // 空串会生成 Bash() 空规则、括号/控制字符会破坏 Bash(...) 规则语法 —— 语义未定义即拒绝（D7 审计补强）
    if (!p) throw new Error('whitelist pattern cannot be empty')
    if (/[()\n\r]/.test(p)) throw new Error('whitelist pattern must not contain parentheses or newlines')
    this.db.prepare('INSERT OR IGNORE INTO cmd_whitelist (pattern) VALUES (?)').run(p)
  }

  removeWhitelist(pattern: string): void {
    this.db.prepare('DELETE FROM cmd_whitelist WHERE pattern = ?').run(pattern)
  }

  // ---- memory inbox (D6) ----
  addInboxItem(item: Omit<InboxItem, 'id' | 'status' | 'created_at'>): number {
    const res = this.db
      .prepare(
        'INSERT INTO memory_inbox (session_id, cwd, name, type, description, body) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(item.session_id, item.cwd, item.name, item.type, item.description, item.body)
    return Number(res.lastInsertRowid)
  }

  getInboxItem(id: number): InboxItem | undefined {
    return this.db.prepare('SELECT * FROM memory_inbox WHERE id = ?').get(id) as
      | InboxItem
      | undefined
  }

  listInbox(status?: InboxStatus): InboxItem[] {
    return status
      ? (this.db
          .prepare('SELECT * FROM memory_inbox WHERE status = ? ORDER BY created_at DESC')
          .all(status) as InboxItem[])
      : (this.db.prepare('SELECT * FROM memory_inbox ORDER BY created_at DESC').all() as InboxItem[])
  }

  setInboxStatus(id: number, status: Exclude<InboxStatus, 'pending'>): InboxItem {
    const item = this.db.prepare('SELECT * FROM memory_inbox WHERE id = ?').get(id) as
      | InboxItem
      | undefined
    if (!item) throw new Error(`inbox item ${id} not found`)
    if (item.status !== 'pending') throw new Error(`inbox item ${id} already ${item.status}`)
    this.db.prepare('UPDATE memory_inbox SET status = ? WHERE id = ?').run(status, id)
    return { ...item, status }
  }

  // ---- memory trash（D9 软删回收站）----
  addTrashItem(item: Omit<TrashItem, 'id' | 'deleted_at'>): number {
    const res = this.db
      .prepare('INSERT INTO memory_trash (slug, file, name, content) VALUES (?, ?, ?, ?)')
      .run(item.slug, item.file, item.name, item.content)
    return Number(res.lastInsertRowid)
  }

  getTrashItem(id: number): TrashItem | undefined {
    return this.db.prepare('SELECT * FROM memory_trash WHERE id = ?').get(id) as TrashItem | undefined
  }

  listTrash(slug?: string): TrashItem[] {
    return slug
      ? (this.db
          .prepare('SELECT * FROM memory_trash WHERE slug = ? ORDER BY deleted_at DESC')
          .all(slug) as TrashItem[])
      : (this.db.prepare('SELECT * FROM memory_trash ORDER BY deleted_at DESC').all() as TrashItem[])
  }

  deleteTrashItem(id: number): void {
    this.db.prepare('DELETE FROM memory_trash WHERE id = ?').run(id)
  }

  // ---- consolidation inbox（D9 整理）----
  addConsolidationItem(
    item: Omit<ConsolidationItem, 'id' | 'status' | 'created_at'>
  ): number {
    const res = this.db
      .prepare(
        'INSERT INTO consolidation_inbox (session_id, cwd, name, type, description, body, sources, rationale) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        item.session_id,
        item.cwd,
        item.name,
        item.type,
        item.description,
        item.body,
        item.sources,
        item.rationale
      )
    return Number(res.lastInsertRowid)
  }

  getConsolidationItem(id: number): ConsolidationItem | undefined {
    return this.db.prepare('SELECT * FROM consolidation_inbox WHERE id = ?').get(id) as
      | ConsolidationItem
      | undefined
  }

  listConsolidation(status?: InboxStatus): ConsolidationItem[] {
    return status
      ? (this.db
          .prepare('SELECT * FROM consolidation_inbox WHERE status = ? ORDER BY created_at DESC')
          .all(status) as ConsolidationItem[])
      : (this.db
          .prepare('SELECT * FROM consolidation_inbox ORDER BY created_at DESC')
          .all() as ConsolidationItem[])
  }

  setConsolidationStatus(id: number, status: Exclude<InboxStatus, 'pending'>): void {
    const item = this.getConsolidationItem(id)
    if (!item) throw new Error(`consolidation item ${id} not found`)
    if (item.status !== 'pending') throw new Error(`consolidation item ${id} already ${item.status}`)
    this.db.prepare('UPDATE consolidation_inbox SET status = ? WHERE id = ?').run(status, id)
  }

  // ---- session decorations (D5) ----
  upsertSessionMeta(meta: SessionMeta): void {
    this.db
      .prepare(
        `INSERT INTO session_meta (session_id, group_name, pinned, archived, hidden, fallback_note)
         VALUES (@session_id, @group_name, @pinned, @archived, @hidden, @fallback_note)
         ON CONFLICT(session_id) DO UPDATE SET
           group_name = excluded.group_name, pinned = excluded.pinned,
           archived = excluded.archived, hidden = excluded.hidden,
           fallback_note = excluded.fallback_note`
      )
      .run(meta)
  }

  getSessionMeta(sessionId: string): SessionMeta | undefined {
    return this.db.prepare('SELECT * FROM session_meta WHERE session_id = ?').get(sessionId) as
      | SessionMeta
      | undefined
  }

  // ---- session groups（自定义命名分组，参照 Claude Code 交互）----
  listGroups(): { name: string; collapsed: number; sort_order: number }[] {
    return this.db
      .prepare('SELECT * FROM session_groups ORDER BY sort_order, name')
      .all() as { name: string; collapsed: number; sort_order: number }[]
  }

  createGroup(name: string): void {
    const n = name.trim()
    if (!n) throw new Error('group name cannot be empty')
    const max = this.db.prepare('SELECT COALESCE(MAX(sort_order),0) m FROM session_groups').get() as {
      m: number
    }
    this.db
      .prepare('INSERT OR IGNORE INTO session_groups (name, sort_order) VALUES (?, ?)')
      .run(n, max.m + 1)
  }

  renameGroup(oldName: string, newName: string): void {
    const n = newName.trim()
    if (!n) throw new Error('group name cannot be empty')
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE session_groups SET name = ? WHERE name = ?').run(n, oldName)
      this.db.prepare('UPDATE session_meta SET group_name = ? WHERE group_name = ?').run(n, oldName)
    })
    tx()
  }

  deleteGroup(name: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM session_groups WHERE name = ?').run(name)
      this.db.prepare('UPDATE session_meta SET group_name = NULL WHERE group_name = ?').run(name)
    })
    tx()
  }

  setGroupCollapsed(name: string, collapsed: boolean): void {
    this.db
      .prepare('UPDATE session_groups SET collapsed = ? WHERE name = ?')
      .run(collapsed ? 1 : 0, name)
  }

  deleteSessionMeta(sessionId: string): void {
    this.db.prepare('DELETE FROM session_meta WHERE session_id = ?').run(sessionId)
  }

  // ---- model toggles (D8：路由表启停，仅影响新会话可选清单) ----
  disabledModels(): Set<string> {
    const rows = this.db
      .prepare('SELECT model_id FROM model_toggles WHERE enabled = 0')
      .all() as { model_id: string }[]
    return new Set(rows.map((r) => r.model_id))
  }

  setModelEnabled(modelId: string, enabled: boolean): void {
    this.db
      .prepare(
        'INSERT INTO model_toggles (model_id, enabled) VALUES (?, ?) ON CONFLICT(model_id) DO UPDATE SET enabled = excluded.enabled'
      )
      .run(modelId, enabled ? 1 : 0)
  }

  // ---- TaskWork 定时任务（D10）----
  listCronJobs(): CronJobRow[] {
    return this.db.prepare('SELECT * FROM cron_jobs ORDER BY id').all() as CronJobRow[]
  }

  getCronJob(id: number): CronJobRow | undefined {
    return this.db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(id) as CronJobRow | undefined
  }

  /** 新建返回新 id；更新（带 id）不触碰 last_run_at/created_at */
  saveCronJob(input: CronJobInput, nowMs: number): number {
    if (!input.name.trim()) throw new Error('任务名称不能为空')
    if (!input.prompt.trim()) throw new Error('任务指令不能为空')
    if (!input.cwd.trim()) throw new Error('任务目录不能为空')
    if (input.id !== undefined) {
      const res = this.db
        .prepare(
          `UPDATE cron_jobs SET name = ?, prompt = ?, cwd = ?, model = ?,
             schedule_kind = ?, schedule_arg = ?, enabled = ?, catch_up = ? WHERE id = ?`
        )
        .run(
          input.name.trim(),
          input.prompt,
          input.cwd.trim(),
          input.model,
          input.schedule_kind,
          input.schedule_arg,
          input.enabled,
          input.catch_up,
          input.id
        )
      if (res.changes === 0) throw new Error(`定时任务 ${input.id} 不存在`)
      return input.id
    }
    const res = this.db
      .prepare(
        `INSERT INTO cron_jobs (name, prompt, cwd, model, schedule_kind, schedule_arg, enabled, catch_up, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.name.trim(),
        input.prompt,
        input.cwd.trim(),
        input.model,
        input.schedule_kind,
        input.schedule_arg,
        input.enabled,
        input.catch_up,
        nowMs
      )
    return Number(res.lastInsertRowid)
  }

  deleteCronJob(id: number): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM cron_runs WHERE job_id = ?').run(id)
      this.db.prepare('DELETE FROM cron_jobs WHERE id = ?').run(id)
    })
    tx()
  }

  setCronJobEnabled(id: number, enabled: boolean): void {
    this.db.prepare('UPDATE cron_jobs SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
  }

  /** 错过且不补跑：推进 last_run_at 跳过本次，避免过期 due 永久悬挂 */
  touchCronJob(id: number, nowMs: number): void {
    this.db.prepare('UPDATE cron_jobs SET last_run_at = ? WHERE id = ?').run(nowMs, id)
  }

  /** 开跑：置 last_run_at + 插入 running 记录（同事务），返回 runId */
  startCronRun(jobId: number, nowMs: number, cwd: string | null = null): number {
    let runId = 0
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE cron_jobs SET last_run_at = ? WHERE id = ?').run(nowMs, jobId)
      const res = this.db
        .prepare('INSERT INTO cron_runs (job_id, started_at, cwd) VALUES (?, ?, ?)')
        .run(jobId, nowMs, cwd)
      runId = Number(res.lastInsertRowid)
    })
    tx()
    return runId
  }

  setCronRunSession(runId: number, sessionId: string): void {
    this.db.prepare('UPDATE cron_runs SET session_id = ? WHERE id = ?').run(sessionId, runId)
  }

  /** 收尾只对 running 生效（幂等：result 之后的 closed 事件自然 no-op） */
  finishCronRun(runId: number, status: 'ok' | 'error', summary: string | null, outTokens?: number): void {
    this.db
      .prepare(
        "UPDATE cron_runs SET status = ?, summary = ?, out_tokens = ? WHERE id = ? AND status = 'running'"
      )
      .run(status, summary, outTokens ?? null, runId)
  }

  getCronRun(runId: number): CronRunRow | undefined {
    return this.db
      .prepare(
        `SELECT r.id, r.job_id, j.name AS job_name, r.session_id, r.started_at, r.status, r.summary, r.out_tokens, r.cwd
         FROM cron_runs r JOIN cron_jobs j ON j.id = r.job_id WHERE r.id = ?`
      )
      .get(runId) as CronRunRow | undefined
  }

  listCronRuns(jobId: number | null, limit: number): CronRunRow[] {
    const sql = `SELECT r.id, r.job_id, j.name AS job_name, r.session_id, r.started_at, r.status, r.summary, r.out_tokens, r.cwd
       FROM cron_runs r JOIN cron_jobs j ON j.id = r.job_id
       ${jobId !== null ? 'WHERE r.job_id = ?' : ''} ORDER BY r.started_at DESC LIMIT ?`
    return (jobId !== null
      ? this.db.prepare(sql).all(jobId, limit)
      : this.db.prepare(sql).all(limit)) as CronRunRow[]
  }

  // ---- settings（不含任何密钥明文，密钥走 SecretVault，D8）----
  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value)
  }

  close(): void {
    this.db.close()
  }
}
