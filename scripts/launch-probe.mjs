// 冷启动探针（D3 目的断言）：无头启动打包后的 Electron，验证 app ready→窗口→renderer 加载完成。
import { spawn } from 'node:child_process'
import electron from 'electron'

const child = spawn(electron, ['.', '--no-sandbox'], {
  env: { ...process.env, LC_LAUNCH_PROBE: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
})
let out = ''
child.stdout.on('data', (d) => (out += d))
child.stderr.on('data', (d) => (out += d))
setTimeout(() => {
  child.kill('SIGTERM')
  const ok = out.includes('LAUNCH_OK')
  console.log(ok ? 'PROBE: LAUNCH_OK' : 'PROBE: FAIL\n' + out.trim().split('\n').slice(-8).join('\n'))
  process.exit(ok ? 0 : 1)
}, 9000)
