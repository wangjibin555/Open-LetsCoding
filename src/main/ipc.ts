// IPC 接线层：channel → engine/store/vault。engine 本体保持 Electron 无关。
import { ipcMain, shell, Notification, dialog, type BrowserWindow, type OpenDialogOptions, app } from 'electron'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  Channels,
  DESIGN_HANDLE_PREFIX,
  type AppPingResult,
  type AppSettings,
  type CreateSessionPayload,
  type CronJobDto,
  type CronJobSavePayload,
  type CronRunDto,
  type CronScheduleKind,
  type DangerRuleDto,
  type ImageAttachmentDto,
  type MemoryType,
  type PermRespondPayload,
  type ReplayMessage,
  type SecretStatusResult,
  type SessionListEntry,
  type SessionMetaPatch,
  type UiPermissionMode
} from '../shared/ipc'
import { computeDueAt, cronChatRunIdOf, cronRunIdOf, validateSchedule, type CronService } from './cron'
import { designFilePath, listDesignFiles, readDesignFile } from './design'
import type { ConsolidationProposal, MemoryProposal, SessionService } from './engine/sessions'
import { fetchModels, fetchSpend, normalizeBaseUrl, testGateway } from './engine/gateway'
import { execFile, spawn } from 'node:child_process'
import { isMainSession } from './engine/sessionFilter'
import { readSubagents } from './engine/subagents'
import { gitDiffInfo } from './gitinfo'
import { ensureLearn, parseLearnConfig } from './learn'
import { readSessionTasks } from './tasks'
import type { MemoryService } from './memory'
import type { StateStore } from './store'
import type { SecretVault } from './store/secrets'

export interface IpcDeps {
  store: StateStore | null
  vault: SecretVault
  engine: SessionService
  memory: MemoryService | null
  cron: CronService | null
  getWindow: () => BrowserWindow | null
}

const GATEWAY_KEY_NAME = 'litellm-gateway-key'

export function gatewayConfigFrom(deps: Pick<IpcDeps, 'store' | 'vault'>):
  | { baseUrl: string; authToken: string; smallFastModel?: string }
  | null {
  const baseUrl = deps.store?.getSetting('base_url') ?? null
  const authToken = deps.vault.get(GATEWAY_KEY_NAME)
  if (!baseUrl || !authToken) return null
  const smallFastModel = deps.store?.getSetting('small_fast_model') ?? undefined
  // 规范化成 root：SDK 追加 /v1/messages，避免用户填的 /v1 造成 /v1/v1/messages 404
  return { baseUrl: normalizeBaseUrl(baseUrl), authToken, smallFastModel }
}

export function registerIpc(deps: IpcDeps): void {
  const { engine } = deps

  ipcMain.handle(Channels.AppPing, (): AppPingResult => {
    return { app: 'LetsCoding', version: app.getVersion(), storeReady: deps.store !== null }
  })

  // ---- session ----
  ipcMain.handle(Channels.SessionCreate, (_e, payload: CreateSessionPayload) => {
    engine.create(payload)
  })

  ipcMain.handle(
    Channels.SessionSend,
    (_e, p: { handle: string; text: string; images?: ImageAttachmentDto[] }) => {
      engine.send(p.handle, p.text, p.images)
    }
  )

  ipcMain.handle(Channels.SessionInterrupt, (_e, p: { handle: string }) => engine.interrupt(p.handle))

  ipcMain.handle(Channels.SessionSetModel, (_e, p: { handle: string; model: string }) =>
    engine.setModel(p.handle, p.model)
  )

  ipcMain.handle(Channels.SessionSetMode, (_e, p: { handle: string; uiMode: UiPermissionMode }) =>
    engine.setMode(p.handle, p.uiMode)
  )

  ipcMain.handle(Channels.SessionClose, (_e, p: { handle: string }) => {
    engine.close(p.handle)
  })

  ipcMain.handle(Channels.SessionList, async (): Promise<SessionListEntry[]> => {
    // 只展示主会话：排除临时目录（探针/workflow）与 agent worktree 会话
    const infos = (await engine.list()).filter((i) => isMainSession(i.cwd))
    const liveBySid = new Map(
      engine.liveSessions().filter((l) => l.sessionId).map((l) => [l.sessionId as string, l])
    )
    return infos.flatMap((info) => {
      const meta = deps.store?.getSessionMeta(info.sessionId)
      // M21：hidden 会话（cron 报告及其续聊 fork）不进 Code 列表——只在 TaskWork 页内可见
      if (meta?.hidden === 1) return []
      const live = liveBySid.get(info.sessionId)
      return {
        sessionId: info.sessionId,
        summary: info.summary,
        lastModified: info.lastModified,
        createdAt: info.createdAt,
        cwd: info.cwd,
        gitBranch: info.gitBranch,
        firstPrompt: info.firstPrompt,
        customTitle: info.customTitle,
        groupName: meta?.group_name ?? null,
        pinned: meta?.pinned === 1,
        archived: meta?.archived === 1,
        ...(live ? { live: { handle: live.handle, model: live.model, uiMode: live.uiMode } } : {})
      }
    })
  })

  ipcMain.handle(Channels.SessionReplay, async (_e, p: { sessionId: string }): Promise<ReplayMessage[]> => {
    const msgs = await engine.messages(p.sessionId)
    return msgs.map((m) => ({
      type: m.type,
      uuid: m.uuid,
      message: m.message,
      parent_tool_use_id: m.parent_tool_use_id
    }))
  })

  // 回放的子 agent 步骤：按 Task tool_use_id 关联 subagents/ 目录（只读）
  ipcMain.handle(Channels.SessionSubagents, (_e, p: { sessionId: string; cwd: string }) =>
    readSubagents(join(homedir(), '.claude', 'projects'), p.cwd, p.sessionId)
  )

  ipcMain.handle(Channels.SessionRename, (_e, p: { sessionId: string; title: string; dir?: string }) =>
    engine.rename(p.sessionId, p.title, p.dir)
  )

  ipcMain.handle(Channels.SessionDelete, async (_e, p: { sessionId: string; dir?: string }) => {
    await engine.remove(p.sessionId, p.dir)
    deps.store?.deleteSessionMeta(p.sessionId)
  })

  // ---- groups（自定义命名分组）----
  ipcMain.handle(Channels.GroupList, () =>
    mustStore()
      .listGroups()
      .map((g) => ({ name: g.name, collapsed: g.collapsed === 1 }))
  )
  ipcMain.handle(Channels.GroupCreate, (_e, p: { name: string }) => mustStore().createGroup(p.name))
  ipcMain.handle(Channels.GroupRename, (_e, p: { oldName: string; newName: string }) =>
    mustStore().renameGroup(p.oldName, p.newName)
  )
  ipcMain.handle(Channels.GroupDelete, (_e, p: { name: string }) => mustStore().deleteGroup(p.name))
  ipcMain.handle(Channels.GroupCollapse, (_e, p: { name: string; collapsed: boolean }) =>
    mustStore().setGroupCollapsed(p.name, p.collapsed)
  )

  // ---- 「自定义」弹窗：Skills / 插件本地扫描秒回；连接器状态单独异步（glab 远端探测可达数秒）----
  ipcMain.handle(Channels.CustomizeInfo, (_e, p: { cwd: string | null }) => {
    const skills = [
      ...scanSkills(join(homedir(), '.claude', 'skills'), 'user'),
      ...(p.cwd ? scanSkills(join(p.cwd, '.claude', 'skills'), 'project') : [])
    ]
    return { skills, plugins: scanPlugins() }
  })

  ipcMain.handle(Channels.ConnectorsStatus, async () => {
    const [gh, glab] = await Promise.all([cliAuthStatus('gh'), glabStatus()])
    return { gh, glab }
  })

  // ---- 会话关联信息（全部只读）：Claude Code 待办 / transcript 路径 / 访达定位 ----
  ipcMain.handle(Channels.SessionTasks, (_e, p: { sessionId: string }) =>
    readSessionTasks(join(homedir(), '.claude', 'tasks'), p.sessionId)
  )

  ipcMain.handle(Channels.SessionTranscriptPath, (_e, p: { sessionId: string; cwd: string }) => {
    if (!/^[0-9a-f-]{8,64}$/i.test(p.sessionId)) return { path: null }
    const path = join(
      homedir(),
      '.claude',
      'projects',
      p.cwd.replace(/[^a-zA-Z0-9]/g, '-'),
      `${p.sessionId}.jsonl`
    )
    return { path: existsSync(path) ? path : null }
  })


  // 绑定连接器：拉起系统终端跑交互式 auth login（工具与命令白名单硬编码，
  // 首次触发 macOS「控制 Terminal」授权弹窗；登录完成后 UI 侧「重新检测」刷新状态）
  ipcMain.handle(Channels.CustomizeBind, (_e, p: { tool: string }) => {
    const tool = p.tool === 'gh' ? 'gh' : p.tool === 'glab' ? 'glab' : null
    if (!tool) throw new Error(`unknown tool: ${p.tool}`)
    const script = `tell application "Terminal"\n  activate\n  do script "${tool} auth login"\nend tell`
    spawn('osascript', ['-e', script], { stdio: 'ignore' }).unref()
  })

  // ---- 右栏 .claude 上下文（只读探测，G7 单写者 gate 不涉及）----
  ipcMain.handle(Channels.CtxInfo, (_e, p: { cwd: string }) => {
    const memDir = join(homedir(), '.claude', 'projects', p.cwd.replace(/[^a-zA-Z0-9]/g, '-'), 'memory')
    let memoryCount = 0
    try {
      memoryCount = existsSync(memDir)
        ? readdirSync(memDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').length
        : 0
    } catch {
      /* 只读探测失败不影响主流程 */
    }
    const skills = [
      ...scanSkills(join(homedir(), '.claude', 'skills'), 'user'),
      ...scanSkills(join(p.cwd, '.claude', 'skills'), 'project')
    ]
    return {
      globalClaudeMd: existsSync(join(homedir(), '.claude', 'CLAUDE.md')),
      projectClaudeMd: existsSync(join(p.cwd, 'CLAUDE.md')),
      decisionsMd: existsSync(join(p.cwd, 'DECISIONS.md')),
      memoryCount,
      skills
    }
  })

  // ---- 「在 Finder 打开」：目标由 main 侧解析，渲染层不传任意路径 ----
  ipcMain.handle(
    Channels.ShellReveal,
    async (_e, p: { target: string; cwd?: string; sessionId?: string; file?: string }) => {
      const claudeRoot = join(homedir(), '.claude')
      const slug = p.cwd ? p.cwd.replace(/[^a-zA-Z0-9]/g, '-') : null
      // transcript：定位到会话 jsonl 文件（访达高亮），其余目标打开目录
      if (p.target === 'transcript' && slug && p.sessionId && /^[0-9a-f-]{8,64}$/i.test(p.sessionId)) {
        const file = join(claudeRoot, 'projects', slug, `${p.sessionId}.jsonl`)
        if (existsSync(file)) shell.showItemInFolder(file)
        return
      }
      // design：定位设计稿（D11，裸文件名经 design.ts 校验）
      if (p.target === 'design' && p.cwd && p.file) {
        const path = designFilePath(p.cwd, p.file)
        if (path) shell.showItemInFolder(path)
        return
      }
      const path =
        p.target === 'claude-root'
          ? claudeRoot
          : p.target === 'projects'
            ? (slug ? join(claudeRoot, 'projects', slug) : join(claudeRoot, 'projects'))
            : p.target === 'memory' && slug
              ? join(claudeRoot, 'projects', slug, 'memory')
              : null
      if (path && existsSync(path)) await shell.openPath(path)
    }
  )

  // 「>_ 在终端打开」：仅对存在的目录，交由系统 Terminal（darwin）
  ipcMain.handle(Channels.ShellTerminal, (_e, p: { cwd: string }) => {
    if (typeof p.cwd === 'string' && p.cwd && existsSync(p.cwd)) {
      spawn('open', ['-a', 'Terminal', p.cwd], { detached: true }).unref()
    }
  })

  // 原生目录选择器（M23）：只读系统对话框，返回选中目录或 null（取消）
  ipcMain.handle(Channels.DialogPickDir, async (_e, p: { defaultPath?: string }) => {
    const opts: OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
      ...(typeof p?.defaultPath === 'string' && existsSync(p.defaultPath)
        ? { defaultPath: p.defaultPath }
        : {})
    }
    const win = deps.getWindow()
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  // 「± 改动」：会话 cwd 的 git 工作区只读快照
  ipcMain.handle(Channels.GitDiff, (_e, p: { cwd: string }) => gitDiffInfo(p.cwd))

  // Markdown 正文里的链接：只放行 http/https，交系统浏览器打开（渲染层不直接开窗）
  ipcMain.handle(Channels.ShellOpenUrl, async (_e, p: { url: string }) => {
    let u: URL
    try {
      u = new URL(p.url)
    } catch {
      return
    }
    if (u.protocol === 'http:' || u.protocol === 'https:') await shell.openExternal(u.href)
  })

  ipcMain.handle(Channels.SessionSetMeta, (_e, p: SessionMetaPatch) => {
    if (!deps.store) throw new Error('state store unavailable')
    const prev = deps.store.getSessionMeta(p.sessionId)
    deps.store.upsertSessionMeta({
      session_id: p.sessionId,
      group_name: p.group_name !== undefined ? p.group_name : (prev?.group_name ?? null),
      pinned: p.pinned !== undefined ? (p.pinned ? 1 : 0) : (prev?.pinned ?? 0),
      archived: p.archived !== undefined ? (p.archived ? 1 : 0) : (prev?.archived ?? 0),
      hidden: p.hidden !== undefined ? (p.hidden ? 1 : 0) : (prev?.hidden ?? 0),
      fallback_note: prev?.fallback_note ?? null
    })
  })

  // ---- Design 模式（D11）：design/*.html 只读；file 一律裸文件名，design.ts 校验拼路径 ----
  ipcMain.handle(Channels.DesignList, (_e, p: { cwd: string }) => listDesignFiles(p.cwd))
  ipcMain.handle(Channels.DesignRead, (_e, p: { cwd: string; file: string }) =>
    readDesignFile(p.cwd, p.file)
  )
  ipcMain.handle(Channels.DesignOpen, async (_e, p: { cwd: string; file: string }) => {
    const path = designFilePath(p.cwd, p.file)
    if (path) await shell.openPath(path)
  })

  // ---- TaskWork 定时任务（D10）：CRUD 走 store，触发走 CronService ----
  const mustCron = (): NonNullable<IpcDeps['cron']> => {
    if (!deps.cron) throw new Error('cron service unavailable')
    return deps.cron
  }
  const toCronJobDto = (j: import('./store').CronJobRow): CronJobDto => ({
    id: j.id,
    name: j.name,
    prompt: j.prompt,
    cwd: j.cwd,
    model: j.model,
    scheduleKind: j.schedule_kind as CronScheduleKind,
    scheduleArg: j.schedule_arg,
    enabled: j.enabled === 1,
    catchUp: j.catch_up === 1,
    lastRunAt: j.last_run_at,
    nextDueAt:
      j.enabled === 1
        ? computeDueAt(j.schedule_kind, j.schedule_arg, j.last_run_at ?? j.created_at)
        : null
  })

  ipcMain.handle(Channels.CronJobList, (): CronJobDto[] => mustStore().listCronJobs().map(toCronJobDto))

  ipcMain.handle(Channels.CronJobSave, (_e, p: CronJobSavePayload): number => {
    const err = validateSchedule(p.scheduleKind, p.scheduleArg)
    if (err) throw new Error(err)
    return mustStore().saveCronJob(
      {
        ...(p.id !== undefined ? { id: p.id } : {}),
        name: p.name,
        prompt: p.prompt,
        cwd: p.cwd,
        model: p.model,
        schedule_kind: p.scheduleKind,
        schedule_arg: p.scheduleArg,
        enabled: p.enabled ? 1 : 0,
        catch_up: p.catchUp ? 1 : 0
      },
      Date.now()
    )
  })

  ipcMain.handle(Channels.CronJobDelete, (_e, p: { id: number }) => mustStore().deleteCronJob(p.id))
  ipcMain.handle(Channels.CronJobToggle, (_e, p: { id: number; enabled: boolean }) =>
    mustStore().setCronJobEnabled(p.id, p.enabled)
  )
  ipcMain.handle(Channels.CronJobRunNow, (_e, p: { id: number }) => mustCron().runNow(p.id))

  ipcMain.handle(
    Channels.CronRunsList,
    (_e, p: { jobId: number | null; limit?: number }): CronRunDto[] =>
      mustStore()
        .listCronRuns(p.jobId ?? null, Math.min(Math.max(p.limit ?? 20, 1), 50))
        .map((r) => ({
          id: r.id,
          jobId: r.job_id,
          jobName: r.job_name,
          sessionId: r.session_id,
          startedAt: r.started_at,
          status: r.status as CronRunDto['status'],
          summary: r.summary,
          outTokens: r.out_tokens,
          cwd: r.cwd
        }))
  )

  // ---- permissions ----
  ipcMain.handle(Channels.PermRespond, (_e, p: PermRespondPayload) => {
    engine.resolvePermission(p.requestId, p.allow, { always: p.always, message: p.message })
  })

  // ---- rule management (D7：builtin 不可关/不可删由 store 层强制) ----
  const mustStore = (): NonNullable<IpcDeps['store']> => {
    if (!deps.store) throw new Error('state store unavailable')
    return deps.store
  }

  ipcMain.handle(Channels.DangerList, (): DangerRuleDto[] =>
    mustStore()
      .listDangerRules()
      .map((r) => ({ id: r.id, pattern: r.pattern, enabled: r.enabled === 1, builtin: r.builtin === 1 }))
  )
  ipcMain.handle(Channels.DangerAdd, (_e, p: { pattern: string }) => mustStore().addDangerRule(p.pattern))
  ipcMain.handle(Channels.DangerToggle, (_e, p: { id: number; enabled: boolean }) =>
    mustStore().setDangerRuleEnabled(p.id, p.enabled)
  )
  ipcMain.handle(Channels.DangerRemove, (_e, p: { id: number }) => mustStore().removeDangerRule(p.id))

  ipcMain.handle(Channels.WhitelistList, (): string[] => mustStore().listWhitelist())
  ipcMain.handle(Channels.WhitelistAdd, (_e, p: { pattern: string }) => mustStore().addWhitelist(p.pattern))
  ipcMain.handle(Channels.WhitelistRemove, (_e, p: { pattern: string }) =>
    mustStore().removeWhitelist(p.pattern)
  )

  // ---- memory inbox（D6：accept 是唯一写盘路径，藏在 MemoryService 内）----
  const mustMemory = (): NonNullable<IpcDeps['memory']> => {
    if (!deps.memory) throw new Error('memory service unavailable')
    return deps.memory
  }

  ipcMain.handle(Channels.MemoryInboxList, () => mustStore().listInbox('pending'))
  ipcMain.handle(Channels.MemoryInboxAccept, (_e, p: { id: number }) => mustMemory().accept(p.id))
  ipcMain.handle(Channels.MemoryInboxDiscard, (_e, p: { id: number }) => mustMemory().discard(p.id))
  ipcMain.handle(Channels.MemoryList, (_e, p: { cwd: string | null }) =>
    p.cwd ? mustMemory().listMemories(p.cwd) : mustMemory().listAllMemories()
  )
  ipcMain.handle(
    Channels.MemoryUpdate,
    (_e, p: { slug: string; file: string; description?: string; type?: MemoryType; body?: string }) =>
      mustMemory().updateMemory(p.slug, p.file, {
        description: p.description,
        type: p.type,
        body: p.body
      })
  )
  ipcMain.handle(Channels.MemoryDelete, (_e, p: { slug: string; file: string }) =>
    mustMemory().softDeleteMemory(p.slug, p.file)
  )
  ipcMain.handle(Channels.MemoryTrashList, (_e, p: { cwd: string | null }) =>
    mustMemory().listTrash(p.cwd)
  )
  ipcMain.handle(Channels.MemoryRestore, (_e, p: { id: number }) =>
    mustMemory().restoreMemory(p.id)
  )

  // ---- 整理 consolidate（D9 M8.2）----
  ipcMain.handle(Channels.MemoryConsolidateStart, (_e, p: { cwd: string; model: string }) => {
    const memories = mustMemory().listMemories(p.cwd)
    if (memories.length < 2) throw new Error('该目录记忆不足两条，无需整理')
    const dirName = p.cwd.split('/').filter(Boolean).pop() ?? p.cwd
    const handle = `consolidate-${Date.now()}`
    engine.create({
      handle,
      cwd: p.cwd,
      model: p.model,
      uiMode: 'auto',
      mode: 'consolidate',
      firstPrompt: buildConsolidationPrompt(dirName, memories)
    })
    return { handle }
  })
  ipcMain.handle(Channels.ConsolidationList, (_e, p: { cwd: string | null }) =>
    mustMemory().listConsolidation(p.cwd)
  )
  ipcMain.handle(Channels.ConsolidationAccept, (_e, p: { id: number }) =>
    mustMemory().acceptConsolidation(p.id)
  )
  ipcMain.handle(Channels.ConsolidationDiscard, (_e, p: { id: number }) =>
    mustMemory().discardConsolidation(p.id)
  )

  // ---- gateway / settings ----
  ipcMain.handle(Channels.ModelsList, async () => {
    const cfg = gatewayConfigFrom(deps)
    if (!cfg) return []
    const ids = await fetchModels(cfg.baseUrl, cfg.authToken)
    // 已设为默认/轻任务但不在 /v1/models 列表的模型（网关 wildcard 仍可路由，已实测）也纳入选单
    for (const extra of [deps.store?.getSetting('default_model'), deps.store?.getSetting('small_fast_model')]) {
      if (extra && !ids.includes(extra)) ids.push(extra)
    }
    const disabled = deps.store?.disabledModels() ?? new Set<string>()
    return ids.map((id) => ({ id, enabled: !disabled.has(id) }))
  })

  ipcMain.handle(Channels.ModelToggle, (_e, p: { id: string; enabled: boolean }) =>
    mustStore().setModelEnabled(p.id, p.enabled)
  )

  ipcMain.handle(Channels.SpendSummary, async () => {
    const cfg = gatewayConfigFrom(deps)
    if (!cfg) return { available: false, spendUsd: null, reason: 'not configured' }
    return fetchSpend(cfg.baseUrl, cfg.authToken)
  })

  ipcMain.handle(Channels.GatewayTest, async () => {
    const cfg = gatewayConfigFrom(deps)
    if (!cfg) return { ok: false, latencyMs: 0, modelCount: 0, error: 'not configured' }
    return testGateway(cfg.baseUrl, cfg.authToken)
  })

  ipcMain.handle(Channels.SettingsGet, (): AppSettings => {
    return {
      baseUrl: deps.store?.getSetting('base_url') ?? null,
      defaultModel: deps.store?.getSetting('default_model') ?? null,
      smallFastModel: deps.store?.getSetting('small_fast_model') ?? null,
      lastSessionId: deps.store?.getSetting('last_session_id') ?? null,
      panelLayout: deps.store?.getSetting('panel_layout') ?? null,
      appearance: deps.store?.getSetting('appearance') ?? null,
      designSessions: deps.store?.getSetting('design_sessions') ?? null,
      learn: deps.store?.getSetting('learn') ?? null
    }
  })

  ipcMain.handle(Channels.SettingsSet, (_e, p: Partial<AppSettings>) => {
    if (!deps.store) throw new Error('state store unavailable')
    if (p.baseUrl !== undefined && p.baseUrl !== null) deps.store.setSetting('base_url', p.baseUrl)
    if (p.defaultModel !== undefined && p.defaultModel !== null)
      deps.store.setSetting('default_model', p.defaultModel)
    if (p.smallFastModel !== undefined && p.smallFastModel !== null)
      deps.store.setSetting('small_fast_model', p.smallFastModel)
    if (p.lastSessionId !== undefined && p.lastSessionId !== null)
      deps.store.setSetting('last_session_id', p.lastSessionId)
    if (p.panelLayout !== undefined && p.panelLayout !== null)
      deps.store.setSetting('panel_layout', p.panelLayout)
    if (p.appearance !== undefined && p.appearance !== null)
      deps.store.setSetting('appearance', p.appearance)
    if (p.designSessions !== undefined && p.designSessions !== null)
      deps.store.setSetting('design_sessions', p.designSessions)
    if (p.learn !== undefined && p.learn !== null) deps.store.setSetting('learn', p.learn)
  })

  // D16 学习平台：探测/拉起本地服务。配置仅来自用户在设置页写入的 settings.learn；
  // 本 IPC 只由用户点击触发（模型无 App IPC 触达面），spawn 目标固定为 <dir>/start.sh。
  ipcMain.handle(Channels.LearnEnsure, () => {
    return ensureLearn(parseLearnConfig(deps.store?.getSetting('learn')))
  })

  ipcMain.handle(Channels.SecretSet, (_e, p: { value: string }) => {
    deps.vault.set(GATEWAY_KEY_NAME, p.value)
  })

  ipcMain.handle(Channels.SecretStatus, (): SecretStatusResult => {
    return {
      encryptionAvailable: deps.vault.isAvailable(),
      gatewayKeySet: deps.vault.get(GATEWAY_KEY_NAME) !== null
    }
  })
}

/** 只读扫描技能目录：目录名 + SKILL.md frontmatter description（截断防超长） */
// 已安装插件（~/.claude/plugins 只读扫描）：installed_plugins.json 为真源，
// marketplace 的 GitHub 仓库做外链，描述取各插件 .claude-plugin/plugin.json
function scanPlugins(): Array<{
  name: string
  marketplace: string
  version: string
  description: string
  repoUrl: string | null
  skillCount: number
}> {
  try {
    const root = join(homedir(), '.claude', 'plugins')
    const installed = JSON.parse(readFileSync(join(root, 'installed_plugins.json'), 'utf8')) as {
      plugins?: Record<string, Array<{ installPath?: string; version?: string }>>
    }
    let markets: Record<string, { source?: { source?: string; repo?: string } }> = {}
    try {
      markets = JSON.parse(readFileSync(join(root, 'known_marketplaces.json'), 'utf8'))
    } catch {
      /* 无 marketplace 清单则外链留空 */
    }
    return Object.entries(installed.plugins ?? {}).map(([key, entries]) => {
      const [name, marketplace] = key.split('@')
      const e = entries[0] ?? {}
      let description = ''
      let skillCount = 0
      try {
        if (e.installPath) {
          const manifest = join(e.installPath, '.claude-plugin', 'plugin.json')
          if (existsSync(manifest)) {
            description = String(JSON.parse(readFileSync(manifest, 'utf8')).description ?? '').slice(0, 120)
          }
          const skillsDir = join(e.installPath, 'skills')
          if (existsSync(skillsDir)) {
            skillCount = readdirSync(skillsDir).filter((f) => !f.startsWith('.')).length
          }
        }
      } catch {
        /* 单个插件读失败不影响整体 */
      }
      const src = markets[marketplace ?? '']?.source
      const repoUrl = src?.source === 'github' && src.repo ? `https://github.com/${src.repo}` : null
      return { name: name ?? key, marketplace: marketplace ?? '', version: e.version ?? '', description, repoUrl, skillCount }
    })
  } catch {
    return []
  }
}

// GitHub 连接状态：gh CLI 只读探测（~1s 稳定）。
// 按登录行解析而非退出码，多账号时逐个列出："Logged in to github.com account NAME (keyring)"
function cliAuthStatus(cmd: 'gh'): Promise<{ installed: boolean; authed: boolean; account: string | null }> {
  return new Promise((resolve) => {
    execFile(cmd, ['auth', 'status'], { timeout: 8000 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ installed: false, authed: false, account: null })
        return
      }
      const out = `${stdout}\n${stderr}`
      const logins = [...out.matchAll(/Logged in to (\S+) (?:account|as)\s+(\S+)/gi)]
      resolve({
        installed: true,
        authed: logins.length > 0,
        account: logins.length > 0 ? logins.map((m) => `${m[2]}@${m[1]}`).join('、') : null
      })
    })
  })
}

// GitLab 连接状态：`glab auth status` 会对失效实例远端重试（实测 30s+），不可用于交互路径；
// 改读本地配置（即时）——auth login 成功会写 hosts.<host>.user，带 user 的实例视为已绑定。
// --version 仅判安装（本地执行 ~0.1s）。
function glabStatus(): Promise<{ installed: boolean; authed: boolean; account: string | null }> {
  return new Promise((resolve) => {
    execFile('glab', ['--version'], { timeout: 3000 }, (err) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ installed: false, authed: false, account: null })
        return
      }
      const accounts: string[] = []
      for (const p of [
        join(homedir(), 'Library', 'Application Support', 'glab-cli', 'config.yml'),
        join(homedir(), '.config', 'glab-cli', 'config.yml')
      ]) {
        try {
          if (!existsSync(p)) continue
          const text = readFileSync(p, 'utf8')
          const hosts = text.slice(text.indexOf('hosts:'))
          for (const m of hosts.matchAll(/^ {4}(\S+):\n((?: {8}.*\n?)*)/gm)) {
            const user = /^\s+user:\s*(\S+)/m.exec(m[2])
            if (user) accounts.push(`${user[1]}@${m[1]}`)
          }
          break
        } catch {
          /* 配置读失败按未绑定，不阻塞 */
        }
      }
      resolve({ installed: true, authed: accounts.length > 0, account: accounts.join('、') || null })
    })
  })
}

function scanSkills(dir: string, scope: 'user' | 'project'): Array<{ name: string; description: string; scope: 'user' | 'project' }> {
  try {
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => {
        try {
          return !f.startsWith('.') && statSync(join(dir, f)).isDirectory()
        } catch {
          return false
        }
      })
      .map((name) => {
        let description = ''
        try {
          const md = join(dir, name, 'SKILL.md')
          if (existsSync(md)) {
            const text = readFileSync(md, 'utf8').slice(0, 4000)
            const m = /^\s*description:\s*(.+)$/m.exec(text)
            if (m) description = m[1].trim().slice(0, 120)
          }
        } catch {
          /* 单个技能读失败不影响整体 */
        }
        return { name, description, scope }
      })
  } catch {
    return []
  }
}

function notifyIfBackground(win: BrowserWindow | null, title: string, body: string): void {
  // 只在窗口不在前台时打扰；点击通知拉回窗口
  if (!win || win.isFocused() || !Notification.isSupported()) return
  const n = new Notification({ title, body })
  n.on('click', () => {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  n.show()
}

export function streamToRenderer(deps: IpcDeps, handle: string, msg: unknown): void {
  const win = deps.getWindow()
  win?.webContents.send(Channels.SessionStream, { handle, msg })
  const m = msg as { type?: string; subtype?: string; error?: string }
  // 通知文案按会话类型具体化：定时任务/续聊带任务名、设计对话标来源，Code 会话保持原文案
  const runId = cronRunIdOf(handle) ?? cronChatRunIdOf(handle)
  const jobName = runId !== null ? (deps.store?.getCronRun(runId)?.job_name ?? null) : null
  if (m?.type === 'result') {
    if (jobName && cronRunIdOf(handle) !== null)
      notifyIfBackground(win, 'LetsCoding · 定时任务完成', `《${jobName}》已生成报告，点击查看`)
    else if (jobName)
      notifyIfBackground(win, 'LetsCoding · 追问有回答了', `《${jobName}》的续聊本轮已完成，点击查看`)
    else if (handle.startsWith(DESIGN_HANDLE_PREFIX))
      notifyIfBackground(win, 'LetsCoding · 设计对话完成', '设计稿已按要求处理，点击查看')
    else notifyIfBackground(win, 'LetsCoding · 回答完成', '后台会话本轮已完成，点击查看')
  } else if (m?.type === 'engine' && m.subtype === 'error') {
    const title = jobName ? `LetsCoding · 定时任务出错（${jobName}）` : 'LetsCoding · 会话出错'
    notifyIfBackground(win, title, String(m.error ?? '').slice(0, 100))
  }
}

export function permToRenderer(deps: IpcDeps, req: unknown): void {
  const win = deps.getWindow()
  win?.webContents.send(Channels.PermRequest, req)
  const r = req as { toolName?: string; input?: Record<string, unknown> }
  const cmd =
    typeof r?.input?.['command'] === 'string' ? `：${(r.input!['command'] as string).slice(0, 80)}` : ''
  notifyIfBackground(win, 'LetsCoding · 等待权限确认', `${r?.toolName ?? '工具'}${cmd}`)
}

/** propose_memory → 收件箱（不写盘）→ 以流事件通知 UI 内联展示 */
export function memoryProposalToInbox(deps: IpcDeps, p: MemoryProposal): void {
  if (!deps.store) return
  const inboxId = deps.store.addInboxItem({
    session_id: p.handle,
    cwd: p.cwd,
    name: p.name,
    type: p.type,
    description: p.description,
    body: p.body
  })
  streamToRenderer(deps, p.handle, {
    type: 'engine',
    subtype: 'memory_proposed',
    inboxId,
    name: p.name,
    memType: p.type,
    description: p.description
  })
}

/** propose_consolidation → 整理收件箱（不写盘/不删源）→ 流事件通知 UI */
export function consolidationProposalToInbox(deps: IpcDeps, p: ConsolidationProposal): void {
  if (!deps.store) return
  const inboxId = deps.store.addConsolidationItem({
    session_id: p.handle,
    cwd: p.cwd,
    name: p.name,
    type: p.type,
    description: p.description,
    body: p.body,
    sources: JSON.stringify(p.sources),
    rationale: p.rationale
  })
  streamToRenderer(deps, p.handle, {
    type: 'engine',
    subtype: 'consolidation_proposed',
    inboxId,
    name: p.name,
    sources: p.sources
  })
}

/** 整理会话首条消息：把当前目录记忆全文喂给模型，要求逐组调 propose_consolidation */
function buildConsolidationPrompt(
  dirName: string,
  memories: Array<{ file: string; name: string; type: string; description: string; body: string }>
): string {
  const head = [
    `下面是「${dirName}」记忆库的全部 ${memories.length} 条记忆。请找出内容重复或主题高度重叠、可以安全合并的记忆组。`,
    '对每一组可合并的记忆，调用一次 propose_consolidation 工具：给出合并后的 name/description/type/body，',
    '并在 sources 里逐字列出被合并的文件名（如 ["a.md","b.md"]）。规则：',
    '- 宁缺毋滥：主题不同、各自独立的记忆不要合并；拿不准就不合并。',
    '- 合并时保留各源记忆的关键信息，不要丢失内容。',
    '- 只合并真正冗余的；若没有任何可合并的，直接说明「无需整理」，不要强行合并。',
    '完成后用一两句话说明你的整理结论。',
    '',
    '=== 记忆库全文 ==='
  ].join('\n')
  const body = memories
    .map(
      (m, i) =>
        `[${i + 1}] 文件：${m.file} ｜ 类型：${m.type} ｜ 描述：${m.description}\n正文：\n${m.body}`
    )
    .join('\n---\n')
  return `${head}\n${body}`
}
