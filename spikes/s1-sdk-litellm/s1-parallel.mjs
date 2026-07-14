// T0.1 子断言：两个并行会话用不同 model，各自 transcript 记录对应模型（DECISIONS D2 手段②）
import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOST = process.env.LETSCODING_GATEWAY_HOST;
const KEY = process.env.LETSCODING_GATEWAY_KEY;
const playground = process.env.SPIKE_PLAYGROUND;
const MODELS = [
  "openrouter/anthropic/claude-sonnet-4.6",
  "openrouter/anthropic/claude-haiku-4.5",
];

const childEnv = { ...process.env };
delete childEnv.ANTHROPIC_API_KEY;

async function run(model) {
  let sessionId;
  for await (const msg of query({
    prompt: "Reply with exactly: ok",
    options: {
      cwd: playground,
      model,
      env: { ...childEnv, ANTHROPIC_BASE_URL: HOST, ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_SMALL_FAST_MODEL: model, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      allowedTools: [],
      maxTurns: 1,
    },
  })) {
    if (msg.type === "system" && msg.subtype === "init") sessionId = msg.session_id;
  }
  return { model, sessionId };
}

const results = await Promise.all(MODELS.map(run));
const slug = playground.replace(/[^a-zA-Z0-9]/g, "-");
let pass = true;
for (const { model, sessionId } of results) {
  const lines = readFileSync(join(homedir(), ".claude", "projects", slug, `${sessionId}.jsonl`), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l));
  const recorded = lines.find((l) => l.type === "assistant")?.message?.model;
  const ok = recorded === model;
  pass &&= ok;
  console.log(`${ok ? "✓" : "✗"} session ${sessionId} expected=${model} recorded=${recorded}`);
}
console.log(pass ? "S1-PARALLEL: PASS" : "S1-PARALLEL: FAIL");
process.exit(pass ? 0 : 1);
