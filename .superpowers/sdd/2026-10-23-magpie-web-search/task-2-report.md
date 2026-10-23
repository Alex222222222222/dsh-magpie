# Task 2 Report: MCP search connection and tool synchronization

## Result

Implemented the initial Magpie web-search MCP connection and discovery flow. When `webSearchEnabled` is true at activation, setup awaits connection and `tools/list`; failures are logged with bearer-token redaction and do not prevent image registration or Host activation. A failed initial connection or tool discovery is retried up to ten total attempts, with delays of 500 ms, 1 s, 2 s, 4 s, 8 s, 16 s, then 30 s for the remaining attempts. Retries run sequentially, stop after the tenth attempt, and pending retry timers and in-flight clients are closed during plugin effect teardown. When search is disabled, no connection is attempted. Search uses the shared gateway URL, token environment variable, and HTTP policy independently of the image `enabled` setting.

Advertised tools are checked with `assertObjectJsonSchema`; task-required, malformed, duplicate, and registration-conflicting tools are skipped individually. Public names use the `mcp__magpie_search__` namespace with deterministic SHA-256 suffixes for invalid or overlong names. The adapter forwards raw tool names and unchanged arguments and returns canonical MCP results. Search results and errors redact the bearer token. The persistent search client and tool registrations are disposed with the plugin effect; pending retries and any connecting client are also cleaned up during teardown.

## Files changed

- `package.json`: added `@deepseek-ai/dsh-mcp-client` peer dependency at `0.2.0-rc.2`.
- `magpie-vision/src/index.ts`: endpoint derivation, shared gateway validation, initial discovery, schema and naming validation, bridge calls, sanitized diagnostics, bounded startup retries, and effect cleanup.
- `magpie-vision/index.js`: regenerated from TypeScript using `deno transpile`.
- `magpie-vision/test/self-check.mjs`: discovery, independence from image enablement, name normalization, argument/result forwarding, validation, registration conflict, default-off, startup failure, retry recovery/no-overlap, retry exhaustion, retry timer cleanup, and in-flight client teardown coverage.

## TDD and verification

- RED: initial search tests failed before Task 2 implementation because discovery registered no search tools and forwarding had no tool definition.
- RED: after temporarily removing the call-error sanitizer, the bearer-redaction test failed with the secret present in its observed error; restoring redaction made it pass.
- RED: against the pre-retry runtime, the retry recovery test observed one `tools/list` request instead of the required second request.
- GREEN: focused retry/reconciliation tests passed 4/4, covering recovery after a transient `tools/list` failure, non-overlap, ten attempts with the capped delay schedule, pending timer cancellation, and in-flight client teardown.
- Full suite: `npm test` passed 46 tests, 0 failures.
- Type-check: `deno check --no-lock --node-modules-dir=manual magpie-vision/src/index.ts` passed.
- Generated bundle: a fresh `deno transpile --no-check --no-lock --node-modules-dir=manual --source-map=none magpie-vision/src/index.ts --output magpie-vision/index.js` matched the committed runtime byte-for-byte.
- `git diff --check` passed.
- Temporary dependency symlinks and retry snapshots were removed after verification.

## Scope and concerns

Task 3 behavior remains separate: there is no volatile enable/disable or shared-setting reconciliation, notification subscription, or serialized sync queue yet. The initial retry and cleanup behavior described above is implemented and verified.

## Commits

- `3c58eaa` — initial MCP search connection and tool synchronization.
- `1f850b0` — bounded startup retry and connecting-client cleanup.
- `d21c89a` — retry test-helper correction.
- `2d77431` — retry verification report update.

