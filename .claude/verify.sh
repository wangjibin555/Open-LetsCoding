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

# G11 · 预览供稿隔离 + 滚动保持（D12.3）：lcdesign:// 供稿必须带网络全禁 CSP；滚动恢复接线在位
if grep -q "default-src 'none'" src/main/design.ts \
  && grep -q "dz-restore" src/main/design.ts \
  && grep -q 'src={`lcdesign://' src/renderer/src/DesignPane.tsx \
  && grep -q "dz-restore" src/renderer/src/DesignPane.tsx; then
  pass "G11 design preview: lcdesign:// serves no-network CSP + scroll restore wired"
else
  fail "G11 design preview: lcdesign scheme must serve default-src 'none' CSP and wire dz-restore (D12.3)"
fi

# G14 · 权限放行结果的 schema 必填项（issue #5）：SDK 的 PermissionResult 是个 union，
# allow 分支**运行时必填** `updatedInput: record`（sdk.d.ts 标可选，与运行时不一致，以运行时为准）。
# 少这个字段 → union 两条都不匹配 → `ZodError: expected record, received undefined`，
# 用户点了「同意」工具照样执行不了。旧 CLI 有 falling-back 兜底，随 SDK 打包的 2.1.202 没有。
# 值的正确性（原样回传、不改写入参）由 G4 vitest 打在返回对象上，此处只锁「没有第二条绕过工厂的路径」。
PERM_OK=1
# ① 唯一构造点存在
grep -q "export function allowResult(" src/main/engine/permissionPolicy.ts || PERM_OK=0
# ② 全仓生产代码里**每一处** `behavior: 'allow'` 都必须在同行或紧邻两行内带 updatedInput。
#    计数式：出现次数 == 带 updatedInput 的次数。测试文件不算（它要构造反例）。
ALLOW_N=$(grep -rn "behavior: 'allow'" src --include='*.ts' | grep -v '\.test\.ts:' | wc -l | tr -d ' ')
WITH_N=$(grep -rn -A2 "behavior: 'allow'" src --include='*.ts' | grep -v '\.test\.ts[:-]' | grep -c "updatedInput")
test "$ALLOW_N" = "$WITH_N" || PERM_OK=0
# ③ sessions.ts 的放行路径必须走工厂，不许自己拼对象
test "$(grep -c "allowResult(" src/main/engine/sessions.ts)" = "2" || PERM_OK=0
grep -qE "resolve\(\{ *behavior: 'allow'" src/main/engine/sessions.ts && PERM_OK=0
if [ "$PERM_OK" -eq 1 ]; then
  pass "G14 permission allow: every allow result carries updatedInput"
else
  fail "G14 permission allow: allow branch must include updatedInput or SDK rejects it with ZodError (#5)"
fi

# G15 · 外部拖入护栏（issue #7）。三条各自独立、缺一功能就是坏的：
# ① 导航护栏：Chromium 对**没被元素接住**的拖放，默认行为是导航到那个文件——
#    应用外壳被 file:// 替换掉，preload 暴露的整套 API 跟着一个非受控页面走。
#    这既是「拖进去没反应」的真因，也是安全红线。
# ② 路径来源：Electron 32 起 File.path 已移除（本仓 electron 35），
#    渲染层拿绝对路径的唯一正路是 preload 里的 webUtils.getPathForFile。
#    渲染层若直接读 f.path，编译期不报错、运行期恒为 undefined —— 静默坏掉。
# ③ 红线：拖入只改草稿，不得触发发送、不得写文件。
DROP_OK=1
grep -qE "webContents\.on\('will-navigate'" src/main/index.ts || DROP_OK=0
#    注册了还得真拦：`e.preventDefault()` 泛匹配会被 before-quit 那处喂饱（实测放行过），
#    所以咬 will-navigate 分支里那一行的完整形态。
grep -qF "if (!inShell) e.preventDefault()" src/main/index.ts || DROP_OK=0
grep -qE "webContents\.setWindowOpenHandler\(" src/main/index.ts || DROP_OK=0
grep -q "action: 'deny'" src/main/index.ts || DROP_OK=0
#    剔掉注释再断言：**那行「唯一正路是 webUtils.getPathForFile」的注释曾把这条 gate 喂饱**
#    ——函数体改空了它照样绿。断言只认真实调用形态。
grep -vE '^\s*(\*|//|/\*)' src/preload/index.ts | grep -qF "return webUtils.getPathForFile(f)" || DROP_OK=0
# 渲染层不许绕过 preload 自己读 File.path（Electron 32 起恒 undefined）
grep -rqE "\.dataTransfer\.files\[[0-9]+\]\.path|\bf\.path\b|file\.path\b" src/renderer --include='*.tsx' --include='*.ts' && DROP_OK=0
# 统一入口：两处 onDrop 都必须走 addDroppedFiles，不许一处只吃图片另一处全收
test "$(grep -c "addDroppedFiles(Array.from(e.dataTransfer.files))" src/renderer/src/App.tsx)" = "2" || DROP_OK=0
# 红线：拖入路径里不得出现发送动作。取**整个函数体**（awk 到闭合行），
# 固定行窗（-A12）盖不住 21 行的函数体，实测漏过注入在末尾的 send()。
awk '/const addDroppedFiles = useCallback/,/^  \)$/' src/renderer/src/App.tsx \
  | grep -qE "\bsend\(|sendMessage|submit\(" && DROP_OK=0
if [ "$DROP_OK" -eq 1 ]; then
  pass "G15 external drop: navigation fenced, paths via webUtils, draft-only"
else
  fail "G15 external drop: must fence will-navigate, take paths from webUtils (File.path is gone since Electron 32), and only touch the draft (#7)"
fi

# G16 · 公开线信息边界（红线）：**本仓是 PUBLIC 仓库**，追踪文件里不得出现
# 内部私有信息。G3 只挡凭据形态，挡不住「内部语境」——而后者同样是泄露：
# 私有仓库/内部编号的交叉引用、内部服务域名、本机绝对路径、内部业务方与项目代号。
# 已实际发生过一次：同步修复时把内部研发语境写进了注释与提交信息，本 gate 是那次的补救。
#
# ⚠️ 本 gate 只能管**追踪文件**。提交信息与 GitHub 上的 issue/PR 正文不在它的射程内，
#    那两处只能靠人：推之前自己读一遍要发出去的文字。
PUB_OK=1
# ① 内部语境的文字标记 + 内部服务域名 + 知识库路径。全仓禁。
LEAK_PAT='内部线|私有线|私有仓库|同源于私有|hicaspian|Knowledge-base'
#    本文件自身必须排除：它非得写出那些词才能禁它们，不排除就是永红的自触发闸
#    （同一形态今天已踩过一次：文档注释把断言喂饱）。
SCOPE=". :!*.lock :!package-lock.json :!.claude/verify.sh"
if git grep -nIE "$LEAK_PAT" -- $SCOPE >/dev/null 2>&1; then
  PUB_OK=0
  echo "   ↳ 内部语境："
  git grep -nIE "$LEAK_PAT" -- $SCOPE | head -6 | sed 's/^/     /'
fi
# ② 本机绝对家目录路径：**只在生产代码里禁**。
#    测试夹具与设计稿用 /Users/dev 这类占位路径是正当的，一并禁掉会让本 gate 误报——
#    而一个会误报的 gate 迟早被人关掉，比没有更糟。
if git grep -nIE "/Users/[A-Za-z0-9._-]+/" -- 'src' ':!*.test.ts' ':!*.test.tsx' >/dev/null 2>&1; then
  PUB_OK=0
  echo "   ↳ 生产代码里的绝对家目录路径："
  git grep -nIE "/Users/[A-Za-z0-9._-]+/" -- 'src' ':!*.test.ts' ':!*.test.tsx' | head -6 | sed 's/^/     /'
fi
if [ "$PUB_OK" -eq 1 ]; then
  pass "G16 public boundary: no internal-only references in tracked files"
else
  fail "G16 public boundary: tracked files must not carry internal context (private repo refs, internal hosts, local paths)"
fi

# G17 · AskUserQuestion 提问护栏（D18 红线，issue #10）：它**不是权限门、是取答案**。
# SDK 契约：allow 分支必须经 updatedInput 回传 { questions, answers } 当 tool_result；
# 取消/空答案 → deny（模型收到明确拒绝，而不是一个没有 answers 的空结果）。
ASK_OK=1
grep -q "toolName === 'AskUserQuestion'" src/main/engine/sessions.ts || ASK_OK=0
grep -q "buildQuestionResult" src/main/engine/sessions.ts || ASK_OK=0
grep -q "behavior: 'allow', updatedInput: { questions, answers }" src/main/engine/permissionPolicy.ts || ASK_OK=0
# **真红线是顺序**：必须拦在 shouldAutoAllow 之前——连 bypass 全权委托档也要真的问。
# 只验「两个字符串都存在」验不出这一条：把拦截挪到 shouldAutoAllow 之后，
# bypass 档会自动放行并回一个没有 answers 的结果，而字符串断言全绿。故比行号。
Q_LINE=$(grep -n "toolName === 'AskUserQuestion'" src/main/engine/sessions.ts | head -1 | cut -d: -f1)
A_LINE=$(grep -n "shouldAutoAllow(this.live.get(handle)?.uiMode" src/main/engine/sessions.ts | head -1 | cut -d: -f1)
if [ -n "$Q_LINE" ] && [ -n "$A_LINE" ]; then
  [ "$Q_LINE" -lt "$A_LINE" ] || ASK_OK=0
else
  ASK_OK=0
fi
if [ "$ASK_OK" -eq 1 ]; then
  pass "G17 ask-question: intercepted before the perm gate, answers wired to updatedInput"
else
  fail "G17 ask-question: AskUserQuestion must be intercepted BEFORE shouldAutoAllow and answered via updatedInput (D18)"
fi

# G18 · 长会话流式性能红线（issue #12）。这三条**看不出功能差别**——回退了界面照样
# 正确，只是长会话重新变卡，所以必须机器守。实测：512 条消息全量重解析 132ms，
# 而流式期间每个 text_delta 都触发一次 → 主线程 132% 打满；修复后 0.5ms（267×）。
PERF_OK=1
# ① Markdown 必须 memo（值断言在 G4 vitest，打在导出对象的 $$typeof 上，不是 grep）
grep -q "export default memo(MarkdownView)" src/renderer/src/Markdown.tsx || PERF_OK=0
# ② **先于 ① 成立**：内联对象字面量会让 prop 身份每次都变，memo 永远比较不通过——
#    这正是原实现的形态（components={{…}}），也是这次卡顿的直接放大器。
grep -qE "remarkPlugins=\{\[|components=\{\{" src/renderer/src/Markdown.tsx && PERF_OK=0
# ③ 流式通知按帧合并：一帧内多个 delta 只重渲染一次，上限锁死 60/s。
grep -q "rafRef.current = requestAnimationFrame" src/renderer/src/useStream.ts || PERF_OK=0
grep -qE "^\s*if \(handle === activeRef.current\) bump" src/renderer/src/useStream.ts && PERF_OK=0
if [ "$PERF_OK" -eq 1 ]; then
  pass "G18 flow perf: markdown memoized, stable props, stream commits coalesced per frame"
else
  fail "G18 flow perf: long sessions relapse into per-token full re-parse (#12)"
fi

# G19 · 超长单条消息的重解析预算（issue #14）。与 G18 同类：回退了界面照样正确，
# 只是长消息重新卡住。实测（真 Chromium，短文本挂载→长到 L→稳态流式 3s 的主线程占用）：
#   L=6k 19.3%→12.3% ／ 12k 35.4%→16.3% ／ 40k 90.3%→18.1%
# 数值断言在 G4 vitest（TypeText.test.ts，打在 tickMsFor/revealStep 的真返回值上）；
# 这里只守**形态**——那几条数值闸拦不住「把 tick 又冻回挂载时」这类改法。
TT_OK=1
TT_SRC="src/renderer/src/TypeText.tsx"
# 剥注释后再判：解释历史的注释提到旧常量名不该算违规（本闸初版栽过这个）
TT_CODE="$(sed 's://.*::' "$TT_SRC")"
# ① 步进间隔取自**当前** text.length，而不是挂载时快照 —— #14 的根因就是后者
printf '%s' "$TT_CODE" | grep -q "tickMsFor(text.length)" || TT_OK=0
# ② useRef(...).current 的捕获式里不得再出现长度判据（冻结长度 = 复现 #14）
printf '%s' "$TT_CODE" | grep -qE "useRef\([^)]*\.length[^)]*\)\.current" && TT_OK=0
# ③ 定时器必须随档位重建，否则 tick 算了也用不上
printf '%s' "$TT_CODE" | grep -q "\[done, tick\]" || TT_OK=0
# ④ 反向闸不得复活：关掉动画后 Markdown 直接吃 text，而底层流以 ≤60Hz 换文本，
#    比打字机的 42Hz 更勤 —— 12k 实测 47.6% vs 35.4%，「超长就不动画」是负优化
printf '%s' "$TT_CODE" | grep -q "MAX_ANIMATE_CHARS" && TT_OK=0
# ⑤ 数值闸本身不得被删：负向红线（≤4000 字逐帧不变）、预算、追平墙钟这三条打在
#    tickMsFor/revealStep 的**真返回值**上，跑在 G4 的 vitest 里。这里只确认它们还在——
#    否则上面四条形态闸绿着，值却可以被随便改。
TT_TEST="src/renderer/src/TypeText.test.ts"
for NEEDLE in "负向红线" "预算断言" "目的断言" "手段断言"; do
  grep -q "$NEEDLE" "$TT_TEST" || TT_OK=0
done
if [ "$TT_OK" -eq 1 ]; then
  pass "G19 typewriter budget: tick derives from current length, ≤4000 chars byte-identical"
else
  fail "G19 typewriter budget: long messages relapse into 42Hz full re-parse (#14)"
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
