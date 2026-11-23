# Architecture decision: browser link for Personal Agent (locked 2026-11-22)

Decision: keep the isolated Playwright Chromium (persistent profile in .localpilot/browser-profile) as the only browser engine for executing workflows. Do not attach to the user's everyday browser, do not rebuild on Electron, and do not use Docker (not installed on the machine).

## Why
- Google/OAuth sign-in works reliably in this Chromium; app.videoexpress.ai has been used through it. Electron and embedded webviews risk "this browser may not be secure" blocks and a rewrite of the executor.
- Strongest isolation available without new infrastructure: separate cookies/history/extensions from the daily browser; a compromised run cannot touch the real session.
- Per-action approval, host allowlisting, and post-navigation re-checks already work on top of it and are test-backed.
- Telegram send-only notifications make its one weakness (needs a human at the keyboard for approvals) livable from anywhere.
- No packaging/signing/maintenance of a second platform. Friday Code continues to own one stack.

## Explicitly rejected
- Attach to everyday browser via CDP: sees real sessions/credentials; blast radius too large; only with a separate future decision.
- Electron shell: single-window UX and native notifications, but sign-in fragility plus a main/preload/renderer rewrite and unsigned-build friction; not worth it now. Revisit only if isolated Chromium proves brittle in daily use.
- Docker: not installed on this machine; also does not improve the trust model.

## Accepted costs (by design)
- Two windows on screen; you switch focus manually.
- Sign-in/CAPTCHA/anti-bot steps require you, by design.
- Tab IDs (tab-N) are per worker process; after a worker restart, re-select the tab in the UI.

## Improvements queued for Friday Code (in priority order)
1. Persist window position/size in the profile; call bringToFront on any approval request so the prompt is never invisible.
2. "Rebind tab" button in Workflows: list live tabs (worker `tabs` action), rebind activeTabId on click; replaces stale-tab errors after worker restarts.
3. Named profiles (e.g. per client site) via a profile-path parameter; default stays .localpilot/browser-profile.
4. README section documenting the sign-in-once persistent-profile model and the two-window reality.

## Out of scope
Multi-browser support, remote Chromium, headless scheduled runs (possible later via PW headless:true, not now).
