# Agentic browser choice — BrowserOS neo vs Personal Agent's isolated Playwright worker (2026-11-22)

## Decision
Keep **BrowserOS neo** (user's dedicated agent browser, installed, signed into the user's accounts) for general agent browser work, and keep **Personal Agent's isolated Playwright Chromium** for the product under development. They serve different layers and choosing between them is per-task, not either/or.

## When to use which
| Situation | Use |
|---|---|
| Assistant (Hermes) doing real web work for Michael (video/media generation, research, form-filling on his accounts) | BrowserOS neo via MCP — user must connect it in the BrowserOS app's MCP page for the current agent (or say "use neo") |
| Exercising Personal Agent itself (the product), anything needing the review/approval UI, audit trail, or credentials kept away from the agent | Personal Agent isolated worker only |
| Verifying Personal Agent UI renders | Worker screenshot / local dev server is fine |
| Filling a form that contains password fields | Neither agent; the worker hides all elements on password-bearing pages by design, and neo should hand off via human help |

## Why neo wins for general agent work
- Real, persistent, pre-authenticated profile — no re-login fights, no CDP gymnastics.
- Built for multi-step interactive work: batched actions, settled-diff verification, run-loop for multi-step work, human-help handoff built in.
- The LocalPlay/worker equivalent requires per-action approval, allow-listing, and manual CDP tricks (eval-dead clicks, one-click-per-approval) — by design, but heavy for production-style runs (Rainbow Garden took three manual recoveries).

## Why the worker stays for the product
- Personal Agent's entire value is a reviewable, local, gated agent. Swapping its engine for a third-party agentic browser would outsource exactly the part Personal Agent exists to own, and neo is not scriptable/embeddable from the product (closed source, external app, user's live session).

## Practical notes
- neo connects over MCP (streamable HTTP); each agent (Hermes, Claude Code, ...) connects separately; skill at `browseros-neo` documents the contract. If not connected, say so and point at the BrowserOS → MCP page; do not silently fall back to another browser.
- neo acts with the user's real accounts — treat it like the user clicking: it can spend credits and change state; the same spend guardrails apply.
- Worker invariants that still stand: never approve credentials/payments/ToS/publishing; Personal Agent worker never leaves this machine.
- neo tools available to this session would appear as `mcp__browseros_neo__*`; as of 2026-11-22 they are NOT connected to this agent (skill installed, browser present, MCP not attached).

## Open items
- If Michael wants neo wired into Hermes: enable MCP in BrowserOS settings and point Hermes' MCP config at the loopback endpoint shown there; then re-test with a low-risk page first.
