// IPC 通道契约的单一来源（SPEC §3.1）。memory/spend 通道随 M4/M5 扩展。
export const Channels = {
  AppPing: 'app:ping',
  SessionCreate: 'session:create',
  SessionSend: 'session:send',
  SessionInterrupt: 'session:interrupt',
  SessionSetModel: 'session:setModel',
  SessionSetMode: 'session:setMode',
  SessionClose: 'session:close',
  SessionList: 'session:list',
  SessionReplay: 'session:replay',
  SessionSubagents: 'session:subagents',
  SessionSetMeta: 'session:setMeta',
  SessionRename: 'session:rename',
  SessionDelete: 'session:delete',
  GroupList: 'group:list',
  GroupCreate: 'group:create',
  GroupRename: 'group:rename',
  GroupDelete: 'group:delete',
  GroupCollapse: 'group:collapse',
  CtxInfo: 'ctx:info',
  CustomizeInfo: 'customize:info',
  CustomizeBind: 'customize:bind',
  ConnectorsStatus: 'customize:connectors',
  SessionTasks: 'session:tasks',
  SessionTranscriptPath: 'session:transcript-path',
  DesignList: 'design:list',
  DesignRead: 'design:read',
  DesignOpen: 'design:open',
  CronJobList: 'cron:jobs',
  CronJobSave: 'cron:save',
  CronJobDelete: 'cron:delete',
  CronJobToggle: 'cron:toggle',
  CronJobRunNow: 'cron:run-now',
  CronRunsList: 'cron:runs',
  SessionStream: 'session:stream', // M→R 推送
  PermRequest: 'perm:request', // M→R 推送
  PermRespond: 'perm:respond',
  ModelsList: 'models:list',
  ModelToggle: 'models:toggle',
  SpendSummary: 'spend:summary',
  MemoryInboxList: 'memory:inbox:list',
  MemoryInboxAccept: 'memory:inbox:accept',
  MemoryInboxDiscard: 'memory:inbox:discard',
  MemoryList: 'memory:list',
  MemoryUpdate: 'memory:update',
  MemoryDelete: 'memory:delete',
  MemoryTrashList: 'memory:trash:list',
  MemoryRestore: 'memory:restore',
  MemoryConsolidateStart: 'memory:consolidate:start',
  ConsolidationList: 'memory:consolidate:list',
  ConsolidationAccept: 'memory:consolidate:accept',
  ConsolidationDiscard: 'memory:consolidate:discard',
  DangerList: 'danger:list',
  DangerAdd: 'danger:add',
  DangerToggle: 'danger:toggle',
  DangerRemove: 'danger:remove',
  WhitelistList: 'whitelist:list',
  WhitelistAdd: 'whitelist:add',
  WhitelistRemove: 'whitelist:remove',
  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',
  SecretSet: 'secret:set',
  SecretStatus: 'secret:status',
  GatewayTest: 'gateway:test',
  ShellReveal: 'shell:reveal',
  ShellOpenUrl: 'shell:open-url',
  ShellTerminal: 'shell:terminal',
  GitDiff: 'git:diff',
  DialogPickDir: 'dialog:pick-dir',
  LearnEnsure: 'learn:ensure'
} as const

/** live 会话 handle 前缀 → 所属模式（cron-=TaskWork、design-=Design，其余=Code）；主/渲染两侧共用 */
export const CRON_HANDLE_PREFIX = 'cron-'
export const DESIGN_HANDLE_PREFIX = 'design-'
/** TaskWork 报告续聊（M21）：`cronchat-<runId>-<ts>`——main 依前缀把 fork 会话回绑 run 并标 hidden */
export const CRONCHAT_HANDLE_PREFIX = 'cronchat-'

export interface GitDiffResult {
  isRepo: boolean
  branch?: string
  /** git diff HEAD --stat 输出 */
  stat: string
  /** 完整 diff 文本（超长截断） */
  diffText: string
  /** 未跟踪文件（上限 100 条） */
  untracked: string[]
}

export interface SubagentStepDto {
  t: 'text' | 'tool'
  label: string
}

export interface SubagentInfoDto {
  description: string
  agentType: string
  steps: SubagentStepDto[]
}

export interface AppPingResult {
  app: string
  version: string
  storeReady: boolean
}

export type UiPermissionMode = 'confirm-each' | 'plan-first' | 'auto' | 'bypass'

export interface ImageAttachmentDto {
  /** e.g. image/png */
  media_type: string
  /** base64（不带 data: 前缀） */
  data: string
}

export interface CreateSessionPayload {
  handle: string
  cwd: string
  model: string
  uiMode: UiPermissionMode
  resume?: string
  firstPrompt: string
  images?: ImageAttachmentDto[]
}

export interface SessionMetaPatch {
  sessionId: string
  group_name?: string | null
  pinned?: boolean
  archived?: boolean
  /** M21：cron 报告与其续聊 fork 标隐藏——Code 会话列表不展示，仅 TaskWork 页内可见 */
  hidden?: boolean
}

/** listSessions ⋈ SQLite 装饰 ⋈ live 状态 */
export interface SessionListEntry {
  sessionId: string
  summary: string
  lastModified: number
  createdAt?: number
  cwd?: string
  gitBranch?: string
  firstPrompt?: string
  customTitle?: string
  groupName: string | null
  pinned: boolean
  archived: boolean
  live?: { handle: string; model: string; uiMode: UiPermissionMode }
}

export interface StreamEventPayload {
  handle: string
  msg: unknown
}

export interface PermissionRequestPayload {
  requestId: string
  handle: string
  toolName: string
  input: Record<string, unknown>
  reason: 'prompt' | 'danger_list'
  dangerPattern?: string
  decisionReason?: string
  hasSuggestions: boolean
}

export interface PermRespondPayload {
  requestId: string
  allow: boolean
  /** 总是允许（仅本会话；危险命令永远不可用） */
  always?: boolean
  message?: string
}

export interface DangerRuleDto {
  id: number
  pattern: string
  enabled: boolean
  builtin: boolean
}

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

export interface InboxItemDto {
  id: number
  session_id: string
  cwd: string
  name: string
  type: MemoryType
  description: string
  body: string
  status: 'pending' | 'accepted' | 'discarded'
  created_at: string
}

export interface MemoryFileDto {
  file: string
  name: string
  description: string
  type: string
  /** frontmatter 之后的正文（记忆库详情栏展示用） */
  body: string
  /** 归属目录短标签（当前目录名 / 项目 slug） */
  scope: string
  /** 记忆目录名（编辑/删除定位键） */
  slug: string
  mtime: number
}

/** 编辑记忆（D9）：只改 body/description/type，不改 name */
export interface MemoryUpdatePayload {
  slug: string
  file: string
  description?: string
  type?: MemoryType
  body?: string
}

/** 回收站条目（D9 软删，可恢复） */
export interface TrashItemDto {
  id: number
  slug: string
  file: string
  name: string
  description: string
  deletedAt: string
}

/** 整理收件箱条目（D9 consolidate）：模型的合并方案，逐条确认 */
export interface ConsolidationItemDto {
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

/** 「在 Finder 打开」的目标（main 侧解析真实路径，渲染层不传任意路径）；transcript 额外带 sessionId，design 额外带裸文件名 */
export type RevealTarget = 'claude-root' | 'projects' | 'memory' | 'transcript' | 'design'

export interface ModelInfoDto {
  id: string
  enabled: boolean
}

export interface SpendInfoDto {
  available: boolean
  spendUsd: number | null
  reason?: string
}

export interface GroupDto {
  name: string
  collapsed: boolean
}

export interface SkillInfoDto {
  name: string
  description: string
  scope: 'user' | 'project'
}

/** 已安装插件（~/.claude/plugins 只读扫描） */
export interface PluginInfoDto {
  name: string
  marketplace: string
  version: string
  description: string
  /** marketplace 的 GitHub 仓库外链（source=github 时） */
  repoUrl: string | null
  skillCount: number
}

/** CLI 连接状态（gh / glab，本机凭证只读探测） */
export interface CliAuthDto {
  installed: boolean
  authed: boolean
  account: string | null
}

/** 「自定义」弹窗数据（本地扫描，秒回）；连接器状态走 ConnectorsStatus 异步补 */
export interface CustomizeInfoDto {
  skills: SkillInfoDto[]
  plugins: PluginInfoDto[]
}

/** 连接器状态（gh/glab 远端探测，可能数秒） */
export interface ConnectorsStatusDto {
  gh: CliAuthDto
  glab: CliAuthDto
}

/** Design 模式（D11）：design/*.html 只读扫描；file 一律为裸文件名（渲染层不传任意路径） */
export interface DesignFileDto {
  file: string
  mtime: number
}

export interface DesignReadDto {
  /** 文件缺失/超大/被拒时 null */
  html: string | null
  mtime: number | null
}

/** TaskWork 定时任务（D10）：三种周期，不暴露 cron 表达式 */
export type CronScheduleKind = 'daily' | 'weekly' | 'hourly'

export interface CronJobDto {
  id: number
  name: string
  prompt: string
  cwd: string
  /** null = 跟随默认模型 */
  model: string | null
  scheduleKind: CronScheduleKind
  /** daily:'HH:MM' ｜ weekly:'周几(1-7),HH:MM' ｜ hourly:'N' */
  scheduleArg: string
  enabled: boolean
  /** App 关闭错过时段 → 再次拉起补跑一次 */
  catchUp: boolean
  lastRunAt: number | null
  /** 由 main 侧按 last_run_at/created_at 计算；停用时为 null */
  nextDueAt: number | null
}

export interface CronJobSavePayload {
  /** 缺省 = 新建 */
  id?: number
  name: string
  prompt: string
  cwd: string
  model: string | null
  scheduleKind: CronScheduleKind
  scheduleArg: string
  enabled: boolean
  catchUp: boolean
}

/** 定时任务运行记录（报告 = 会话，TaskWork 页内回放/live/续聊） */
export interface CronRunDto {
  id: number
  jobId: number
  jobName: string
  sessionId: string | null
  startedAt: number
  status: 'running' | 'ok' | 'error'
  summary: string | null
  /** 本次运行输出 tokens（result usage；旧记录/异常为 null） */
  outTokens: number | null
  /** 落跑时的 cwd 快照——续聊 resume 必须用它（任务目录可能事后被改）；旧记录 null → 回退 job.cwd */
  cwd: string | null
}

/** Claude Code 待办（~/.claude/tasks/<sessionId>/ 只读） */
export interface SessionTaskDto {
  id: string
  subject: string
  status: string
  activeForm: string | null
}

/** 右栏 .claude 上下文（设计稿三栏之右栏，D0） */
export interface CtxInfoDto {
  globalClaudeMd: boolean
  projectClaudeMd: boolean
  decisionsMd: boolean
  memoryCount: number
  /** ~/.claude/skills/ 与 <cwd>/.claude/skills/ 下的技能（只读扫描；会话内以 init.skills 为真值） */
  skills: SkillInfoDto[]
}

export interface AppSettings {
  baseUrl: string | null
  defaultModel: string | null
  smallFastModel: string | null
  /** 上次活跃的会话（应用重开时自动回到这里，会话连续性） */
  lastSessionId: string | null
  /** 面板布局偏好 JSON（左右栏宽度/隐藏态；D5：UI 设置落 state.db） */
  panelLayout: string | null
  /** 外观偏好 JSON（背景预设/缩放/卡片字号；D5 同上） */
  appearance: string | null
  /** 设计稿 ↔ 会话映射 JSON（D11：`${cwd}::${file}` → sessionId，按稿绑对话） */
  designSessions: string | null
  /** 学习平台配置 JSON（D16：{dir, port}；默认空——个人路径只进本机库不入仓） */
  learn: string | null
}

/** D16 学习平台服务状态（main 探测/拉起后回报） */
export interface LearnStateDto {
  status: 'ready' | 'unconfigured' | 'error'
  /** ready 时为 http://127.0.0.1:<port>（渲染层仅据此取端口，不接受任意地址） */
  url: string | null
  message?: string
}

export interface SecretStatusResult {
  encryptionAvailable: boolean
  gatewayKeySet: boolean
}

export interface GatewayTestResult {
  ok: boolean
  latencyMs: number
  modelCount: number
  error?: string
}

export interface ReplayMessage {
  type: 'user' | 'assistant' | 'system'
  uuid: string
  message: unknown
  parent_tool_use_id: string | null
}
