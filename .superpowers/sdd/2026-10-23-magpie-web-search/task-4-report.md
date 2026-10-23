# Task 4 Report: Web Settings Controls and Documentation

## Result

Added independent Web search configuration controls to the DSH Web UI configuration panel and updated project documentation.

1. **Bilingual Settings UI**:
   - Added English and Chinese localized labels and hint strings for `webSearchHeading`, `webSearchEnabled`, and `webSearchInstructionMode`.
   - Rendered a distinct "Web search" section separated from the gateway section with an enable `Switch` for `webSearchEnabled` and a 3-way `SegmentedControl` (`normal`, `suggest`, `force`) for `webSearchInstructionMode`.
   - Extended `FIELD_ORDER`, `draftText`, and `parse` to stage, validate, save, and discard both fields in one revision-fenced mutation alongside existing shared fields.

2. **Documentation**:
   - Updated `README.md` and `magpie-vision/README.md` with the derived search endpoint (`<gatewayUrl>/mcp/magpie/web-search`), default-off toggle, separate search instruction mode, dynamic tool naming under `mcp__magpie_search__<rawName>`, automatic list refresh on notifications, bounded retries (10 attempts up to 30 s), live volatile updates, and independence from image enablement.

## Files Changed

- `magpie-vision/client.js`: localized strings, `FIELD_ORDER`, draft formatting/parsing for `webSearchEnabled` and `webSearchInstructionMode`, and UI rendering.
- `magpie-vision/test/client-check.mjs`: added UI tests for 6-field staging, 2 switches, 2 segmented controls, mutation ops, and discard restoration.
- `README.md`: documented web search configuration, derived endpoint, lifecycle, tool names, and UI options.
- `magpie-vision/README.md`: detailed reference documentation for search tools, lifecycle, settings table, and prompt guidance.

## Verification

- RED: `node --test magpie-vision/test/client-check.mjs` failed before `client.js` updates with 1 SegmentedControl instead of 2, and missing second Switch.
- GREEN: `node --test magpie-vision/test/client-check.mjs` passed 8/8 tests.
- Full suite: `npm test` passed 54/54 tests (0 failures).
- Type-check: `deno check --no-lock --node-modules-dir=manual magpie-vision/src/index.ts` passed.
- `git diff --check` passed clean.
- Commit `190c4ae` pushed to `origin/feat/magpie-web-search`.
