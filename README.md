# Magpie Vision for DSH

A DSH Host plugin that sends a workspace image to a configurable MCP vision endpoint.

## Install

```sh
dsh plugin --profile web add github:Alex222222222222/dsh-magpie
```

The repository includes the JavaScript runtime; installation requires no build script. DSH adds the bundle to the `web` profile. Restart the web host after configuring it.

## Update

To update an existing installation to the latest commit from this GitHub repository:

```sh
dsh plugin --profile web update @local/magpie-vision
```

`@local/magpie-vision` is the installed package name. Restart the DSH web host after the update to load the new code. Your endpoint settings in the profile's `cordis.patch.yml` and Host token environment variable remain unchanged.

## Configure

Set `MAGPIE_VISION_TOKEN` in the environment of the DSH Host process. In the `web` profile's `cordis.patch.yml`, configure the plugin endpoint:

```yaml
- id: magpie-vision
  config:
    enabled: true
    endpointUrl: https://your-vision-server.example/mcp
    tokenEnv: MAGPIE_VISION_TOKEN
    allowInsecureHttp: false
```

The endpoint must provide the MCP tool `analyze_image` accepting an `image` data URL and an optional `prompt`. The endpoint has no default and must be configured before the tool can activate. To use another token environment variable, set `tokenEnv` in the same config.

The tool accepts `analyze_image({ path, prompt? })` for PNG, JPEG, WebP, or GIF files up to 20 MiB. See [the full plugin documentation](magpie-vision/README.md) for configuration, protocol details, and the documented filesystem replacement race.
