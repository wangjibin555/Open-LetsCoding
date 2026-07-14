# M0 Spikes — 结果与证据（2026-07-07）

对应 `PLAN.md` M0 / `SPEC.md` §6 / `DECISIONS.md` D2·D4 验收。
运行前置：LiteLLM 网关凭证经环境变量注入（`LETSCODING_GATEWAY_HOST` / `LETSCODING_GATEWAY_KEY`），**key 不入库**。

## T0.1 · SDK × LiteLLM 全链 — PASS

`s1.mjs`：Agent SDK `query()` 经网关（`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` 成对注入，剔除 `ANTHROPIC_API_KEY`）在隔离 playground 完成「读→改→跑」。

| 断言 | 结果 |
|---|---|
| Read / Write / Bash 全部执行 | ✓ `tool_uses: ["Read","Write","Bash"]` |
| 产物正确（summary.txt 恰一行） | ✓ |
| transcript 落 `~/.claude/projects/<cwd-slug>/<session>.jsonl` | ✓ session `f63241fc-…` |
| 结果 | success · 4 turns · 29.3s · $0.077（CLI 侧估算，金额口径以网关 /spend 为准，见 D8） |

`s1-parallel.mjs`（D2 手段②）：并行双会话分别指定 sonnet-4.6 / haiku-4.5，各自 transcript 记录的 `message.model` 与期望一致。PASS。

## T0.2 · CLI 互续裁决 — PASS（D4 出口 A）

同 cwd 下 `claude -p --resume f63241fc-… --model openrouter/anthropic/claude-sonnet-4.6`（CLI 2.1.126），禁用工具提问「你写进 summary.txt 的那一行是什么」，CLI 从会话历史逐字复述正确 ⇒ SDK 会话可被 CLI 续跑。**D4 判定为出口 A：互续冒烟进 verify 硬 gate。**

## 记录在案的观察

- 测试网关模型清单全部为 `openrouter/*` 转发，**无 claude-fable-5**；spike 以 `openrouter/anthropic/claude-sonnet-4.6` 代表 Claude 系。生产网关是否含 Fable 5 待用户确认（不影响 D1 决策，主力锚为 Claude 系整体）。
- Anthropic 格式端点在网关根域名 `/v1/messages`（即 `ANTHROPIC_BASE_URL=https://<host>`，不带 `/v1`）。
- 相对路径任务描述会让模型迷路（首跑 FAIL 案例）；App 的会话默认 cwd 语义在 M2 实现时要显式注入提示。
- 「出站流量仅到网关」的抓包级断言不在 spike 范围，按 D2 手段①落在 M2 的 verify gate。

## 复跑方式

```bash
export LETSCODING_GATEWAY_HOST=… LETSCODING_GATEWAY_KEY=… SPIKE_PLAYGROUND=/tmp/spike-playground
cd spikes/s1-sdk-litellm && npm i && node s1.mjs && node s1-parallel.mjs
```
