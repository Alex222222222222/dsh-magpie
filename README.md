# Magpie for DSH

A DSH plugin that provides the `analyze_image` tool for workspace image analysis, dynamic MCP web search tools under `mcp__magpie_search__*`, and a Web UI settings panel to configure remote MCP endpoints.

## Install

```sh
dsh plugin --profile web add github:Alex222222222222/dsh-magpie
```

The repository includes both the Host and Web client JavaScript runtimes; installation requires no build script. DSH adds the bundle to the `web` profile. Restart the DSH web host after installation to load the bundle.

## Update

To update an existing installation to the latest commit from this GitHub repository:

```sh
dsh plugin --profile web update @alex222222222222/magpie
```

`@alex222222222222/magpie` is the installed package name. Restart the DSH web host after the update to load the new code. Your settings in the profile's `cordis.patch.yml` and Host token environment variable remain unchanged.

## Configuration

Set `MAGPIE_API_KEY` in the environment of the DSH Host process. In the `web` profile's `cordis.patch.yml`, configure the Magpie gateway URL and feature options:

```yaml
- id: magpie
  config:
    enabled: true
    instructionMode: normal
    webSearchEnabled: false
    webSearchInstructionMode: normal
    gatewayUrl: https://magpie-gateway.alex1222.com/
    tokenEnv: MAGPIE_API_KEY
    allowInsecureHttp: false
```

### Settings reference

| Setting | Default | Live UI | Meaning |
| --- | --- | --- | --- |
| `enabled` | `true` | Row switch | Set to `false` to disable image analysis. Web search continues independently according to `webSearchEnabled`. |
| `instructionMode` | `normal` | Yes (volatile) | `normal` adds no prompt text; `suggest` and `force` add guidance to use image analysis tools. |
| `webSearchEnabled` | `false` | Yes (volatile) | Set to `true` to enable web search tool discovery and registration. Defaults off. |
| `webSearchInstructionMode` | `normal` | Yes (volatile) | `normal` adds no prompt text; `suggest` recommends search tools; `force` requires them for web research. |
| `gatewayUrl` | unset | Yes (volatile) | Shared base URL of the Magpie gateway, for example `https://magpie-gateway.alex1222.com/`. Appends `mcp/magpie/vision` for images and `mcp/magpie/web-search` for search. |
| `tokenEnv` | `MAGPIE_API_KEY` | Yes (volatile) | Shared environment-variable name containing the bearer token. |
| `allowInsecureHttp` | `false` | Yes (volatile) | Set to `true` to permit an HTTP gateway. |

`instructionMode`, `webSearchEnabled`, `webSearchInstructionMode`, `gatewayUrl`, `tokenEnv`, and `allowInsecureHttp` are volatile configuration fields. Edits made through the DSH settings service update live references and apply to subsequent tool calls, prompt generation, and connector lifecycle immediately without restarting the host.

HTTPS is required by default. Setting `allowInsecureHttp: true` permits HTTP and always emits a warning, including when the configured gateway is HTTPS, because the bearer key would be exposed if the gateway were changed to HTTP. The URL must not include user information. The token is sent only in the `Authorization: Bearer …` header.

The gateway URL is intentionally not preconfigured. The MCP endpoints are derived:
- Vision: `<gatewayUrl>/mcp/magpie/vision`
- Web search: `<gatewayUrl>/mcp/magpie/web-search`

Trailing slashes are removed and any gateway path prefix (e.g. `https://example.com/gateway`) is preserved. The plugin starts with blank settings so its Web UI configuration page remains available. Tool calls report a missing gateway separately from a missing or empty token environment variable.

### Web UI configuration

Settings can be managed directly in the DSH Web UI without editing YAML files manually:
1. Open **Plugins** in the left sidebar.
2. Click **Magpie** (`@alex222222222222/magpie`).
3. Click **Configure** on the `magpie` row.

The panel provides staged editing with validation:
- **Gateway URL**: Text input with absolute HTTP/HTTPS URL validation.
- **Token environment variable**: Text input validating standard environment variable names.
- **Agent instructions**: Segmented control (`normal`, `suggest`, `force`) for image analysis.
- **Allow plain HTTP**: Toggle switch for insecure HTTP access.
- **Enable web search**: Toggle switch to enable or disable web search tools.
- **Web search instructions**: Segmented control (`normal`, `suggest`, `force`) for web search tools.
- **Save & Discard**: Revision-fenced save writing directly into the active profile's Cordis patch, and a discard button to revert drafts to stored snapshot values.
- **Bilingual**: Supports English and Chinese locales (`settings.magpie` namespace).

## Agent instructions

Both `instructionMode` (image analysis) and `webSearchInstructionMode` (web search) select whether the bundle adds guidance to the agent's system prompt:

| Value | Effect |
| --- | --- |
| `normal` | Default. Contributes no prompt text. |
| `suggest` | Suggests using the plugin's relevant tools. |
| `force` | Requires using the plugin's relevant tools for the matching task. |

Guidance sections contribute text only when at least one corresponding tool is visible in the agent's active scope (`analyze_image` for image instructions, and `mcp__magpie_search__*` for search instructions), preventing dangling instructions when tools are restricted.

## Web search tools

When `webSearchEnabled: true`, the connector connects to `${gatewayUrl}/mcp/magpie/web-search` using the MCP TypeScript SDK's Streamable HTTP transport and discovers advertised tools.

- **Naming**: Advertised tools are registered in DSH under `mcp__magpie_search__<rawName>`. Names that exceed 64 characters or contain unsupported characters receive a deterministic 12-character SHA-256 suffix (`mcp__magpie_search__<prefix>_<hash>`). Raw tool names are preserved when forwarding MCP tool calls.
- **Validation**: Advertised tools are checked with JSON Schema validation; invalid schemas, task-required tools, duplicates, or name collisions are skipped individually without aborting remaining valid tools.
- **List-change notifications**: Subscribes to `notifications/tools/list_changed` (`autoRefresh: false`) and automatically refreshes registered tools on a serialized queue. If a refresh fails, the last known-good generation is kept.
- **Retry backoff**: Initial connection and discovery failures retry up to 10 attempts (delays: 500 ms, 1 s, 2 s, 4 s, 8 s, 16 s, then 30 s for remaining attempts). Changing configuration settings immediately cancels pending retry timers, resets the retry budget, and reconnects.
- **Security & Redaction**: The bearer token is never exposed in tool arguments, results, structured content, or error diagnostics.
- **Lifecycle & Teardown**: Disabling search (`webSearchEnabled: false`) or plugin effect disposal unregisters all search tools, aborts in-flight search call controllers, and cleanly closes MCP clients. Disabling image analysis (`enabled: false`) leaves search active if `webSearchEnabled` is enabled.

## Tool: analyze_image

`analyze_image({ path?, image?, prompt? })` accepts an image path relative to the active agent's session working directory, an absolute path under `/tmp`, or a pre-encoded data URL (`data:image/...`). `image` is an alias for `path`. The plugin rejects paths that resolve outside the workspace or `/tmp`, paths whose final component is a symbolic link, missing paths, directories, unsupported image content, and files over 20 MiB before making a network request. Supported content is PNG, JPEG, WebP, and GIF. For local files, the image is read locally and sent as a MIME-correct `data:<mime>;base64,...` argument to the MCP tool named `analyze_image`. Pre-encoded `data:` URLs or HTTP(S) URLs pass through directly.

The DSH filesystem API checks containment before reading by path and does not provide a stable-handle no-follow byte read. If another process replaces the image or an ancestor path between validation and the read, the plugin could read and upload bytes from outside the workspace. Avoid modifying image paths concurrently with an analysis.

The plugin uses the MCP TypeScript SDK's Streamable HTTP client. The SDK performs initialization and protocol-version negotiation; the plugin then calls `tools/list` and checks that `analyze_image` is available before sending image bytes in `tools/call`. Each tool call forwards its abort signal and closes its MCP client and transport when the call settles. MCP errors and `isError: true` become tool failures. Successful calls preserve `content` and optional `structuredContent` in the tool result.

### MCP request and result shapes

These illustrative JSON-RPC messages show the exchange. Request IDs and the `initialize` protocol version are examples; the SDK negotiates the version with the server.

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"dsh-magpie","version":"1.0.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"analyze_image","arguments":{"image":"data:image/png;base64,<BASE64>","prompt":"<optional prompt>"}}}
```

A successful `tools/call` response carries `result.content`, an array of MCP content blocks. It may also include `result.structuredContent` and `result.isError`; when `isError` is true, the plugin surfaces the returned content as a failure.

```json
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"The image shows a red bicycle."}],"structuredContent":{"objects":["bicycle"]}}}
```
