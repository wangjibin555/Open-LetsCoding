// 侧栏视觉核对：把 Sidebar 用样例数据渲染进一个真实窗口截图（纯 props，无 IPC）。
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 300, height: 860, show: false })
  await win.loadFile(join(process.cwd(), 'out/renderer/preview.html'))
  await new Promise((r) => setTimeout(r, 1200))
  const img = await win.webContents.capturePage()
  writeFileSync(process.env.SHOT_OUT || '/tmp/lc-sidebar.png', img.toPNG())
  console.log('SHOT_SAVED')
  app.quit()
})
