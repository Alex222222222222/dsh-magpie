import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Context } from '@deepseek-ai/cordis';
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
  endpointUrl: z.string().required(false),
  tokenEnv: z.string().default('MAGPIE_VISION_TOKEN'),
  allowInsecureHttp: z.boolean().default(false)
});

export const inject = ['tools', 'fs'];
export const name = 'magpie-vision';

interface VisionConfig {
  enabled: boolean;
  endpointUrl?: string;
  tokenEnv: string;
  allowInsecureHttp: boolean;
}

type PluginContext = Context & {
  fs: FileSystem;
  tools: { register(tool: ToolDefinition): () => void };
  logger: Context['logger'];
};

export function imageData(_path: string, bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('Image exceeds the 20 MiB size limit');
  const mimeType = imageMimeType(bytes);
  if (mimeType === undefined) throw new Error('Image content must be PNG, JPEG, WebP, or GIF');
  return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
}

function resolveEndpoint(config: VisionConfig): { url: URL; token: string } | undefined {
  if (!config.enabled) return undefined;
  if (!config.endpointUrl?.trim()) throw new Error('magpie-vision: endpointUrl is required when enabled');
  if (!config.tokenEnv.trim()) throw new Error('magpie-vision: tokenEnv must name a non-empty environment variable');
  let url: URL;
  try {
    url = new URL(config.endpointUrl);
  } catch {
    throw new Error('magpie-vision: endpointUrl must be an absolute HTTP or HTTPS URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('magpie-vision: endpointUrl must use http or https');
  }
  const authority = config.endpointUrl.match(/^https?:\/\/([^/?#]*)/i)?.[1];
  if (authority === undefined) throw new Error('magpie-vision: endpointUrl must be an absolute HTTP or HTTPS URL');
  if (url.username || url.password || authority.includes('@')) {
    throw new Error('magpie-vision: endpointUrl must not contain credentials');
  }
  if (url.protocol === 'http:' && !config.allowInsecureHttp) {
    throw new Error('magpie-vision: HTTPS is required; set allowInsecureHttp: true to permit HTTP');
  }
  const token = process.env[config.tokenEnv];
  if (!token) throw new Error(`magpie-vision: environment variable ${config.tokenEnv} is not set or empty`);
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

function textFromResult(result: { content: Array<Record<string, unknown>> }): string {
  return result.content.filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text as string).join('\n');
}

export async function activate(ctx: PluginContext, config: VisionConfig): Promise<void> {
  const endpoint = resolveEndpoint(config);
  if (endpoint === undefined) return;
  if (config.allowInsecureHttp) {
    ctx.logger('magpie-vision').warn('magpie-vision: allowInsecureHttp is enabled; if HTTP is used, the bearer credential may be exposed in transit');
  }

  let disposed = false;
  const activeClients = new Set<Client>();

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
      if (disposed) throw new Error('magpie-vision: plugin is shutting down');
      const agent = exec.agent;
      if (agent === undefined) throw new Error('magpie-vision: analyze_image requires an active agent');
      const cwd = agent.session.header.cwd;
      if (!cwd) throw new Error('magpie-vision: active agent has no working directory');
      if (!args.path.trim()) throw new Error('magpie-vision: path must not be empty');

      const lstat = await ctx.fs.lstat(args.path, { cwd }, exec.signal);
      if (lstat === undefined) throw new Error(`magpie-vision: image not found: ${args.path}`);
      if (lstat.type !== 'file') throw new Error(`magpie-vision: image path is not a regular file: ${args.path}`);
      const target = await ctx.fs.resolve(args.path, { cwd, signal: exec.signal });
      const info = await ctx.fs.stat(target, exec.signal);
      if (info === undefined || info.type !== 'file') throw new Error(`magpie-vision: image not found or not a regular file: ${args.path}`);
      if (info.size !== undefined && info.size > MAX_IMAGE_BYTES) throw new Error('magpie-vision: image exceeds the 20 MiB size limit');
      const bytes = await ctx.fs.readBytes(target, exec.signal, MAX_IMAGE_BYTES);
      exec.signal.throwIfAborted();
      const image = imageData(args.path, bytes);
      if (disposed) throw new Error('magpie-vision: plugin is shutting down');
      const client = new Client({ name: 'dsh-magpie-vision', version: '1.0.0' });
      activeClients.add(client);
      try {
        await client.connect(new StreamableHTTPClientTransport(endpoint.url, {
          requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } }
        }), { signal: exec.signal });
        exec.signal.throwIfAborted();
        const result = await client.callTool({
          name: 'analyze_image',
          arguments: { image, ...(args.prompt === undefined ? {} : { prompt: args.prompt }) }
        }, { signal: exec.signal });
        if (result.isError === true) throw new Error(safeError(new Error(textFromResult(result) || 'MCP tool returned isError'), endpoint.token));
        return sanitizeResult({
          content: result.content,
          ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
          ...(result.isError === undefined ? {} : { isError: result.isError })
        }, endpoint.token);
      } catch (error) {
        if (exec.signal.aborted) throw error;
        throw new Error(`magpie-vision: vision request failed: ${safeError(error, endpoint.token)}`);
      } finally {
        activeClients.delete(client);
        await client.close().catch(() => {});
      }
    }
  });

  ctx.effect(() => {
    const dispose = ctx.tools.register(tool);
    return async () => {
      disposed = true;
      dispose();
      await Promise.all([...activeClients].map((client) => client.close().catch(() => {})));
    };
  }, 'magpie-vision.analyze_image');
}

export const apply = activate;
