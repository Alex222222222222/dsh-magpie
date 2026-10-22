# Magpie

A DSH bundle that registers `analyze_image`, reads one image from the active agent's workspace, sends it to a configurable remote MCP vision server, and provides a Web configuration panel in the DSH Web UI.

## Configuration

The bundle's `magpie` row uses the package `@alex222222222222/magpie` and accepts:

| Setting | Default | Live UI | Meaning |
| --- | --- | --- | --- |
| `enabled` | `true` | Row switch | Set to `false` to skip configuration validation and register no tool or system prompt. |
| `instructionMode` | `normal` | Yes (volatile) | `normal` adds no prompt text; `suggest` and `force` add guidance to use this bundle's tools (see [Agent instructions](#agent-instructions)). |
| `gatewayUrl` | unset | Yes (volatile) | Base URL of the Magpie gateway, for example `https://magpie-gateway.alex1222.com/`. Required when enabled; the plugin appends `mcp/magpie/vision`. |
| `tokenEnv` | `MAGPIE_API_KEY` | Yes (volatile) | Environment-variable name containing the bearer token. |
| `allowInsecureHttp` | `false` | Yes (volatile) | Set to `true` to permit an HTTP gateway. |

`instructionMode`, `gatewayUrl`, `tokenEnv`, and `allowInsecureHttp` are volatile configuration fields. Edits made through the DSH settings service update live references and apply to subsequent tool calls and prompt generation immediately without restarting the host.

HTTPS is required by default. Setting `allowInsecureHttp: true` permits HTTP and always emits a warning, including when the configured gateway is HTTPS, because the bearer key would be exposed if the gateway were changed to HTTP. The URL must not include user information. The token is sent only in the `Authorization: Bearer …` header.

The gateway URL is intentionally not preconfigured. The MCP endpoint is `<gatewayUrl>/mcp/magpie/vision`: trailing slashes are removed and a gateway path prefix, such as `https://example.com/gateway`, is preserved. When enabled, activation reports a missing gateway separately from a missing or empty token environment variable.

### Web UI configuration

Settings can be managed directly in the DSH Web UI without editing YAML files manually:
1. Open **Plugins** in the left sidebar.
2. Click **Magpie** (`@alex222222222222/magpie`).
3. Click **Configure** on the `magpie` row.

The panel provides staged editing with validation:
- **Gateway URL**: Text input with absolute HTTP/HTTPS URL validation.
- **Token environment variable**: Text input validating standard environment variable names.
- **Agent instructions**: Segmented control (`normal`, `suggest`, `force`).
- **Allow plain HTTP**: Toggle switch for insecure HTTP access.
- **Save & Discard**: Revision-fenced save writing directly into the active profile's Cordis patch, and a discard button to revert drafts to stored snapshot values.
- **Bilingual**: Supports English and Chinese locales (`settings.magpie` namespace).

## Agent instructions

`instructionMode` selects whether the bundle adds guidance to the agent's system prompt:

| Value | Effect |
| --- | --- |
| `normal` | Default. Contributes no prompt text. |
| `suggest` | Suggests using `analyze_image` when image inspection or recognition would help. |
| `force` | Requires using `analyze_image` whenever the task needs image inspection or recognition. |

The section is registered while the plugin is enabled and contributes text only for agents whose tool view includes `analyze_image`, so agents with restricted tools see no dangling instructions. Because `instructionMode` is a volatile reference evaluated dynamically during prompt assembly, changing modes in the Web UI immediately updates system prompt generation on subsequent agent turns without restarting the host. These are model instructions, not enforcement: the plugin still validates every tool call itself.

## Tool

`analyze_image({ path, prompt? })` accepts a path relative to the active agent's session working directory and an optional question. The plugin rejects paths that resolve outside that working directory, paths whose final component is a symbolic link, missing paths, directories, unsupported image content, and files over 20 MiB before making a network request. Supported content is PNG, JPEG, WebP, and GIF. The image is sent as a MIME-correct `data:<mime>;base64,...` argument to the MCP tool named `analyze_image`.

The DSH filesystem API checks containment before reading by path and does not provide a stable-handle no-follow byte read. If another process replaces the image or an ancestor path between validation and the read, the plugin could read and upload bytes from outside the workspace. Avoid modifying image paths concurrently with an analysis.

The plugin uses the MCP TypeScript SDK's Streamable HTTP client. The SDK performs initialization and protocol-version negotiation; the plugin then calls `tools/list` and checks that `analyze_image` is available before sending image bytes in `tools/call`. Each tool call forwards its abort signal and closes its MCP client and transport when the call settles. MCP errors and `isError: true` become tool failures. Successful calls preserve `content` and optional `structuredContent` in the tool result.

## MCP request and result shapes

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

## Installation

Install from GitHub:

```sh
dsh plugin --profile web add github:Alex222222222222/dsh-magpie
```

The repository root is the bundle package and includes both the Host JavaScript runtime (`magpie-vision/index.js`) and the Web client runtime (`magpie-vision/client.js`), so no installation build script is required. See the [repository installation guide](../README.md) for the Host token and profile endpoint configuration required before activation. For local development, install the repository root as the local bundle.
