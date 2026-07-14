import { contextBridge, ipcRenderer, webFrame } from 'electron'
import {
  Channels,
  type AppPingResult,
  type AppSettings,
  type CreateSessionPayload,
  type DangerRuleDto,
  type GatewayTestResult,
  type PermRespondPayload,
  type PermissionRequestPayload,
  type ReplayMessage,
  type SecretStatusResult,
  type SessionListEntry,
  type SessionMetaPatch,
  type StreamEventPayload,
  type UiPermissionMode
} from '../shared/ipc'

type Unsubscribe = () => void

const api = {
  ping: (): Promise<AppPingResult> => ipcRenderer.invoke(Channels.AppPing),

  session: {
    create: (p: CreateSessionPayload): Promise<void> => ipcRenderer.invoke(Channels.SessionCreate, p),
    send: (
      handle: string,
      text: string,
      images?: import('../shared/ipc').ImageAttachmentDto[]
    ): Promise<void> =>
      ipcRenderer.invoke(Channels.SessionSend, { handle, text, images }),
    interrupt: (handle: string): Promise<void> =>
      ipcRenderer.invoke(Channels.SessionInterrupt, { handle }),
    setModel: (handle: string, model: string): Promise<void> =>
      ipcRenderer.invoke(Channels.SessionSetModel, { handle, model }),
    setMode: (handle: string, uiMode: UiPermissionMode): Promise<void> =>
      ipcRenderer.invoke(Channels.SessionSetMode, { handle, uiMode }),
    close: (handle: string): Promise<void> => ipcRenderer.invoke(Channels.SessionClose, { handle }),
    list: (): Promise<SessionListEntry[]> => ipcRenderer.invoke(Channels.SessionList),
    subagents: (
      sessionId: string,
      cwd: string
    ): Promise<Record<string, import('../shared/ipc').SubagentInfoDto>> =>
      ipcRenderer.invoke(Channels.SessionSubagents, { sessionId, cwd }),
    replay: (sessionId: string): Promise<ReplayMessage[]> =>
      ipcRenderer.invoke(Channels.SessionReplay, { sessionId }),
    setMeta: (p: SessionMetaPatch): Promise<void> => ipcRenderer.invoke(Channels.SessionSetMeta, p),
    rename: (sessionId: string, title: string, dir?: string): Promise<void> =>
      ipcRenderer.invoke(Channels.SessionRename, { sessionId, title, dir }),
    remove: (sessionId: string, dir?: string): Promise<void> =>
      ipcRenderer.invoke(Channels.SessionDelete, { sessionId, dir }),
    onStream: (cb: (e: StreamEventPayload) => void): Unsubscribe => {
      const listener = (_: unknown, payload: StreamEventPayload): void => cb(payload)
      ipcRenderer.on(Channels.SessionStream, listener)
      return () => ipcRenderer.removeListener(Channels.SessionStream, listener)
    }
  },

  perm: {
    respond: (p: PermRespondPayload): Promise<void> => ipcRenderer.invoke(Channels.PermRespond, p),
    onRequest: (cb: (req: PermissionRequestPayload) => void): Unsubscribe => {
      const listener = (_: unknown, req: PermissionRequestPayload): void => cb(req)
      ipcRenderer.on(Channels.PermRequest, listener)
      return () => ipcRenderer.removeListener(Channels.PermRequest, listener)
    }
  },

  models: {
    list: (): Promise<import('../shared/ipc').ModelInfoDto[]> =>
      ipcRenderer.invoke(Channels.ModelsList),
    toggle: (id: string, enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(Channels.ModelToggle, { id, enabled })
  },

  spend: {
    summary: (): Promise<import('../shared/ipc').SpendInfoDto> =>
      ipcRenderer.invoke(Channels.SpendSummary)
  },

  groups: {
    list: (): Promise<import('../shared/ipc').GroupDto[]> => ipcRenderer.invoke(Channels.GroupList),
    create: (name: string): Promise<void> => ipcRenderer.invoke(Channels.GroupCreate, { name }),
    rename: (oldName: string, newName: string): Promise<void> =>
      ipcRenderer.invoke(Channels.GroupRename, { oldName, newName }),
    remove: (name: string): Promise<void> => ipcRenderer.invoke(Channels.GroupDelete, { name }),
    collapse: (name: string, collapsed: boolean): Promise<void> =>
      ipcRenderer.invoke(Channels.GroupCollapse, { name, collapsed })
  },

  ctx: {
    info: (cwd: string): Promise<import('../shared/ipc').CtxInfoDto> =>
      ipcRenderer.invoke(Channels.CtxInfo, { cwd })
  },

  customize: {
    info: (cwd: string | null): Promise<import('../shared/ipc').CustomizeInfoDto> =>
      ipcRenderer.invoke(Channels.CustomizeInfo, { cwd }),
    connectors: (): Promise<import('../shared/ipc').ConnectorsStatusDto> =>
      ipcRenderer.invoke(Channels.ConnectorsStatus),
    bind: (tool: 'gh' | 'glab'): Promise<void> => ipcRenderer.invoke(Channels.CustomizeBind, { tool })
  },

  ui: {
    /** 界面缩放（外观设置）：sandboxed preload 可用 webFrame，渲染层零 Node 访问不变 */
    setZoom: (factor: number): void => webFrame.setZoomFactor(factor)
  },

  design: {
    list: (cwd: string): Promise<import('../shared/ipc').DesignFileDto[]> =>
      ipcRenderer.invoke(Channels.DesignList, { cwd }),
    read: (cwd: string, file: string): Promise<import('../shared/ipc').DesignReadDto> =>
      ipcRenderer.invoke(Channels.DesignRead, { cwd, file }),
    open: (cwd: string, file: string): Promise<void> =>
      ipcRenderer.invoke(Channels.DesignOpen, { cwd, file }),
    /** 访达定位设计稿（复用 ShellReveal，裸文件名，main 侧校验拼路径） */
    reveal: (cwd: string, file: string): Promise<void> =>
      ipcRenderer.invoke(Channels.ShellReveal, { target: 'design', cwd, file })
  },

  cron: {
    jobs: (): Promise<import('../shared/ipc').CronJobDto[]> =>
      ipcRenderer.invoke(Channels.CronJobList),
    save: (p: import('../shared/ipc').CronJobSavePayload): Promise<number> =>
      ipcRenderer.invoke(Channels.CronJobSave, p),
    remove: (id: number): Promise<void> => ipcRenderer.invoke(Channels.CronJobDelete, { id }),
    toggle: (id: number, enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(Channels.CronJobToggle, { id, enabled }),
    runNow: (id: number): Promise<void> => ipcRenderer.invoke(Channels.CronJobRunNow, { id }),
    runs: (jobId: number | null, limit?: number): Promise<import('../shared/ipc').CronRunDto[]> =>
      ipcRenderer.invoke(Channels.CronRunsList, { jobId, limit })
  },

  sessionInfo: {
    tasks: (sessionId: string): Promise<import('../shared/ipc').SessionTaskDto[]> =>
      ipcRenderer.invoke(Channels.SessionTasks, { sessionId }),
    transcriptPath: (sessionId: string, cwd: string): Promise<{ path: string | null }> =>
      ipcRenderer.invoke(Channels.SessionTranscriptPath, { sessionId, cwd }),
    /** 访达定位会话 jsonl（复用 ShellReveal 的 main 侧路径解析，渲染层不传任意路径） */
    revealTranscript: (sessionId: string, cwd: string): Promise<void> =>
      ipcRenderer.invoke(Channels.ShellReveal, { target: 'transcript', sessionId, cwd })
  },

  memory: {
    inbox: (): Promise<import('../shared/ipc').InboxItemDto[]> =>
      ipcRenderer.invoke(Channels.MemoryInboxList),
    accept: (id: number): Promise<{ filePath: string }> =>
      ipcRenderer.invoke(Channels.MemoryInboxAccept, { id }),
    discard: (id: number): Promise<void> => ipcRenderer.invoke(Channels.MemoryInboxDiscard, { id }),
    list: (cwd: string | null): Promise<import('../shared/ipc').MemoryFileDto[]> =>
      ipcRenderer.invoke(Channels.MemoryList, { cwd }),
    update: (p: import('../shared/ipc').MemoryUpdatePayload): Promise<void> =>
      ipcRenderer.invoke(Channels.MemoryUpdate, p),
    remove: (slug: string, file: string): Promise<{ trashId: number }> =>
      ipcRenderer.invoke(Channels.MemoryDelete, { slug, file }),
    trash: (cwd: string | null): Promise<import('../shared/ipc').TrashItemDto[]> =>
      ipcRenderer.invoke(Channels.MemoryTrashList, { cwd }),
    restore: (id: number): Promise<{ filePath: string }> =>
      ipcRenderer.invoke(Channels.MemoryRestore, { id }),
    consolidateStart: (cwd: string, model: string): Promise<{ handle: string }> =>
      ipcRenderer.invoke(Channels.MemoryConsolidateStart, { cwd, model }),
    consolidationList: (cwd: string | null): Promise<import('../shared/ipc').ConsolidationItemDto[]> =>
      ipcRenderer.invoke(Channels.ConsolidationList, { cwd }),
    consolidationAccept: (id: number): Promise<{ filePath: string }> =>
      ipcRenderer.invoke(Channels.ConsolidationAccept, { id }),
    consolidationDiscard: (id: number): Promise<void> =>
      ipcRenderer.invoke(Channels.ConsolidationDiscard, { id })
  },

  shell: {
    reveal: (target: import('../shared/ipc').RevealTarget, cwd?: string): Promise<void> =>
      ipcRenderer.invoke(Channels.ShellReveal, { target, cwd }),
    openUrl: (url: string): Promise<void> => ipcRenderer.invoke(Channels.ShellOpenUrl, { url }),
    terminal: (cwd: string): Promise<void> => ipcRenderer.invoke(Channels.ShellTerminal, { cwd })
  },

  dialog: {
    /** 原生目录选择器；取消返回 null */
    pickDir: (defaultPath?: string): Promise<string | null> =>
      ipcRenderer.invoke(Channels.DialogPickDir, { defaultPath })
  },

  git: {
    diff: (cwd: string): Promise<import('../shared/ipc').GitDiffResult> =>
      ipcRenderer.invoke(Channels.GitDiff, { cwd })
  },

  rules: {
    dangerList: (): Promise<DangerRuleDto[]> => ipcRenderer.invoke(Channels.DangerList),
    dangerAdd: (pattern: string): Promise<void> => ipcRenderer.invoke(Channels.DangerAdd, { pattern }),
    dangerToggle: (id: number, enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(Channels.DangerToggle, { id, enabled }),
    dangerRemove: (id: number): Promise<void> => ipcRenderer.invoke(Channels.DangerRemove, { id }),
    whitelist: (): Promise<string[]> => ipcRenderer.invoke(Channels.WhitelistList),
    whitelistAdd: (pattern: string): Promise<void> =>
      ipcRenderer.invoke(Channels.WhitelistAdd, { pattern }),
    whitelistRemove: (pattern: string): Promise<void> =>
      ipcRenderer.invoke(Channels.WhitelistRemove, { pattern })
  },

  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(Channels.SettingsGet),
    set: (p: Partial<AppSettings>): Promise<void> => ipcRenderer.invoke(Channels.SettingsSet, p),
    setSecret: (value: string): Promise<void> => ipcRenderer.invoke(Channels.SecretSet, { value }),
    secretStatus: (): Promise<SecretStatusResult> => ipcRenderer.invoke(Channels.SecretStatus),
    testGateway: (): Promise<GatewayTestResult> => ipcRenderer.invoke(Channels.GatewayTest)
  }
}

export type LetsCodingApi = typeof api

contextBridge.exposeInMainWorld('letscoding', api)
