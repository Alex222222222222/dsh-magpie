# Task 2 Report: MCP search connection and tool synchronization

## Result

Implemented the initial Magpie web-search MCP connection and discovery flow. When `webSearchEnabled` is true at activation, setup awaits connection and `tools/list`; failures are logged with bearer-token redaction and do not prevent image registration or Host activation. A failed initial connection or tool discovery is retried up to ten total attempts, with delays of 500 ms, 1 s, 2 s, 4 s, 8 s, 16 s, then 30 s for the remaining attempts. Retries run sequentially, stop after the tenth attempt, and pending retries and in-flight clients are closed during plugin effect teardown. When search is disabled, no connection is attempted. Search uses the shared gateway URL, token environment variable, and HTTP policy independently of the image `enabled` setting.

Advertised tools are checked with `assertObjectJsonSchema`; task-required, malformed, duplicate, and registration-conflicting tools are skipped individually. Public names use the `mcp__magpie_search__` namespace with deterministic SHA-256 suffixes for invalid or overlong names. The adapter forwards raw tool names and unchanged arguments and returns canonical MCP results. Search results and errors redact the bearer token. The persistent search client and tool registrations are disposed with the plugin effect; pending retries and any connecting client are also cleaned up during teardown.

## Files changed

- `package.json`: added `@deepseek-ai/dsh-mcp-client` peer dependency at `0.2.0-rc.2`.
- `magpie-vision/src/index.ts`: endpoint derivation, shared gateway validation, initial discovery, schema and naming validation, bridge calls, sanitized diagnostics, and effect cleanup.
- `magpie-vision/index.js`: regenerated from TypeScript using `deno transpile`.
- `magpie-vision/test/self-check.mjs`: discovery, independence from image enablement, name normalization, argument/result forwarding, validation, registration conflict, default-off, startup failure, retry recovery/no-overlap, retry exhaustion, and retry teardown coverage.

## TDD and verification

- RED: `node --test --test-name-pattern='web search discovers|web search forwards|web search disabled' magpie-vision/test/self-check.mjs` failed as expected before implementation: discovery registered no search tools and forwarding had no tool definition.
- RED: after temporarily removing the call-error sanitizer, `node --test --test-name-pattern='web search call errors redact' magpie-vision/test/self-check.mjs` failed with the bearer value present in the observed error. Restoring redaction made it pass.
- RED: Copied `HEAD:magpie-vision/index.js` to a temporary baseline bundle and ran the focused retry test against it. `node --test --test-force-exit --test-timeout=15000 --test-reporter=spec --test-name-pattern='web search initial list failures retry' magpie-vision/test/retry-baseline.mjs` failed as expected (exit 1): `AssertionError [ERR_ASSERTION]: expected a scheduled retry` from `runNext`.
- GREEN: `node --test --test-force-exit --test-timeout=15000 --test-reporter=spec --test-name-pattern='web search initial list failures retry|web search initial failures retry ten times' magpie-vision/test/self-check.mjs` passed 2 tests, 0 failures (exit 0): `✔ web search initial list failures retry and recover without overlapping requests`, `✔ web search initial failures retry ten times then stop at capped backoff`, `ℹ pass 2`, `ℹ fail 0`.
- Full suite: `npm test` passed 46 tests, 0 failures (exit 0); output summary: `ℹ tests 46`, `ℹ pass 46`, `ℹ fail 0`, `ℹ duration_ms 2322.104333`.
- Type-check: `deno check --no-lock --node-modules-dir=manual magpie-vision/src/index.ts` passed (exit 0); output: `Check magpie-vision/src/index.ts`.
- Generated bundle: `deno transpile --no-check --no-lock --node-modules-dir=manual --source-map=none magpie-vision/src/index.ts --output magpie-vision/index.js` emitted the bundle; a fresh emit compared byte-for-byte equal to `magpie-vision/index.js` (exit 0).
- `git diff --check` passed (exit 0).
- Removed the temporary baseline test/bundle and `node_modules` symlink after verification.

## Scope and concerns

Task 3 behavior remains out of scope: there is no volatile enable/disable or shared-setting reconciliation, notification subscription, or serialized sync queue yet. Initial connection/discovery retry is implemented here; live changes will be handled by Task 3.

No implementation or test changes are included outside the retry, retry-cleanup, and retry-verification scope. This follow-up updates the previously ignored Task 2 report, which is force-staged explicitly.

## Original Task 2 commit

- Commit: `3c58eaa` (`feat: connect Magpie web search MCP tools`)
- Push: `feat/magpie-web-search` was pushed to `origin`.
- The push response reported two Dependabot vulnerabilities on the repository default branch (one high, one moderate); they are unrelated to the Task 2 branch changes.
