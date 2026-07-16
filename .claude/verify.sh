#!/usr/bin/env bash
# LetsCoding verify gates —— DECISIONS 验收断言的机器判定入口，绿才算 done。
set -uo pipefail
cd "$(dirname "$0")/.."

FAIL=0
pass() { echo "✅ $1"; }
fail() { echo "❌ $1"; FAIL=1; }

# G1 · dep-lint（D2 手段③）：SDK import 仅允许 src/main/engine/**
HITS=$(grep -rln "@anthropic-ai/claude-agent-sdk" src --include='*.ts' --include='*.tsx' 2>/dev/null | grep -v '^src/main/engine/' || true)
if [ -z "$HITS" ]; then pass "G1 dep-lint: sdk import confined to engine"; else fail "G1 dep-lint: sdk imported outside engine: $HITS"; fi

# G2 · renderer 隔离（D3 手段）：contextIsolation 开启、无 nodeIntegration:true
if grep -q "contextIsolation: true" src/main/index.ts && ! grep -rq "nodeIntegration: true" src; then
  pass "G2 isolation: contextIsolation on, nodeIntegration off"
else
  fail "G2 isolation: renderer isolation config violated"
fi

# G8 · 整理会话工具硬闸（D9 红线：模型对既有记忆零写权）：consolidate 模式必须 disallow 写工具
if grep -q "opts.mode === 'consolidate' ? { disallowedTools: CONSOLIDATE_DISALLOWED_TOOLS }" src/main/engine/sessions.ts; then
  pass "G8 consolidate guard: session disallows write/exec tools"
else
  fail "G8 consolidate guard: consolidate session must set disallowedTools (D9 zero-write)"
fi

# G9 · 定时会话只读硬闸（D10 红线：无人值守只读 + 轮数封顶）：scheduled 模式必须接上 guard 常量
if grep -q "{ disallowedTools: SCHEDULED_DISALLOWED_TOOLS, maxTurns: SCHEDULED_MAX_TURNS }" src/main/engine/sessions.ts; then
  pass "G9 scheduled guard: cron session read-only + maxTurns capped"
else
  fail "G9 scheduled guard: scheduled session must wire SCHEDULED_DISALLOWED_TOOLS + SCHEDULED_MAX_TURNS (D10)"
fi

# G10 · 设计稿预览隔离（D11 红线）：iframe 必须 sandbox 且不含 allow-same-origin
if grep -q 'sandbox="allow-scripts"' src/renderer/src/DesignPane.tsx \
  && ! grep -q "allow-same-origin" src/renderer/src/DesignPane.tsx; then
  pass "G10 design preview: iframe sandboxed without same-origin"
else
  fail "G10 design preview: iframe must be sandbox=allow-scripts and never allow-same-origin (D11)"
fi

# G12 · cron 会话不进 Code 栏（D13 红线）：列表过滤 hidden + schema 落列
if grep -q "meta?.hidden === 1" src/main/ipc.ts \
  && grep -q "hidden INTEGER NOT NULL DEFAULT 0" src/main/store/index.ts; then
  pass "G12 hidden sessions: cron reports filtered from Code list"
else
  fail "G12 hidden sessions: SessionList must filter session_meta.hidden (D13)"
fi

# G13 · 全权委托护栏（D14 红线）：bypass 不走 SDK 裸跳权限档（否则 D7 危险硬门失去执行点）；
# 映射 acceptEdits + canUseTool 层 shouldAutoAllow 短路（危险命中不放行，弹卡链路照旧）
if ! grep -rq "bypassPermissions" src --include='*.ts' --include='*.tsx' \
  && grep -q "bypass: 'acceptEdits'" src/main/engine/permissionPolicy.ts \
  && grep -q "shouldAutoAllow(this.live.get(handle)?.uiMode, danger)" src/main/engine/sessions.ts; then
  pass "G13 bypass guard: maps to acceptEdits, danger list still asks"
else
  fail "G13 bypass guard: bypass must not use SDK raw skip mode; danger gate must stay wired (D14)"
fi

# G14 · 学习平台嵌入护栏（D16 红线）：iframe 仅指向本机回环 + 配置端口（且是组件里唯一的 src 模板）；
# 服务拉起仅限用户配置目录下的固定脚本名 start.sh（不接受任意命令）
if grep -q 'src={`http://127.0.0.1:' src/renderer/src/LearnPane.tsx \
  && [ "$(grep -c 'src={`' src/renderer/src/LearnPane.tsx)" = "1" ] \
  && grep -q "join(cfg.dir, 'start.sh')" src/main/learn.ts; then
  pass "G14 learn embed: loopback-only iframe + fixed start.sh spawn"
else
  fail "G14 learn embed: iframe must stay on 127.0.0.1 and spawn only start.sh (D16)"
fi

# G11 · 预览供稿隔离 + 滚动保持（D12.3）：lcdesign:// 供稿必须带网络全禁 CSP；滚动恢复接线在位
if grep -q "default-src 'none'" src/main/design.ts \
  && grep -q "dz-restore" src/main/design.ts \
  && grep -q 'src={`lcdesign://' src/renderer/src/DesignPane.tsx \
  && grep -q "dz-restore" src/renderer/src/DesignPane.tsx; then
  pass "G11 design preview: lcdesign:// serves no-network CSP + scroll restore wired"
else
  fail "G11 design preview: lcdesign scheme must serve default-src 'none' CSP and wire dz-restore (D12.3)"
fi

# G3 · 无明文 key（D8 红线）：追踪文件中不得出现网关/API key 形态字符串
if git grep -nE "sk-[A-Za-z0-9_-]{16,}" -- ':!*.lock' ':!package-lock.json' >/dev/null 2>&1; then
  fail "G3 secrets: plaintext key-like string found in tracked files"
else
  pass "G3 secrets: no plaintext keys in tracked files"
fi

# 失败日志落 .claude/verify-logs/（gitignored），一次性抖动也能事后诊断
LOG_DIR=".claude/verify-logs"
mkdir -p "$LOG_DIR"

# G4 · StateStore + danger 单测（D5/D6/D7 断言）。
# better-sqlite3 用 .cache/bs3 的 node ABI 副本（LC_BS3_BINDING），不改写 node_modules 共享二进制 ——
# 避免与运行中的 Electron dev app 互相切 ABI 的竞态（曾致 vitest worker 崩溃 / app store 初始化失败）。
LC_BS3_BINDING="$(node scripts/use-abi.mjs node --cache-only 2>"$LOG_DIR/abi.log")" || LC_BS3_BINDING=""
export LC_BS3_BINDING
if npx vitest run --silent >"$LOG_DIR/g4-vitest.log" 2>&1; then
  pass "G4 unit tests: vitest green"
else
  fail "G4 unit tests: vitest failed (log: $LOG_DIR/g4-vitest.log)"
fi

# G5 · typecheck
if npx tsc --noEmit -p tsconfig.node.json >"$LOG_DIR/g5-tsc-node.log" 2>&1 \
  && npx tsc --noEmit -p tsconfig.web.json >"$LOG_DIR/g5-tsc-web.log" 2>&1; then
  pass "G5 typecheck: node + web clean"
else
  fail "G5 typecheck: tsc errors (logs: $LOG_DIR/g5-tsc-*.log)"
fi

# G7 · 单写者断言（D6/D9 手段）：src/ 下文件系统写 / 删调用仅允许 memory.ts（记忆落盘·编辑·软删）
# 与 store/secrets.ts（密文）。删除类（unlink/rm/rmdir）随 D9 软删纳入，保证「记忆的写与删仅一处」。
WRITERS=$(grep -rlnE "writeFileSync|appendFileSync|createWriteStream|unlinkSync|\brmSync|rmdirSync" src --include='*.ts' --include='*.tsx' 2>/dev/null | grep -v '\.test\.ts$' | sort)
EXPECTED=$'src/main/memory.ts\nsrc/main/store/secrets.ts'
if [ "$WRITERS" = "$EXPECTED" ]; then
  pass "G7 single-writer: fs writes/deletes confined to memory.ts + secrets.ts"
else
  fail "G7 single-writer: unexpected fs writers/deleters: $(echo $WRITERS | tr '\n' ' ')"
fi

# G6 · M2 集成冒烟（D2 手段① 流量白名单 + D7 危险拦截 + D4 会话文件红线）。
# 需真实网关凭证；缺失则显式 SKIP（不静默略过 —— 未覆盖要可见）。
if [ -n "${LETSCODING_GATEWAY_HOST:-}" ] && [ -n "${LETSCODING_GATEWAY_KEY:-}" ]; then
  if npx tsx scripts/m2-smoke.mjs >"$LOG_DIR/g6-smoke.log" 2>&1; then
    pass "G6 m2 smoke: gateway-only traffic + danger gate + file red line"
  else
    fail "G6 m2 smoke: failed (log: $LOG_DIR/g6-smoke.log)"
  fi
else
  echo "⏭️  G6 m2 smoke: SKIPPED (set LETSCODING_GATEWAY_HOST/KEY to run the D2/D4/D7 integration gate)"
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "verify: ALL GREEN"
else
  echo "verify: FAILED"
  exit 1
fi
