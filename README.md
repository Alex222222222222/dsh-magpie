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

## Configure

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

- `enabled` (default `true`): Enables image analysis. Disabling it leaves web search intact if `webSearchEnabled` is `true`.
- `instructionMode`: Controls agent guidance for image analysis: `normal` (default) adds nothing, `suggest` recommends image tools, and `force` requires using them for image inspection.
- `webSearchEnabled` (default `false`): Enables the Magpie web search MCP connector. Disabled by default.
- `webSearchInstructionMode`: Controls agent guidance for web search: `normal` (default) adds nothing, `suggest` recommends Magpie search tools, and `force` requires using them for web research. Guidance renders only when at least one search tool is visible to the agent.
- `gatewayUrl`: Shared base URL of the Magpie gateway. Derived endpoints:
  - Vision: `${gatewayUrl}/mcp/magpie/vision`
  - Web search: `${gatewayUrl}/mcp/magpie/web-search`
- `tokenEnv` (default `MAGPIE_API_KEY`): Shared Host environment variable holding the bearer token for both vision and search.
- `allowInsecureHttp` (default `false`): Permits plain HTTP connections to the shared gateway.

### Web UI configuration

You can also edit these settings directly in the DSH Web UI:
1. Open the **Plugins** sidebar.
2. Select the installed **Magpie** package.
3. Click **Configure** on the `magpie` row to edit `gatewayUrl`, `tokenEnv`, `instructionMode`, `allowInsecureHttp`, `webSearchEnabled`, and `webSearchInstructionMode`.

Edits saved in the UI persist to your profile configuration and apply immediately without restarting the host.

### Web search tools & lifecycle

When `webSearchEnabled` is turned on, the plugin connects to `${gatewayUrl}/mcp/magpie/web-search` and dynamically discovers and registers all valid advertised MCP tools under the `mcp__magpie_search__<rawName>` namespace (names over 64 characters or containing unsupported characters receive a deterministic 12-character SHA-256 suffix).

- **Dynamic tool synchronization**: Subscribes to `notifications/tools/list_changed` and automatically refreshes registered search tools. If a refresh fails, the prior tool generation is preserved.
- **Connection retries**: Initial connection failures retry up to 10 attempts with exponential backoff (500 ms, 1 s, 2 s, 4 s, 8 s, 16 s, then 30 s). Volatile configuration changes immediately cancel pending retries, reset the retry budget, and reconnect.
- **Independence & Teardown**: Turning `enabled: false` disables only image analysis; search tools remain available. Turning `webSearchEnabled: false` or stopping the plugin unregisters all search tools, aborts in-flight search calls, and closes MCP connections.

The tool accepts `analyze_image({ path?, image?, prompt? })` for PNG, JPEG, WebP, or GIF files up to 20 MiB from the workspace or `/tmp`, as well as direct data URLs. `image` is supported as an alias for `path`. See [the full plugin documentation](magpie-vision/README.md) for configuration, protocol details, and the documented filesystem replacement race.
