# Magpie for DSH

A DSH plugin that provides the `analyze_image` tool for workspace image analysis and a Web UI settings panel to configure the remote MCP vision endpoint.

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

### Migrating from the old package name

If you installed `@local/magpie-vision`, remove that package and install the renamed bundle:

```sh
dsh plugin --profile web remove @local/magpie-vision
dsh plugin --profile web add github:Alex222222222222/dsh-magpie
```

In your profile's configuration overrides, change `id: magpie-vision` to `id: magpie`. If an override includes `name: '@local/magpie-vision'`, change it to `name: '@alex222222222222/magpie'`. Keep your endpoint and token settings, then restart the DSH web host.

## Configure

Set `MAGPIE_API_KEY` in the environment of the DSH Host process. In the `web` profile's `cordis.patch.yml`, configure the Magpie gateway URL:

```yaml
- id: magpie
  config:
    enabled: true
    instructionMode: normal
    gatewayUrl: https://magpie-gateway.alex1222.com/
    tokenEnv: MAGPIE_API_KEY
    allowInsecureHttp: false
```

`instructionMode` controls the agent guidance the bundle adds to the system prompt: `normal` (default) adds nothing, `suggest` recommends the plugin's tools, and `force` requires using them whenever image inspection or recognition is needed. `force` is an instruction to the model, not a technical restriction.

### Web UI configuration

You can also edit these settings directly in the DSH Web UI:
1. Open the **Plugins** sidebar.
2. Select the installed **Magpie** package.
3. Click **Configure** on the `magpie` row to edit `gatewayUrl`, `tokenEnv`, `instructionMode`, and `allowInsecureHttp`.

Edits saved in the UI persist to your profile configuration and apply immediately to subsequent tool calls without restarting the host.

The plugin derives the MCP endpoint by appending `mcp/magpie/vision`, so the example above calls `https://magpie-gateway.alex1222.com/mcp/magpie/vision`. That endpoint must provide the MCP tool `analyze_image` accepting an `image` data URL and an optional `prompt`. `gatewayUrl` has no default and must be configured before the tool can activate. To use another token environment variable, set `tokenEnv` in the same config.

The tool accepts `analyze_image({ path, prompt? })` for PNG, JPEG, WebP, or GIF files up to 20 MiB. See [the full plugin documentation](magpie-vision/README.md) for configuration, protocol details, and the documented filesystem replacement race.
