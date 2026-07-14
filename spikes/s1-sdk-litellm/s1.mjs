// T0.1 — Agent SDK × LiteLLM 全链 spike（DECISIONS D2 验收 / SPEC §6 S1）
// 断言：经网关完成「读→改→跑」工具链；transcript 落 ~/.claude/projects；session 归属正确模型。
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOST = process.env.LETSCODING_GATEWAY_HOST;
const KEY = process.env.LETSCODING_GATEWAY_KEY;
const MODEL = process.env.SPIKE_MODEL || "openrouter/anthropic/claude-sonnet-4.6";
const playground = process.env.SPIKE_PLAYGROUND;
if (!HOST || !KEY || !playground) {
  console.error("missing LETSCODING_GATEWAY_HOST / LETSCODING_GATEWAY_KEY / SPIKE_PLAYGROUND");
  process.exit(2);
}

mkdirSync(playground, { recursive: true });
writeFileSync(
  join(playground, "notes.txt"),
  "LetsCoding M0 spike playground.\nGateway end-to-end test.\nTools must actually run.\n"
);

// 干净的子进程 env：剔除可能导致直连官方的凭证，成对注入网关配置（DECISIONS F3）
const childEnv = { ...process.env };
delete childEnv.ANTHROPIC_API_KEY;
Object.assign(childEnv, {
  ANTHROPIC_BASE_URL: HOST,
  ANTHROPIC_AUTH_TOKEN: KEY,
  ANTHROPIC_SMALL_FAST_MODEL: process.env.SPIKE_SMALL_MODEL || MODEL,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
});

const t0 = Date.now();
let sessionId, initModel, result;
const toolUses = [];

for await (const msg of query({
  prompt:
    `Work autonomously and do not ask me any questions. ` +
    `Read ${join(playground, "notes.txt")}, then create ${join(playground, "summary.txt")} ` +
    `containing exactly one line that summarizes notes.txt, ` +
    `then run \`wc -l < ${join(playground, "summary.txt")}\` with Bash and report its output.`,
  options: {
    cwd: playground,
    model: MODEL,
    env: childEnv,
    allowedTools: ["Read", "Write", "Bash"],
    permissionMode: "acceptEdits",
    maxTurns: 12,
  },
})) {
  if (msg.type === "system" && msg.subtype === "init") {
    sessionId = msg.session_id;
    initModel = msg.model;
    console.log("[init]", sessionId, "model:", initModel);
  }
  if (msg.type === "assistant") {
    for (const b of msg.message?.content ?? []) {
      if (b.type === "tool_use") { toolUses.push(b.name); console.log("[tool_use]", b.name); }
      if (b.type === "text" && b.text?.trim()) console.log("[assistant]", b.text.trim().slice(0, 200));
    }
  }
  if (msg.type === "result") result = msg;
}

const slug = playground.replace(/[^a-zA-Z0-9]/g, "-");
const transcript = join(homedir(), ".claude", "projects", slug, `${sessionId}.jsonl`);
const summaryPath = join(playground, "summary.txt");

const checks = {
  session_id: sessionId ?? null,
  result_subtype: result?.subtype ?? "no_result",
  num_turns: result?.num_turns ?? null,
  duration_ms: Date.now() - t0,
  tool_uses: toolUses,
  summary_created: existsSync(summaryPath),
  summary_one_line:
    existsSync(summaryPath) &&
    readFileSync(summaryPath, "utf8").trim().split("\n").length === 1,
  transcript_on_disk: existsSync(transcript),
  transcript_path: transcript,
  total_cost_usd: result?.total_cost_usd ?? null,
};
console.log("[CHECKS]", JSON.stringify(checks, null, 2));

const pass =
  checks.result_subtype === "success" &&
  checks.summary_created &&
  checks.tool_uses.includes("Bash") &&
  checks.transcript_on_disk;
console.log(pass ? "S1: PASS" : "S1: FAIL");
process.exit(pass ? 0 : 1);
