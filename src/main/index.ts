import { app, BrowserWindow, dialog, protocol } from 'electron'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Channels } from '../shared/ipc'
import { DESIGN_PREVIEW_CSP, DESIGN_SCHEME, designPreviewHtml } from './design'
import { StateStore } from './store'
import { SecretVault } from './store/secrets'
import { SessionService } from './engine/sessions'
import { MemoryService } from './memory'
import { CronService } from './cron'
import { stopLearn } from './learn'
import {
  consolidationProposalToInbox,
  gatewayConfigFrom,
  memoryProposalToInbox,
  permToRenderer,
  registerIpc,
  streamToRenderer,
  type IpcDeps
} from './ipc'

let win: BrowserWindow | null = null
let store: StateStore | null = null

// 设计稿预览协议（D12.3）：必须在 app ready 前注册特权 scheme
protocol.registerSchemesAsPrivileged([
  { scheme: DESIGN_SCHEME, privileges: { standard: true, secure: true } }
])

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    title: 'LetsCoding',
    backgroundColor: '#F3F4F7',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // DECISIONS D3 安全基线：renderer 零 Node 访问，verify.sh G2 断言此配置
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.on('closed', () => {
    win = null
  })

  // 冷启动探针（D3 目的断言）：仅在探针 env 下打点，生产运行无副作用
  if (process.env['LC_LAUNCH_PROBE']) {
    win.webContents.once('did-finish-load', () => {
      console.log('LAUNCH_OK')
    })
  }

  // 视觉核对探针：驱动 工作台→记忆库→设置→新建弹窗 依次截图，PNG 以 base64 走 stdout
  // 由 scripts/shot-app.mjs 落盘（G7 单写者红线：src/ 内不写文件系统）
  if (process.env['LC_SHOT_PROBE']) {
    win.webContents.once('did-finish-load', () => {
      void (async () => {
        const w = win
        if (!w) return
        const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
        const snap = async (name: string): Promise<void> => {
          const img = await w.webContents.capturePage()
          console.log(`SHOT:${name}:${img.toPNG().toString('base64')}`)
        }
        const click = (sel: string): Promise<unknown> =>
          w.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(sel)})?.click()`, true)
        await wait(1500)
        await click('.sess') // 打开首条会话（只读回放），让中栏/右栏有内容可核
        await wait(900)
        await snap('work')
        // Markdown 渲染核对：滚到首个富文本块（标题/列表/加粗）截图
        await w.webContents.executeJavaScript(
          `(() => { const el = document.querySelector('.md h2, .md h3, .md ul, .md blockquote'); el?.scrollIntoView({ block: 'center' }) })()`,
          true
        )
        await wait(400)
        await snap('mdview')
        // 工具批次核对：滚到首个批次容器（优先带折叠行的）
        await w.webContents.executeJavaScript(
          `(() => { const el = document.querySelector('.tg-more') ?? document.querySelector('.tgroup'); el?.scrollIntoView({ block: 'center' }) })()`,
          true
        )
        await wait(400)
        await snap('batch')
        // DOM 计数（批次合并断言用）：tgroup/散装 tool/组内行
        const counts = await w.webContents.executeJavaScript(
          `JSON.stringify({ tgroup: document.querySelectorAll('.tgroup').length, tool: document.querySelectorAll('.tool').length, tgrow: document.querySelectorAll('.tg-row').length })`,
          true
        )
        console.log(`DOMCOUNTS:${counts}`)
        // 右栏展开态核对：点开收起的小节（Skills/本轮改动），并展开首个改动文件的 mini diff
        await w.webContents.executeJavaScript(
          `(() => {
            for (const h of document.querySelectorAll('.rail .sec-h'))
              if (h.querySelector('.sec-cv')?.textContent === '▸') h.click()
          })()`,
          true
        )
        await wait(300)
        await click('.rail .frow')
        await wait(300)
        await snap('rail')
        // 右栏下半部（待办/子Agent/会话小节）：收起本轮改动后滚到底截图
        await w.webContents.executeJavaScript(
          `(() => {
            for (const h of document.querySelectorAll('.rail .sec-h'))
              if (h.textContent?.includes('本轮改动')) h.click()
            const rail = document.querySelector('.rail')
            if (rail) rail.scrollTop = rail.scrollHeight
          })()`,
          true
        )
        await wait(300)
        await snap('rail-bottom')
        // 面板折叠核对：工具栏 ◧◨ 收起左右栏 → 边缘恢复条 → 点击恢复
        await w.webContents.executeJavaScript(
          `[...document.querySelectorAll('.sh-right .mini')].filter((b) => b.textContent === '◧' || b.textContent === '◨').forEach((b) => b.click())`,
          true
        )
        await wait(350)
        await snap('panels')
        await w.webContents.executeJavaScript(
          `[...document.querySelectorAll('.edge-restore')].forEach((b) => b.click())`,
          true
        )
        await wait(350)
        // 「自定义」弹窗核对：Skills 页 → 插件页
        await click('.sa-cust')
        await wait(900)
        await snap('customize')
        await w.webContents.executeJavaScript(
          `[...document.querySelectorAll('.cn-item')].find((n) => n.textContent?.includes('连接器'))?.click()`,
          true
        )
        await wait(3500) // gh 远端探测 ~1s + 余量；glab 走本地配置即时
        await snap('cust-connectors')
        await w.webContents.executeJavaScript(
          `[...document.querySelectorAll('.cn-item')].find((n) => n.textContent?.includes('插件'))?.click()`,
          true
        )
        await wait(300)
        await snap('cust-plugins')
        await w.webContents.executeJavaScript(`document.querySelector('.overlay')?.click()`, true)
        await wait(300)
        // 新建分组弹窗（应用内 prompt 替代 window.prompt）
        await w.webContents.executeJavaScript(
          `[...document.querySelectorAll('.grp-act')].find((a) => a.title === '新建分组')?.click()`,
          true
        )
        await wait(400)
        await snap('gprompt')
        await w.webContents.executeJavaScript(
          `[...document.querySelectorAll('.modal-f .mini')].find((b) => b.textContent === '取消')?.click()`,
          true
        )
        await wait(250)
        // 可选：LC_SHOT_FIND=标题片段 → 打开匹配会话并滚到首个子 agent 容器截图
        const find = process.env['LC_SHOT_FIND']
        if (find) {
          await w.webContents.executeJavaScript(
            `(() => { const el = [...document.querySelectorAll('.sess')].find((e) => e.textContent?.includes(${JSON.stringify(find)})); el?.click() })()`,
            true
          )
          await wait(1200)
          await w.webContents.executeJavaScript(
            `document.querySelector('.tg-task')?.scrollIntoView({ block: 'center' })`,
            true
          )
          await wait(300)
          await snap('target')
        }
        await click('.side-foot .foot-row')
        await wait(800)
        await snap('memory')
        await click('.back')
        await wait(400)
        await click('.side-foot .foot-row:nth-child(2)')
        await wait(800)
        await snap('settings')
        // 外观即改即生效核对：切暖白 → 截图 → 切回默认（不留残留偏好）
        await w.webContents.executeJavaScript(
          `[...document.querySelectorAll('.swatch')].find((b) => b.textContent?.includes('暖白'))?.click()`,
          true
        )
        await wait(400)
        await snap('appearance')
        await w.webContents.executeJavaScript(
          `[...document.querySelectorAll('.swatch')].find((b) => b.textContent?.includes('默认'))?.click()`,
          true
        )
        await wait(300)
        await click('.back')
        await wait(400)
        await click('.sa-new')
        await wait(600)
        await snap('newmodal')
        // 记忆库编辑态:关弹窗→进记忆库→选首条→点编辑
        await w.webContents.executeJavaScript(
          `document.querySelector('.modal-f .mini')?.click()`,
          true
        )
        await wait(300)
        await click('.side-foot .foot-row')
        await wait(700)
        await click('.mem-list .mrow')
        await wait(400)
        await w.webContents.executeJavaScript(
          `[...document.querySelectorAll('.md-head .acts .mini')].find(b=>b.textContent==='编辑')?.click()`,
          true
        )
        await wait(400)
        await snap('memedit')
        // 斜杠 skill 提示：回工作台→开回放→点「继续会话」→输入 /
        await click('.back')
        await wait(500)
        await click('.sess')
        await wait(700)
        await click('.banner .mini.acc')
        await wait(400)
        await w.webContents.executeJavaScript(
          `(() => { const t = document.querySelector('.cbox textarea'); if (!t) return; t.focus(); document.execCommand('insertText', false, '/') })()`,
          true
        )
        await wait(500)
        await snap('slash')
        // TaskWork 模式页（D10）：左栏顶部 Tab 切换 → 整页。
        // 有任务时等运行收尾（补跑 e2e 核对，上限 150s；页内 5s 轮询会自动刷出结果），无任务立即截
        await w.webContents.executeJavaScript(
          `[...document.querySelectorAll('.mode-tabs .mtab')].find((t) => !t.classList.contains('on'))?.click()`,
          true
        )
        await wait(1200)
        const twDeadline = Date.now() + 150_000
        while (Date.now() < twDeadline) {
          const settled = await w.webContents.executeJavaScript(
            `(() => {
              if (!document.querySelectorAll('.tw-jrow').length) return true
              const sts = [...document.querySelectorAll('.twh-st')]
              return sts.length > 0 && !sts.some((s) => s.classList.contains('run'))
            })()`,
            true
          )
          if (settled) break
          await wait(3000)
        }
        await snap('taskwork')
        // 真实续聊 e2e（LC_SHOT_TW_E2E 门控，消耗真实 token）：就选中 run 的报告追问一句 →
        // 等 idle → 截图（fork 回绑 + hidden 由 dev 库断言，跑完脚本侧核对）
        if (process.env['LC_SHOT_TW_E2E']) {
          await w.webContents.executeJavaScript(
            `(() => { const t = document.querySelector('.tw-comp .dz-in'); if (!t) return; t.focus(); document.execCommand('insertText', false, '用一句话总结这份报告的核心结论。') })()`,
            true
          )
          await wait(300)
          await w.webContents.executeJavaScript(`document.querySelector('.tw-comp .dz-send')?.click()`, true)
          const twDl = Date.now() + 240_000
          await wait(3000)
          while (Date.now() < twDl) {
            const busy = await w.webContents.executeJavaScript(
              `[...document.querySelectorAll('.tw-chat .dz-m-status')].some((s) => s.textContent?.includes('正在'))`,
              true
            )
            if (!busy) break
            await wait(3000)
          }
          await wait(800)
          await snap('taskwork-chat')
        }
        // Design 模式页（D11）：文件列表 + sandbox 预览 + 设计对话三栏。
        // LC_SHOT_DESIGN_CWD=目录名后缀 → 用左列项目下拉切到目标项目（e2e 用）
        await w.webContents.executeJavaScript(
          `[...document.querySelectorAll('.mode-tabs .mtab')].find((t) => t.title?.startsWith('Design'))?.click()`,
          true
        )
        await wait(1200)
        const dzCwd = process.env['LC_SHOT_DESIGN_CWD']
        if (dzCwd) {
          await w.webContents.executeJavaScript(
            `(() => {
              const s = document.querySelector('.dz-cwd')
              if (!s) return
              const opt = [...s.options].find((o) => o.value.endsWith(${JSON.stringify(dzCwd)}))
              if (!opt) return
              s.value = opt.value
              s.dispatchEvent(new Event('change', { bubbles: true }))
            })()`,
            true
          )
          await wait(1200)
        }
        await snap('design')
        // LC_SHOT_PERM：主进程直发一条假权限请求（requestId 无对应 pending，respond 是安全 no-op）——
        // 核对 M20-A：非 Code 屏右下角权限浮层可就地处理 + 所属模式 tab 红点
        if (process.env['LC_SHOT_PERM']) {
          w.webContents.send(Channels.PermRequest, {
            requestId: 'probe-perm',
            handle: 'probe-code-session',
            toolName: 'Bash',
            input: { command: 'npm run build' },
            reason: 'prompt',
            hasSuggestions: true
          })
          await wait(500)
          await snap('perm-overlay-design')
          await w.webContents.executeJavaScript(
            `[...document.querySelectorAll('.perm-overlay .mini')].find((b) => b.textContent === '拒绝')?.click()`,
            true
          )
          await wait(400)
          await snap('perm-dismissed')
        }
        // LC_SHOT_RESIZE（M21b）：模拟拖拽分隔条，断言左列/对话列宽度真实变化
        if (process.env['LC_SHOT_RESIZE']) {
          const drag = async (idx: number, dx: number): Promise<void> => {
            await w.webContents.executeJavaScript(
              `(() => {
                const h = document.querySelectorAll('.designz .col-rsz')[${idx}]
                if (!h) return
                const r = h.getBoundingClientRect()
                const x = r.left + 2, y = r.top + r.height / 2
                h.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }))
                window.dispatchEvent(new MouseEvent('mousemove', { clientX: x + ${dx}, clientY: y }))
                window.dispatchEvent(new MouseEvent('mouseup', {}))
              })()`,
              true
            )
            await wait(300)
          }
          const widthOf = (sel: string): Promise<number> =>
            w.webContents.executeJavaScript(
              `Math.round(document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect().width ?? -1)`,
              true
            )
          // 断言宽度真实变化；首尾快照回写 panelLayout——固定幅度拖回在 clamp 边界不净零
          //（起始贴 min/max 时会落错位），快照回写在任何起始值下都无污染
          const before = await w.webContents.executeJavaScript(
            `window.letscoding.settings.get().then((s) => s.panelLayout)`,
            true
          )
          const side0 = await widthOf('.dz-list')
          await drag(0, 70) // 左列右缘向右 → 变宽（三模式共享 sideW）
          const side1 = await widthOf('.dz-list')
          await snap('design-resized')
          const chat0 = await widthOf('.dz-chat')
          await drag(1, -80) // 对话列左缘向左 → 变宽
          const chat1 = await widthOf('.dz-chat')
          console.log(`RESIZE:side ${side0}->${side1} chat ${chat0}->${chat1}`)
          await wait(600) // 等 300ms 去抖落盘后再回写快照，避免竞态覆盖
          if (typeof before === 'string') {
            await w.webContents.executeJavaScript(
              `window.letscoding.settings.set({ panelLayout: ${JSON.stringify(before)} })`,
              true
            )
          }
        }
        // LC_SHOT_SCROLL：D12.3 滚动保持全环路核验——shot-app.mjs 预置 ~/Desktop/design/scroll-probe.html
        // （300vh 高稿），这里驱动 iframe 滚到 600 → 探针读数归零 → 请求脚本 touch 稿件（stdout 协作）
        // → mtime 轮询重载 → 断言滚动恢复非 0
        if (process.env['LC_SHOT_SCROLL']) {
          await w.webContents.executeJavaScript(
            `[...document.querySelectorAll('.dz-frow')].find((r) => r.textContent?.includes('scroll-probe'))?.click()`,
            true
          )
          await wait(1000)
          const dbg = await w.webContents.executeJavaScript(
            `(() => { const f = document.querySelector('.dz-iframe'); return JSON.stringify({ hasFrame: !!f, viaScheme: !!f?.src?.startsWith('lcdesign://'), cw: !!(f && f.contentWindow) }) })()`,
            true
          )
          console.log(`SCROLL_DBG:${dbg}`)
          await w.webContents.executeJavaScript(
            `document.querySelector('.dz-iframe')?.contentWindow?.postMessage({ t: 'dz-restore', y: 600 }, '*')`,
            true
          )
          await wait(800)
          const mem = await w.webContents.executeJavaScript(
            `document.querySelector('.dz-canvas')?.dataset?.scrollY ?? 'none'`,
            true
          )
          console.log(`SCROLL_MEM:${mem}`)
          await w.webContents.executeJavaScript(
            `(() => { const c = document.querySelector('.dz-canvas'); if (c) c.dataset.scrollY = '0' })()`,
            true
          )
          console.log('SCROLL_TOUCH') // shot-app.mjs 收到后给稿件追加注释（mtime+内容变化 → 预览重载）
          await wait(9500) // 空闲 6s mtime 轮询 + 重载 + onLoad 恢复 + 上报的余量
          const restored = await w.webContents.executeJavaScript(
            `document.querySelector('.dz-canvas')?.dataset?.scrollY ?? 'none'`,
            true
          )
          console.log(`SCROLL_RESTORE:${restored}`)
          await snap('design-scroll')
          // LC_SHOT_HISTORY（D12.4）：预置 design_sessions 映射后，选中稿应回放既往对话到右列
          if (process.env['LC_SHOT_HISTORY']) {
            await wait(1500)
            const n = await w.webContents.executeJavaScript(
              `document.querySelectorAll('.dz-msgs .dz-m-user, .dz-msgs .dz-m-ai, .dz-msgs .dz-m-tool').length`,
              true
            )
            console.log(`HISTORY_ITEMS:${n}`)
            await snap('design-history')
          }
        }
        // 真实设计对话 e2e（LC_SHOT_DESIGN_E2E 门控，消耗真实 token）：出新稿 → 切选 → 改稿
        if (process.env['LC_SHOT_DESIGN_E2E']) {
          const typeAndSend = async (text: string): Promise<void> => {
            await w.webContents.executeJavaScript(
              `(() => { const t = document.querySelector('.dz-in'); if (!t) return; t.focus(); document.execCommand('insertText', false, ${JSON.stringify(text)}) })()`,
              true
            )
            await wait(300)
            await w.webContents.executeJavaScript(`document.querySelector('.dz-send')?.click()`, true)
          }
          const waitIdle = async (maxMs: number): Promise<void> => {
            const dl = Date.now() + maxMs
            await wait(3000)
            while (Date.now() < dl) {
              const busy = await w.webContents.executeJavaScript(
                `[...document.querySelectorAll('.dz-m-status')].some((s) => s.textContent?.includes('正在'))`,
                true
              )
              if (!busy) break
              await wait(3000)
            }
          }
          await typeAndSend(
            '在 design/ 目录新建一份 e2e-probe.html：自包含 HTML，浅色底一张小卡片，卡片里写 "E2E OK"，50 行以内。直接写文件，不要执行任何命令。'
          )
          await waitIdle(240_000)
          await wait(4500) // 等列表 4s 轮询刷出新稿
          await snap('design-e2e-new')
          await w.webContents.executeJavaScript(
            `[...document.querySelectorAll('.dz-frow')].find((r) => r.textContent?.includes('e2e-probe'))?.click()`,
            true
          )
          await wait(900)
          await typeAndSend('把 e2e-probe.html 里 "E2E OK" 的文字颜色改成 #15803d。直接改文件，不要执行任何命令。')
          await waitIdle(240_000)
          await wait(3000) // 运行中 2s mtime 轮询：改稿落盘 → 预览自动刷新（fresh 提示 4s 窗口）
          await snap('design-e2e-edit')
        }
        // 切回 Code：左栏应出现「定时任务」分组（报告即会话）
        await w.webContents.executeJavaScript(
          `[...document.querySelectorAll('.mode-tabs .mtab')].find((t) => t.title?.startsWith('Code'))?.click()`,
          true
        )
        await wait(800)
        await snap('taskwork-code')
        console.log('SHOTS_DONE')
      })()
    })
  }

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// GUI 启动（Finder/Dock）的进程 PATH 不含 Homebrew，gh/glab 等 CLI 会误报「未安装」，
// 会话内 Bash 同样找不到它们；补齐常用 bin 路径（幂等），连接器探测与会话子进程都继承
for (const p of ['/opt/homebrew/bin', '/usr/local/bin']) {
  if (!(process.env['PATH'] ?? '').split(':').includes(p)) {
    process.env['PATH'] = `${process.env['PATH'] ?? ''}:${p}`
  }
}

app.whenReady().then(() => {
  // 设计稿预览供稿（D12.3）：只读、校验同 DesignRead，响应自带收紧 CSP
  //（网络全禁 + 仅内联样式/脚本——srcdoc 会继承宿主 CSP 禁掉内联脚本，独立 scheme 才有自己的策略）
  protocol.handle(DESIGN_SCHEME, (req) => {
    const r = designPreviewHtml(req.url)
    return new Response(r.body, {
      status: r.status,
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': DESIGN_PREVIEW_CSP }
    })
  })

  // 打包版首启：从 dev 期 userData（letscoding）迁移 state.db（分组/设置/规则/回收站）。
  // 网关密钥不迁——safeStorage 的 Keychain 条目随应用名变化，打包版重填一次即可。
  try {
    const userData = app.getPath('userData')
    const dbPath = join(userData, 'state.db')
    const devDb = join(dirname(userData), 'letscoding', 'state.db')
    if (app.isPackaged && !existsSync(dbPath) && existsSync(devDb)) {
      mkdirSync(userData, { recursive: true })
      copyFileSync(devDb, dbPath)
    }
  } catch (err) {
    console.error('[migrate] state.db copy failed:', err)
  }
  try {
    store = new StateStore(join(app.getPath('userData'), 'state.db'))
  } catch (err) {
    // 原生模块 ABI 未就位时不阻塞窗口启动（scripts/use-abi.mjs electron 可修复）
    console.error('[store] init failed:', err)
  }
  const vault = new SecretVault(join(app.getPath('userData'), 'secrets.enc.json'))

  const deps: IpcDeps = {
    store,
    vault,
    engine: null as unknown as SessionService,
    memory: store ? new MemoryService(join(homedir(), '.claude', 'projects'), store) : null,
    cron: null,
    getWindow: () => win
  }
  deps.engine = new SessionService({
    onStream: (handle, msg) => {
      streamToRenderer(deps, handle, msg)
      // TaskWork（D10）：cron 会话的 init 归组 / result 收尾走同一事件流
      deps.cron?.onStream(handle, msg)
    },
    onPermissionRequest: (req) => permToRenderer(deps, req),
    onMemoryProposal: (p) => memoryProposalToInbox(deps, p),
    onConsolidationProposal: (p) => consolidationProposalToInbox(deps, p),
    getDangerRules: () => store?.listDangerRules() ?? [],
    getWhitelist: () => store?.listWhitelist() ?? [],
    getConfig: () => gatewayConfigFrom(deps)
  })

  // TaskWork 调度器（D10）：30s tick + 启动即补跑检查；App 关闭自然停摆
  if (store) {
    deps.cron = new CronService(store, deps.engine, () => store?.getSetting('default_model') ?? null)
    deps.cron.start()
  }

  registerIpc(deps)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // 退出保护：有运行中会话先确认（中断的是"进行中的回答"，transcript 实时落盘不丢）
  let quitConfirmed = false
  app.on('before-quit', (e) => {
    const liveCount = deps.engine.liveSessions().length
    if (!quitConfirmed && liveCount > 0) {
      e.preventDefault()
      const choice = dialog.showMessageBoxSync({
        type: 'warning',
        buttons: ['取消', '仍要退出'],
        defaultId: 0,
        cancelId: 0,
        message: `有 ${liveCount} 个会话正在运行`,
        detail: '退出会中断正在运行的回答；对话记录已实时保存，重新打开后可从上次会话一键续聊。'
      })
      if (choice === 1) {
        quitConfirmed = true
        deps.engine.closeAll()
        app.quit()
      }
      return
    }
    deps.engine.closeAll()
  })
})

// D16：退出时回收学习平台里自己 spawn 的服务进程（用户自己起的不误杀）
app.on('quit', () => stopLearn())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
