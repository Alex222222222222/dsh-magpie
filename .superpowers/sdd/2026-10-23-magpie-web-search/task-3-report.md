# Task 3 Report: Web Search Live Reconciliation, Notifications, and Teardown

## Result

Implemented live lifecycle reconciliation, notification-driven tool refresh, retry management, and in-flight cancellation for the Magpie web-search MCP integration.

1. **Serialized Sync Queue & AutoRefresh:false**:
   Configured `@modelcontextprotocol/client` with `listChanged.tools: { autoRefresh: false }`. On `notifications/tools/list_changed`, queued serialized discovery via `syncQueue`. Stale notifications and callbacks from obsolete clients or generations are dropped safely.

2. **Atomic Tool-Generation Refresh & Failure Resilience**:
   When advertised tools change, new tool definitions are validated and built first. If `tools/list` fails during refresh, the failure is caught and logged, preserving the existing registered tools and current generation intact without disposing them.

3. **Live Setting Reconciliation on `loader/volatile-update`**:
   Listens for volatile updates affecting `webSearchEnabled`, `gatewayUrl`, `tokenEnv`, or `allowInsecureHttp`. If any changes, the connector immediately cancels pending retry timers, resets the retry budget, aborts in-flight search call controllers, cleans up prior clients, and attempts connection immediately if search remains enabled. Staged changes with identical signatures are deduplicated.

4. **In-Flight Call Cancellation and Teardown**:
   Active `callTool` invocations are tracked via `activeSearchCalls` set. On live disable or plugin effect disposal, all in-flight tool run controllers are aborted with explicit reasons, search tool registrations are disposed from Host tools, retry timers cleared, and MCP client/transport connections cleanly closed.

## Files Changed

- `magpie-vision/src/index.ts`: added `loader/volatile-update` listener, serialized `syncQueue`, `stopGeneration` aborting active calls and timers, generation-guarded `buildToolDefinitions`, `autoRefresh: false` notification callback, and `ctx.effect` disposal.
- `magpie-vision/index.js`: freshly transpiled from `src/index.ts` with byte-for-byte verified idempotency.
- `magpie-vision/test/self-check.mjs`: added coverage for live toggle on/off, shared gateway reconnection, stale connection closure on disable, list-change notification tool refresh, list refresh failure preservation, in-flight call cancellation on disable and cleanup, and `tokenEnv`/`allowInsecureHttp` live reconnection.

## TDD and Verification Evidence

- RED:
  - `web search live toggle connects and unregisters tools without restart`: failed with `expected 1 tools/list requests, got 0` before `loader/volatile-update` listener was implemented.
  - `web search reconnects when the shared gateway changes while enabled`: failed with `expected 1 tools/list requests, got 0` before reconciliation was implemented.
  - `web search refreshes advertised tools after tools/list_changed notification`: failed with `expected 2 tools/list requests, got 1` before notification callback was connected.
  - `web search retains the previous tool generation when a list refresh fails`: failed with `expected 2 tools/list requests, got 1` before refresh error handling was implemented.
- GREEN:
  - Focused lifecycle suite: `node --test --test-name-pattern='web search live toggle connects|web search reconnects when the shared gateway changes|web search refreshes advertised tools|web search retains the previous tool generation|web search disable aborts|web search plugin cleanup aborts an in-flight search call|web search reconnects when tokenEnv' magpie-vision/test/self-check.mjs` passed 7/7 (exit 0).
  - Full test suite: `npm test` passed 54/54 tests (0 failures, duration 2685 ms).
  - Type-check: `deno check --no-lock --node-modules-dir=manual magpie-vision/src/index.ts` passed (exit 0).
  - Parity check: `deno transpile` on `src/index.ts` against `index.js` verified byte-for-byte identical.
  - Whitespace check: `git diff --check` passed clean.
- All commits pushed to `origin/feat/magpie-web-search`.
