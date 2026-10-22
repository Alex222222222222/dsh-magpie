import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Context, Volatile } from '@deepseek-ai/cordis';
import type { FileSystem } from '@deepseek-ai/dsh-fs';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
function imageMimeType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(Buffer.from(bytes.subarray(0, 6)).toString('ascii'))) return 'image/gif';
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP') return 'image/webp';
  return undefined;
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  instructionMode: z.union([z.const('normal'), z.const('suggest'), z.const('force')]).default('normal').volatile(),
  gatewayUrl: z.string().required(false).volatile(),
  tokenEnv: z.string().default('MAGPIE_API_KEY').volatile(),
  allowInsecureHttp: z.boolean().default(false).volatile()
});

export const inject = ['tools', 'fs', 'systemPrompt'];
export const name = 'magpie';

// Update these texts when the plugin gains more MCP capabilities.
const INSTRUCTIONS: Record<'suggest' | 'force', string> = {
  suggest: 'When you need to inspect or recognize an image, prefer the analyze_image tool. Do not claim to have inspected an image unless analyze_image succeeds.',
  force: 'You MUST use analyze_image whenever the task requires inspecting or recognizing an image. Do not answer from an unseen or assumed image; report analyze_image failures honestly.'
};

type Live<T> = T | Volatile<T>;

interface VisionConfig {
  enabled: boolean;
  instructionMode?: Live<'normal' | 'suggest' | 'force'>;
  gatewayUrl?: Live<string>;
  tokenEnv: Live<string>;
  allowInsecureHttp: Live<boolean>;
}

// Settings edits reach a volatile field through a live reference; plain values still load from YAML.
function read<T>(value: Live<T> | undefined): T | undefined {
  if (typeof (value as Volatile<T> | undefined)?.get !== 'function') return value as T | undefined;
  return (value as Volatile<T>).get() as T;
}

type PluginContext = Context & {
  fs: FileSystem;
  systemPrompt: { section(section: { name: string; order: number; text: (context: { scope?: object }) => string }): () => void };
  tools: { register(tool: ToolDefinition): () => void; get(name: string, scope?: object): ToolDefinition | undefined };
  logger: Context['logger'];
};

export function imageData(_path: string, bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('Image exceeds the 20 MiB size limit');
  const mimeType = imageMimeType(bytes);
  if (mimeType === undefined) throw new Error('Image content must be PNG, JPEG, WebP, or GIF');
  return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
}

const VISION_PATH = 'mcp/magpie/vision';

export function visionEndpoint(gatewayUrl: string): string {
  return `${gatewayUrl.trim().replace(/\/+$/, '')}/${VISION_PATH}`;
}

function resolveEndpoint(config: VisionConfig): { url: URL; token: string } | undefined {
  if (!config.enabled) return undefined;
  const gatewayUrl = read(config.gatewayUrl);
  const tokenEnv = read(config.tokenEnv);
  if (!gatewayUrl?.trim()) throw new Error('magpie: gatewayUrl is required when enabled');
  if (!tokenEnv?.trim()) throw new Error('magpie: tokenEnv must name a non-empty environment variable');
  const endpoint = visionEndpoint(gatewayUrl);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('magpie: gatewayUrl must be an absolute HTTP or HTTPS URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('magpie: gatewayUrl must use http or https');
  }
  const authority = endpoint.match(/^https?:\/\/([^/?#]*)/i)?.[1];
  if (authority === undefined) throw new Error('magpie: gatewayUrl must be an absolute HTTP or HTTPS URL');
  if (url.username || url.password || authority.includes('@')) {
    throw new Error('magpie: gatewayUrl must not contain credentials');
  }
  if (url.protocol === 'http:' && !read(config.allowInsecureHttp)) {
    throw new Error('magpie: HTTPS is required; set allowInsecureHttp: true to permit HTTP');
  }
  const token = process.env[tokenEnv];
  if (!token) throw new Error(`magpie: environment variable ${tokenEnv} is not set or empty`);
  return { url, token };
}

export function sanitizeResult<T>(value: T, token: string): T {
  const redact = (item: unknown): unknown => {
    if (typeof item === 'string') return item.split(token).join('[redacted]');
    if (Array.isArray(item)) return item.map(redact);
    if (item !== null && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [redact(key), redact(child)]));
    return item;
  };
  return redact(value) as T;
}

function safeError(error: unknown, token: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(token).join('[redacted]');
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function jsonArray(value: unknown): JsonValue[] {
  return JSON.parse(JSON.stringify(value)) as JsonValue[];
}

function textFromResult(result: { content: Array<Record<string, unknown>> }): string {
  return result.content.filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text as string).join('\n');
}

export async function activate(ctx: PluginContext, config: VisionConfig): Promise<void> {
  const endpoint = resolveEndpoint(config);
  if (endpoint === undefined) return;
  ctx.systemPrompt.section({
    name: 'magpie:instructions',
    order: 3050,
    text: ({ scope }) => {
      const mode = read(config.instructionMode) ?? 'normal';
      return mode === 'normal' || ctx.tools.get('analyze_image', scope) === undefined ? '' : INSTRUCTIONS[mode];
    }
  });
  if (read(config.allowInsecureHttp)) {
    ctx.logger('magpie').warn('magpie: allowInsecureHttp is enabled; if HTTP is used, the bearer credential may be exposed in transit');
  }

  let disposed = false;
  const activeClients = new Map<Client, AbortController>();
  const activeWork = new Set<AbortController>();

  const tool = defineTool({
    name: 'analyze_image',
    description: 'Analyze an image file from the current agent workspace with the configured vision service.',
    parameters: {
      path: { type: 'string', required: true, description: 'Image path relative to the active agent working directory.' },
      prompt: { type: 'string', description: 'Optional question or instruction about the image.' }
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          content: { type: 'array', items: { type: 'json' }, required: true },
          structuredContent: { type: 'json' },
          isError: { type: 'boolean' }
        },
        additionalProperties: false
      },
      render(_args, value) {
        const result = value as { content: Array<Record<string, unknown>> };
        return [{ type: 'text', text: textFromResult(result) || JSON.stringify(result) }];
      }
    },
    async execute(args: { path: string; prompt?: string }, exec: ToolRunContext) {
      if (disposed) throw new Error('magpie: plugin is shutting down');
      const workController = new AbortController();
      const abortWork = () => workController.abort(exec.signal.reason);
      if (exec.signal.aborted) abortWork();
      else exec.signal.addEventListener('abort', abortWork, { once: true });
      activeWork.add(workController);
      let token: string | undefined;
      try {
        return await run(workController.signal);
      } catch (error) {
        if (workController.signal.aborted) throw new Error(`magpie: request cancelled: ${safeError(error, token ?? '')}`);
        throw error;
      } finally {
        exec.signal.removeEventListener('abort', abortWork);
        activeWork.delete(workController);
      }

      async function run(signal: AbortSignal) {
        // Resolved per call so a settings edit applies without restarting the host.
        const visionEndpoint = resolveEndpoint(config);
        if (visionEndpoint === undefined) throw new Error('magpie: plugin is disabled');
        token = visionEndpoint.token;
        const agent = exec.agent;
        if (agent === undefined) throw new Error('magpie: analyze_image requires an active agent');
        const cwd = agent.session.header.cwd;
        if (!cwd) throw new Error('magpie: active agent has no working directory');
        if (!args.path.trim()) throw new Error('magpie: path must not be empty');

        const lstat = await ctx.fs.lstat(args.path, { cwd }, signal);
        if (lstat === undefined) throw new Error(`magpie: image not found: ${args.path}`);
        if (lstat.type !== 'file') throw new Error(`magpie: image path is not a regular file: ${args.path}`);
        const workspace = await ctx.fs.resolve(cwd, { cwd, signal });
        const target = await ctx.fs.resolve(args.path, { cwd, signal });
        if (!ctx.fs.contains(workspace, target)) throw new Error('magpie: image path is outside the agent working directory');
        const info = await ctx.fs.stat(target, signal);
        if (info === undefined || info.type !== 'file') throw new Error(`magpie: image not found or not a regular file: ${args.path}`);
        if (info.size !== undefined && info.size > MAX_IMAGE_BYTES) throw new Error('magpie: image exceeds the 20 MiB size limit');
        // shortcut: ctx.fs has no stable-handle byte read; upgrade when it can no-follow and read atomically.
        const bytes = await ctx.fs.readBytes(target, signal, MAX_IMAGE_BYTES);
        signal.throwIfAborted();
        const image = imageData(args.path, bytes);
        if (disposed) throw new Error('magpie: plugin is shutting down');
        const client = new Client({ name: 'dsh-magpie', version: '1.0.0' });
        activeClients.set(client, workController);
        try {
          await client.connect(new StreamableHTTPClientTransport(visionEndpoint.url, {
            requestInit: { headers: { Authorization: `Bearer ${visionEndpoint.token}` } }
          }), { signal });
          signal.throwIfAborted();
          const { tools } = await client.listTools(undefined, { signal });
          signal.throwIfAborted();
          if (!tools.some((item) => item.name === 'analyze_image')) throw new Error('MCP server does not provide analyze_image');
          if (disposed) throw new Error('magpie: plugin is shutting down');
          const result = await client.callTool({
            name: 'analyze_image',
            arguments: { image, ...(args.prompt === undefined ? {} : { prompt: args.prompt }) }
          }, { signal });
          if (result.isError === true) throw new Error(safeError(new Error(textFromResult(result) || 'MCP tool returned isError'), visionEndpoint.token));
          return sanitizeResult({
            content: jsonArray(result.content),
            ...(result.structuredContent === undefined ? {} : { structuredContent: jsonValue(result.structuredContent) }),
            ...(result.isError === undefined ? {} : { isError: result.isError })
          }, visionEndpoint.token);
        } catch (error) {
          if (signal.aborted) throw error;
          throw new Error(`magpie: vision request failed: ${safeError(error, visionEndpoint.token)}`);
        } finally {
          activeClients.delete(client);
          await client.close().catch(() => {});
        }
      }
    }
  });

  ctx.effect(() => {
    const dispose = ctx.tools.register(tool);
    return async () => {
      disposed = true;
      dispose();
      for (const controller of activeWork) controller.abort(new Error('magpie: plugin is shutting down'));
      await Promise.all([...activeClients].map(async ([client]) => client.close().catch(() => {})));
    };
  }, 'magpie.analyze_image');
}

export const apply = activate;
