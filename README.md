# LetsCoding

本地优先的多模型 coding agent 桌面客户端：外形与记忆复用本机 `~/.claude` 体系，推理经 LiteLLM 网关路由（Claude 系为主力质量线）。

## 功能

- **Code**：多会话编码，复用 `~/.claude` 的会话历史 / 记忆 / 技能；按工作目录自动分组，支持置顶、拖拽、搜索。
- **TaskWork**：定时任务——让 agent 按天/周/每 N 小时自动跑复盘、周报、待办盘点。只读执行；App 关闭错过时段会在下次打开时补跑；每个任务是一条持续的对话流，报告可就地追问。
- **Design**：对话式产出 / 迭代自包含 HTML 设计稿，sandbox 隔离预览（三档宽度），改稿即时刷新。
- **记忆库**：查看 / 编辑 / 整理本机记忆，沉淀建议先入收件箱、确认后才写盘。
- **安全基线**：渲染层零 Node 访问；危险命令拦截清单；网关密钥经系统 Keychain 加密存储，绝不落明文。

## 开发环境

```bash
npm install --ignore-scripts   # 见下方 better-sqlite3 说明
npm rebuild electron           # 下载 Electron 二进制
npm run test                   # 单测（自动切 Node ABI）
npm run dev                    # 启动开发窗口（自动切 Electron ABI）
npm run verify                 # 跑全部红线 gate
```

### 网关集成 gate（G6）

`npm run verify` 的 G6 是真网关驱动的集成冒烟（出站流量白名单 + 危险拦截 + 会话文件红线），
需要凭证；缺失时显式 SKIP 而非静默略过：

```bash
export LETSCODING_GATEWAY_HOST=https://<your-litellm-host>
export LETSCODING_GATEWAY_KEY=sk-...
npm run verify        # G6 转为实跑，断言出站流量仅到网关 host
```

### better-sqlite3 二进制与多 Node ABI

本机 Xcode CLT 的 pkg 收据缺失（`pkgutil --pkg-info=com.apple.pkg.CLTools_Executables` 报 No receipt），
node-gyp 源码编译不可用，故默认跳过 install scripts，改用官方 prebuilt 二进制。
`scripts/use-abi.mjs` 负责让 `better_sqlite3.node` 匹配**当前运行的 runtime + 实际 ABI 号**：

- `npm run test` / `verify` 前自动切到运行它的那个 Node 的 ABI；`npm run dev` 前切到 Electron ABI。
- 缓存按 ABI 号分文件（`.cache/bs3/bs3-node-127.node`、`bs3-node-137.node`、`bs3-electron-133.node`…），
  因此多个 Node 版本共存也不冲突（例如 dev 用 Node 22 / ABI 127，而 Stop hook 经 nvm 用 Node 24 / ABI 137）。
- better-sqlite3 需 ≥12.x —— 只有 12.x 起才发布 Node 24（ABI 137）的 darwin-arm64 预编译。

注意 Node 与 Electron ABI 共用同一个 `build/Release/better_sqlite3.node` 路径，跑单测与跑 App 前需各自切换。
