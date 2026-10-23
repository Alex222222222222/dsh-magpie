# SDD ledger — plan: docs/superpowers/plans/2026-10-23-magpie-web-search.md

## Preflight task/interface scan

| Pair / Task | Files and interfaces | Result |
|---|---|---|
| Task 1 ↔ Task 2 | Both modify `magpie-vision/src/index.ts`, `index.js`, `self-check.mjs`; Task 1 adds config/prompt, Task 2 adds a search connector which consumes those refs and registers dynamic tools. | Intent sequential; Task 1 leaves image setup separate and search prompt section composable. |
| Task 2 ↔ Task 3 | Same Host implementation/test files; Task 2 defines initial connect/discovery and tool-generation storage; Task 3 adds notifications, live setting reconciliation, retry reset/cancel, and teardown races. | Sequential. Task 3 retains names `connectSearch`, `searchTools`, `searchClient`, `connectingSearchClient`, `retryTimer`, and `SEARCH_RETRY_DELAYS`; do not duplicate initial retry mechanism. |
| Task 3 ↔ Task 4 | Task 4 updates config UI fields introduced in Task 1; no source overlap except docs. | Sequential. |
| Task 4 ↔ Task 5 | Task 5 verifies settings UI and persistence created by Task 4. | Sequential. |
| Task 1 self-check | Config defaults, volatility, image-disabled/search-enabled, prompt visibility. | Passed/reviewed. |
| Task 2 self-check | Advertised tools, schema filtering, raw-name forwarding, redaction, startup retry. | Passed/reviewed; retry fix includes connecting client/timer cleanup. |
| Task 3 self-check | `tools/list_changed`, volatile reconciliation, retry reset, stale sync and teardown races. | Task text consistent with current committed Task 2 interfaces. |
| Task 4 self-check | Separate switch and instruction mode, staged volatile form mutation, docs. | Consistent with Task 1 setting names. |
| Task 5 self-check | Temporary DSH profile/browser without active profile changes or external search call. | Preserves verification boundary. |

## Rulings

- Ruling: `syncTools` in `@deepseek-ai/dsh-mcp-client` rejects an entire list on duplicate public name and has no per-entry skip hook; Task 2 implements a local adapter loop with exported `createMcpToolDefinition` and local naming to satisfy valid-tools-only behavior — small custom bridge is needed to keep remaining advertised tools available — cost if wrong: duplicated tool-bridge logic may need replacement by upstream adapter if its behavior changes.
- Ruling: live UI enable cannot await MCP discovery because volatile updates are synchronous; settings save completes before discovery; profile-configured enabled search awaits initial discovery — no Host RPC/status mechanism — cost if wrong: no immediate connected state in UI.
- Ruling: move bounded initial connection retry (10 attempts, 500 ms exponential to 30 s) into Task 2 after reviewer found it missing there; Task 3 only resets/cancels retries on volatile changes and implements notification/reconciliation races — avoids duplicate retry implementations — cost if wrong: retry code was delivered one task earlier.

## Execution

- Baseline: 32/32 tests passed in worktree at 8ef7c3b; temporary dependency symlink removed.
- Task 1 dispatched to subagent 50fec15f-6121-4ee8-8267-a0aa1f14fd86, commit `9c0303a6eedc97db60fffa3325576ebc4928b243`; reviewer `e80823c5-f0e8-4c45-8254-e551dab4ac9f` verdict: spec compliant, quality pass, no findings. Task 1 complete (commits 8ef7c3b..9c0303a, review clean).
- Task 2 dispatched to subagent 3a01516a-a768-4344-ab82-34d8179ea748, commit `3c58eaa001480de80297344a317811b190cf7658`; reviewer `8ba5c603-105b-4ea0-bc16-81d4694a16cf` found one Important gap (no initial retry). Fix round 1 re-routed to subagent `2a407458-a9f6-43db-9c8e-ba6b988e4b7c`, then exclusive retry fix commit `1f850b0e073784f366fba8e0fd9455b40d6fc861` was verified/pushed. Scoped re-review by `70051657-67ed-4b4c-84f7-45466e4639fa` verdict: finding addressed; no new breakage. Task 2 complete (3c58eaa..1f850b0, review clean). Report: `.superpowers/sdd/2026-10-23-magpie-web-search/task-2-report.md`.
- During retry fix, overlapping edits appeared in the primary feature worktree. They were inspected and removed; authoritative `HEAD` and `origin/feat/magpie-web-search` remain 1f850b0. Separate retry worktree remains at 3c58eaa with its local TDD proof; do not merge it.
- Task 3 BASE: `1f850b0e073784f366fba8e0fd9455b40d6fc861`.
- Task 3 completed: added live `loader/volatile-update` reconciliation, serialized sync queue, `autoRefresh: false` notification-driven refresh with failure preservation, in-flight call cancellation on disable/cleanup, and retry timer resets. Verification: 7/7 focused tests, 54/54 full suite, `deno check` passed, transpile parity verified. Commit: `66223c6` on `feat/magpie-web-search`, pushed to `origin`. Report: `.superpowers/sdd/2026-10-23-magpie-web-search/task-3-report.md`.
- Task 4 BASE: `66223c6`.
