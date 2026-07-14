import { execFileSync } from 'node:child_process'
import { defineConfig } from 'vitest/config'

// better-sqlite3 走独立的 node ABI 副本（.cache/bs3），不碰 node_modules 里 Electron 在用的那份。
// 外部（verify.sh）已设 LC_BS3_BINDING 时沿用；否则这里自取（缓存命中时 <100ms）。
const bs3Binding =
  process.env['LC_BS3_BINDING'] ??
  execFileSync(process.execPath, ['scripts/use-abi.mjs', 'node', '--cache-only'], {
    cwd: __dirname,
    encoding: 'utf8'
  }).trim()

export default defineConfig({
  // 渲染层组件测试（.tsx）用自动 JSX 运行时，与 electron-vite 构建行为一致
  esbuild: { jsx: 'automatic' },
  test: { env: { LC_BS3_BINDING: bs3Binding } }
})
