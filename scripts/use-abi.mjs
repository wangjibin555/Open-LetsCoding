// better-sqlite3 ABI 切换：让 native 二进制匹配「当前运行的 runtime + ABI」。
// 背景：本机 CLT 收据缺失导致 node-gyp 源码编译不可用，只走官方 prebuilt（见 README）。
// 关键：按实际 ABI 号（process.versions.modules / electron ABI）做缓存键，而非仅 'node'/'electron'。
// 否则多 Node 版本共存时（如 dev 用 node22=ABI127、Stop hook 用 node24=ABI137）marker 会误判、留下错 ABI 的二进制。
//
// --cache-only：只保证 .cache/bs3 里存在目标 ABI 的副本并把其绝对路径打到 stdout（诊断走 stderr），
// 不改写 node_modules 的共享二进制、不动 marker。vitest / node 探针经 LC_BS3_BINDING 直接用缓存副本，
// 与运行中的 Electron dev app 互不干扰 —— 根治「verify 切 node ↔ dev 切 electron」的二进制竞态。
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const target = process.argv[2]
const cacheOnly = process.argv.includes('--cache-only')
if (target !== 'node' && target !== 'electron') {
  console.error('usage: node scripts/use-abi.mjs <node|electron> [--cache-only]')
  process.exit(2)
}

const root = join(import.meta.dirname, '..')
const moduleDir = join(root, 'node_modules', 'better-sqlite3')
const dest = join(moduleDir, 'build', 'Release', 'better_sqlite3.node')
const cacheDir = join(root, '.cache', 'bs3')
mkdirSync(cacheDir, { recursive: true })

const bs3Version = require(join(moduleDir, 'package.json')).version
const arch = process.arch

// 计算 runtime 与实际 ABI 号
let abi
if (target === 'electron') {
  const electronVersion = require(join(root, 'node_modules', 'electron', 'package.json')).version
  const { getAbi } = require('node-abi')
  abi = String(getAbi(electronVersion, 'electron'))
} else {
  // 'node' 目标：用当前进程的 ABI —— 谁运行本脚本，就为谁准备（自愈多 Node 版本）
  abi = process.versions.modules
}

const abiKey = `${target}-${abi}` // e.g. node-127 / node-137 / electron-133
const cached = join(cacheDir, `bs3-${abiKey}.node`)
const marker = join(cacheDir, 'current')

// 校验某个 .node 在 node 下能真正加载（子进程里跑，损坏会 SIGKILL —— 必须隔离才能捕获）。
// electron ABI 无法用 node 验证，只做存在性检查（真正加载在 App 内验证）。
function binaryLoads(path) {
  if (target !== 'node') return existsSync(path)
  if (!existsSync(path)) return false
  try {
    execFileSync(
      process.execPath,
      ['-e', `new (require('better-sqlite3'))(':memory:', { nativeBinding: ${JSON.stringify(path)} }).close()`],
      { cwd: root, stdio: 'ignore' }
    )
    return true
  } catch {
    return false
  }
}

// 下载目标 ABI 的 prebuilt 到临时目录，返回解出的 .node 路径（不触碰 node_modules）
function fetchToTemp() {
  const runtimeTag = target === 'electron' ? 'electron' : 'node'
  const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${bs3Version}/better-sqlite3-v${bs3Version}-${runtimeTag}-v${abi}-darwin-${arch}.tar.gz`
  const tmpDir = join(cacheDir, `tmp-${abiKey}`)
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })
  const tarball = join(tmpDir, 'bs3.tar.gz')
  for (let i = 0; i < 3; i++) {
    try {
      execFileSync('curl', ['-sSL', '--max-time', '180', '-o', tarball, url])
      execFileSync('tar', ['-xzf', tarball], { cwd: tmpDir })
      const extracted = join(tmpDir, 'build', 'Release', 'better_sqlite3.node')
      if (existsSync(extracted)) return extracted
    } catch {
      console.error(`[use-abi] download attempt ${i + 1} failed (${url}), retrying…`)
    }
  }
  return null
}

// 保证缓存副本存在且可加载（坏则重取一次）
function ensureCached() {
  if (binaryLoads(cached)) return true
  rmSync(cached, { force: true })
  const fetched = fetchToTemp()
  if (!fetched) return false
  copyFileSync(fetched, cached)
  rmSync(join(cacheDir, `tmp-${abiKey}`), { recursive: true, force: true })
  return binaryLoads(cached)
}

if (cacheOnly) {
  if (!ensureCached()) {
    console.error(`[use-abi] failed to obtain prebuilt binary for ${abiKey}`)
    process.exit(1)
  }
  console.error(`[use-abi] cache ready: ${abiKey}`)
  console.log(cached) // stdout 只输出路径，供 $(…) 捕获
  process.exit(0)
}

// 快速路径：dest 与目标 ABI 的缓存副本逐字节一致 → 已就位。
// 不信 marker（曾因 desync 出现 marker=electron 而 dest=node ABI，electron 侧无法加载验证、假通过）。
function sameFile(a, b) {
  if (!existsSync(a) || !existsSync(b)) return false
  const ba = readFileSync(a)
  const bb = readFileSync(b)
  return ba.length === bb.length && ba.equals(bb)
}
if (sameFile(dest, cached) && binaryLoads(dest)) {
  console.log(`[use-abi] already on ${abiKey}`)
  process.exit(0)
}

if (!ensureCached()) {
  console.error(`[use-abi] failed to obtain prebuilt binary for ${abiKey}`)
  process.exit(1)
}

// 把缓存复制到 dest 并刷新 marker（复制成本极低，彻底杜绝 marker↔二进制 desync）
// fresh clone + --ignore-scripts 下 build/Release 不存在（迁移后首次 dist 实测踩坑），先建目录
mkdirSync(dirname(dest), { recursive: true })
copyFileSync(cached, dest)
if (!binaryLoads(dest)) {
  console.error(`[use-abi] binary for ${abiKey} fails to load after copy to dest`)
  process.exit(1)
}
writeFileSync(marker, abiKey)
console.log(`[use-abi] switched to ${abiKey}`)
