# Magpie Vision

A DSH Host bundle that registers `analyze_image`, reads one image from the active agent's workspace, and sends it to a configurable remote MCP vision server.

## Configuration

The bundle's `magpie-vision` row accepts:

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Set to `false` to skip configuration validation and register no tool. |
| `endpointUrl` | unset | Absolute URL of the remote MCP endpoint. Required when enabled. |
| `tokenEnv` | `MAGPIE_VISION_TOKEN` | Environment-variable name containing the bearer token. |
| `allowInsecureHttp` | `false` | Set to `true` to permit an HTTP endpoint. |

HTTPS is required by default. Setting `allowInsecureHttp: true` permits HTTP and always emits a warning, including when the configured endpoint is HTTPS, because the bearer key would be exposed if the endpoint were changed to HTTP. The URL must not include user information. The token is sent only in the `Authorization: Bearer …` header.

The endpoint URL is intentionally not preconfigured. When enabled, activation reports a missing endpoint separately from a missing or empty token environment variable.

## Tool

`analyze_image({ path, prompt? })` accepts a path relative to the active agent's session working directory and an optional question. The plugin rejects paths that resolve outside that working directory, paths whose final component is a symbolic link, missing paths, directories, unsupported image content, and files over 20 MiB before making a network request. Supported content is PNG, JPEG, WebP, and GIF. The image is sent as a MIME-correct `data:<mime>;base64,...` argument to the MCP tool named `analyze_image`.

The DSH filesystem API checks containment before reading by path and does not provide a stable-handle no-follow byte read. If another process replaces the image or an ancestor path between validation and the read, the plugin could read and upload bytes from outside the workspace. Avoid modifying image paths concurrently with an analysis.

The plugin uses the MCP TypeScript SDK's Streamable HTTP client. The SDK performs initialization and protocol-version negotiation; the plugin then calls `tools/list` and checks that `analyze_image` is available before sending image bytes in `tools/call`. Each tool call forwards its abort signal and closes its MCP client and transport when the call settles. MCP errors and `isError: true` become tool failures. Successful calls preserve `content` and optional `structuredContent` in the tool result.

## MCP request and result shapes

These illustrative JSON-RPC messages show the exchange. Request IDs and the `initialize` protocol version are examples; the SDK negotiates the version with the server.

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"dsh-magpie-vision","version":"1.0.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"analyze_image","arguments":{"image":"data:image/png;base64,<BASE64>","prompt":"<optional prompt>"}}}
```

A successful `tools/call` response carries `result.content`, an array of MCP content blocks. It may also include `result.structuredContent` and `result.isError`; when `isError` is true, the plugin surfaces the returned content as a failure.

```json
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"The image shows a red bicycle."}],"structuredContent":{"objects":["bicycle"]}}}
```

## Installation

Install the `magpie-vision` directory as a local bundle using DSH Plugin Manager's bundle installation workflow. Configure the endpoint and token environment variable in the Host environment before enabling the tool. This implementation work does not install or enable the bundle in a profile.
