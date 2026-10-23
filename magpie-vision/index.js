import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHash } from 'node:crypto';
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client';
import z from '@deepseek-ai/schemastery';
import { assertObjectJsonSchema, defineTool } from '@deepseek-ai/dsh-tools';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
function imageMimeType(bytes) {
  if (bytes.length >= 8 && [
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10
  ].every((byte, index)=>bytes[index] === byte)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 6 && [
    'GIF87a',
    'GIF89a'
  ].includes(Buffer.from(bytes.subarray(0, 6)).toString('ascii'))) return 'image/gif';
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP') return 'image/webp';
  return undefined;
}
export const Config = z.object({
  enabled: z.boolean().default(true),
  instructionMode: z.union([
    z.const('normal'),
    z.const('suggest'),
    z.const('force')
  ]).default('normal').volatile(),
  webSearchEnabled: z.boolean().default(false).volatile(),
  webSearchInstructionMode: z.union([
    z.const('normal'),
    z.const('suggest'),
    z.const('force')
  ]).default('normal').volatile(),
  gatewayUrl: z.string().required(false).volatile(),
  tokenEnv: z.string().default('MAGPIE_API_KEY').volatile(),
  allowInsecureHttp: z.boolean().default(false).volatile()
});
export const inject = [
  'tools',
  'fs',
  'systemPrompt'
];
export const name = 'magpie';
// Update these texts when the plugin gains more MCP capabilities.
const INSTRUCTIONS = {
  suggest: 'When you need to inspect or recognize an image, prefer the analyze_image tool. Do not claim to have inspected an image unless analyze_image succeeds.',
  force: 'You MUST use analyze_image whenever the task requires inspecting or recognizing an image. Do not answer from an unseen or assumed image; report analyze_image failures honestly.'
};
// Settings edits reach a volatile field through a live reference; plain values still load from YAML.
function read(value) {
  if (typeof value?.get !== 'function') return value;
  return value.get();
}
export function imageData(_path, bytes) {
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('Image exceeds the 20 MiB size limit');
  const mimeType = imageMimeType(bytes);
  if (mimeType === undefined) throw new Error('Image content must be PNG, JPEG, WebP, or GIF');
  return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
}
const VISION_PATH = 'mcp/magpie/vision';
export function visionEndpoint(gatewayUrl) {
  return `${gatewayUrl.trim().replace(/\/+$/, '')}/${VISION_PATH}`;
}
export function searchEndpoint(gatewayUrl) {
  return `${gatewayUrl.trim().replace(/\/+$/, '')}/mcp/magpie/web-search`;
}
function resolveEndpoint(config) {
  if (!config.enabled) return undefined;
  return resolveGateway(config, visionEndpoint);
}
function resolveGateway(config, endpointFor) {
  const gatewayUrl = read(config.gatewayUrl);
  const tokenEnv = read(config.tokenEnv);
  if (!gatewayUrl?.trim()) throw new Error('magpie: gatewayUrl is required when enabled');
  if (!tokenEnv?.trim()) throw new Error('magpie: tokenEnv must name a non-empty environment variable');
  const endpoint = endpointFor(gatewayUrl);
  let url;
  try {
    url = new URL(endpoint);
  } catch  {
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
  return {
    url,
    token
  };
}
const SEARCH_SERVER_NAME = 'magpie_search';
const MAX_PUBLIC_NAME_LENGTH = 64;
const HASH_LENGTH = 12;
function searchToolName(rawName) {
  const joined = `mcp__${SEARCH_SERVER_NAME}__${rawName}`;
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_');
  if (joined === normalized && joined.length <= MAX_PUBLIC_NAME_LENGTH) return joined;
  const hash = createHash('sha256').update(`${SEARCH_SERVER_NAME}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH);
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}
export function sanitizeResult(value, token) {
  const redact = (item)=>{
    if (typeof item === 'string') return item.split(token).join('[redacted]');
    if (Array.isArray(item)) return item.map(redact);
    if (item !== null && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child])=>[
        redact(key),
        redact(child)
      ]));
    return item;
  };
  return redact(value);
}
function safeError(error, token) {
  const message = error instanceof Error ? error.message : String(error);
  return token ? message.split(token).join('[redacted]') : message;
}
function jsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}
function jsonArray(value) {
  return JSON.parse(JSON.stringify(value));
}
function textFromResult(result) {
  return result.content.filter((block)=>block.type === 'text' && typeof block.text === 'string').map((block)=>block.text).join('\n');
}
export async function activate(ctx, config) {
  if (read(config.allowInsecureHttp) && (config.enabled || read(config.webSearchEnabled))) {
    ctx.logger('magpie').warn('magpie: allowInsecureHttp is enabled; if HTTP is used, the bearer credential may be exposed in transit');
  }
  if (config.webSearchEnabled !== undefined) {
    ctx.systemPrompt.section({
      name: 'magpie:web-search-instructions',
      order: 3051,
      text: ({ scope })=>{
        const mode = read(config.webSearchInstructionMode) ?? 'normal';
        if (!read(config.webSearchEnabled) || mode === 'normal') return '';
        const names = ctx.tools.schemas(scope).map((tool)=>tool.name).filter((name)=>name.startsWith('mcp__magpie_search__'));
        if (names.length === 0) return '';
        return mode === 'force' ? `You MUST use the Magpie search tools (${names.join(', ')}) for web research.` : `When web research would help, prefer the Magpie search tools (${names.join(', ')}).`;
      }
    });
  }
  if (config.webSearchEnabled !== undefined) {
    const logger = ctx.logger('magpie');
    let searchClient;
    let searchTools = new Map();
    let disposed = false;
    const warn = (message, token = '')=>logger.warn(`magpie web search: ${safeError(message, token)}`);
    const closeClient = async (client)=>{
      if (client) await client.close().catch(()=>{});
    };
    const disposeTools = ()=>{
      for (const dispose of searchTools.values()){
        try {
          dispose();
        } catch (error) {
          warn(`tool disposal failed: ${String(error)}`);
        }
      }
      searchTools.clear();
    };
    const connectSearch = async ()=>{
      if (disposed) return;
      const endpoint = resolveGateway(config, searchEndpoint);
      if (!endpoint) return;
      const client = new Client({
        name: 'dsh-magpie-search',
        version: '1.0.0'
      });
      let retained = false;
      try {
        await client.connect(new StreamableHTTPClientTransport(endpoint.url, {
          requestInit: {
            headers: {
              Authorization: `Bearer ${endpoint.token}`
            }
          }
        }));
        const { tools } = await client.listTools();
        if (disposed) return;
        const definitions = new Map();
        for (const advertised of tools){
          const publicName = searchToolName(advertised.name);
          if (definitions.has(publicName)) {
            warn(`duplicate tool name skipped: ${advertised.name}`, endpoint.token);
            continue;
          }
          if (advertised.execution?.taskSupport === 'required') {
            warn(`task-required tool skipped: ${advertised.name}`, endpoint.token);
            continue;
          }
          try {
            assertObjectJsonSchema(advertised.inputSchema);
            definitions.set(publicName, {
              rawName: advertised.name,
              definition: createMcpToolDefinition(ctx, {
                name: publicName,
                rawName: advertised.name,
                description: advertised.description ?? '',
                inputSchema: advertised.inputSchema,
                outputSchema: advertised.outputSchema,
                call: async (args, exec)=>{
                  try {
                    return sanitizeResult(await client.callTool({
                      name: advertised.name,
                      arguments: args
                    }, {
                      signal: exec.signal,
                      toolDefinition: advertised
                    }), endpoint.token);
                  } catch (error) {
                    throw new Error(safeError(error, endpoint.token));
                  }
                }
              })
            });
          } catch (error) {
            warn(`invalid tool schema skipped (${advertised.name}): ${String(error)}`, endpoint.token);
          }
        }
        if (disposed) return;
        disposeTools();
        const nextTools = new Map();
        for (const [publicName, { definition, rawName }] of definitions){
          try {
            nextTools.set(publicName, ctx.tools.register(definition));
          } catch (error) {
            warn(`tool registration failed (${rawName}): ${String(error)}`, endpoint.token);
          }
        }
        searchTools = nextTools;
        const previous = searchClient;
        searchClient = client;
        retained = true;
        await closeClient(previous);
      } finally{
        if (!retained) await closeClient(client);
      }
    };
    ctx.effect(()=>()=>{
        disposed = true;
        disposeTools();
        const client = searchClient;
        searchClient = undefined;
        return closeClient(client);
      }, 'magpie.web_search');
    if (read(config.webSearchEnabled)) {
      try {
        await connectSearch();
      } catch (error) {
        let token = '';
        try {
          token = resolveGateway(config, searchEndpoint)?.token ?? '';
        } catch  {}
        warn(`initial connection failed: ${String(error)}`, token);
      }
    }
  }
  if (!config.enabled) return;
  ctx.systemPrompt.section({
    name: 'magpie:instructions',
    order: 3050,
    text: ({ scope })=>{
      const mode = read(config.instructionMode) ?? 'normal';
      return mode === 'normal' || ctx.tools.get('analyze_image', scope) === undefined ? '' : INSTRUCTIONS[mode];
    }
  });
  let disposed = false;
  const activeClients = new Map();
  const activeWork = new Set();
  const tool = defineTool({
    name: 'analyze_image',
    description: 'Analyze an image file from the workspace or /tmp with the configured vision service.',
    parameters: {
      path: {
        type: 'string',
        description: 'Image path relative to the active agent working directory or under /tmp.'
      },
      image: {
        type: 'string',
        description: 'Alias for path, or a direct data URL (data:image/...) or http(s) URL.'
      },
      prompt: {
        type: 'string',
        description: 'Optional question or instruction about the image.'
      }
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          content: {
            type: 'array',
            items: {
              type: 'json'
            },
            required: true
          },
          structuredContent: {
            type: 'json'
          },
          isError: {
            type: 'boolean'
          }
        },
        additionalProperties: false
      },
      render (_args, value) {
        const result = value;
        return [
          {
            type: 'text',
            text: textFromResult(result) || JSON.stringify(result)
          }
        ];
      }
    },
    async execute (args, exec) {
      if (disposed) throw new Error('magpie: plugin is shutting down');
      const workController = new AbortController();
      const abortWork = ()=>workController.abort(exec.signal.reason);
      if (exec.signal.aborted) abortWork();
      else exec.signal.addEventListener('abort', abortWork, {
        once: true
      });
      activeWork.add(workController);
      let token;
      try {
        return await run(workController.signal);
      } catch (error) {
        if (workController.signal.aborted) throw new Error(`magpie: request cancelled: ${safeError(error, token ?? '')}`);
        throw error;
      } finally{
        exec.signal.removeEventListener('abort', abortWork);
        activeWork.delete(workController);
      }
      async function run(signal) {
        if (!config.enabled) throw new Error('magpie: plugin is disabled');
        // Resolved per call so a settings edit applies without restarting the host.
        const visionEndpoint = resolveEndpoint(config);
        if (visionEndpoint === undefined) {
          throw new Error('magpie: gatewayUrl is required; configure it in Plugins -> Magpie -> Configure or cordis.patch.yml');
        }
        token = visionEndpoint.token;
        const agent = exec.agent;
        if (agent === undefined) throw new Error('magpie: analyze_image requires an active agent');
        const cwd = agent.session.header.cwd;
        if (!cwd) throw new Error('magpie: active agent has no working directory');
        const input = (args.path || args.image || '').trim();
        if (!input) throw new Error('magpie: path must not be empty');
        let image;
        if (input.startsWith('data:image/') || /^https?:\/\//i.test(input)) {
          image = input;
        } else {
          const lstat = await ctx.fs.lstat(input, {
            cwd
          }, signal);
          if (lstat === undefined) throw new Error(`magpie: image not found: ${input}`);
          if (lstat.type !== 'file') throw new Error(`magpie: image path is not a regular file: ${input}`);
          const workspace = await ctx.fs.resolve(cwd, {
            cwd,
            signal
          });
          const target = await ctx.fs.resolve(input, {
            cwd,
            signal
          });
          const isWorkspace = ctx.fs.contains(workspace, target);
          const isTmp = target.displayPath.startsWith('/tmp/') || target.displayPath.startsWith('/private/tmp/');
          if (!isWorkspace && !isTmp) throw new Error('magpie: image path is outside the agent working directory');
          const info = await ctx.fs.stat(target, signal);
          if (info === undefined || info.type !== 'file') throw new Error(`magpie: image not found or not a regular file: ${input}`);
          if (info.size !== undefined && info.size > MAX_IMAGE_BYTES) throw new Error('magpie: image exceeds the 20 MiB size limit');
          // shortcut: ctx.fs has no stable-handle byte read; upgrade when it can no-follow and read atomically.
          const bytes = await ctx.fs.readBytes(target, signal, MAX_IMAGE_BYTES);
          signal.throwIfAborted();
          image = imageData(input, bytes);
        }
        if (disposed) throw new Error('magpie: plugin is shutting down');
        const client = new Client({
          name: 'dsh-magpie',
          version: '1.0.0'
        });
        activeClients.set(client, workController);
        try {
          await client.connect(new StreamableHTTPClientTransport(visionEndpoint.url, {
            requestInit: {
              headers: {
                Authorization: `Bearer ${visionEndpoint.token}`
              }
            }
          }), {
            signal
          });
          signal.throwIfAborted();
          const { tools } = await client.listTools(undefined, {
            signal
          });
          signal.throwIfAborted();
          if (!tools.some((item)=>item.name === 'analyze_image')) throw new Error('MCP server does not provide analyze_image');
          if (disposed) throw new Error('magpie: plugin is shutting down');
          const result = await client.callTool({
            name: 'analyze_image',
            arguments: {
              image,
              ...args.prompt === undefined ? {} : {
                prompt: args.prompt
              }
            }
          }, {
            signal
          });
          if (result.isError === true) throw new Error(safeError(new Error(textFromResult(result) || 'MCP tool returned isError'), visionEndpoint.token));
          return sanitizeResult({
            content: jsonArray(result.content),
            ...result.structuredContent === undefined ? {} : {
              structuredContent: jsonValue(result.structuredContent)
            },
            ...result.isError === undefined ? {} : {
              isError: result.isError
            }
          }, visionEndpoint.token);
        } catch (error) {
          if (signal.aborted) throw error;
          throw new Error(`magpie: vision request failed: ${safeError(error, visionEndpoint.token)}`);
        } finally{
          activeClients.delete(client);
          await client.close().catch(()=>{});
        }
      }
    }
  });
  ctx.effect(()=>{
    const dispose = ctx.tools.register(tool);
    return async ()=>{
      disposed = true;
      dispose();
      for (const controller of activeWork)controller.abort(new Error('magpie: plugin is shutting down'));
      await Promise.all([
        ...activeClients
      ].map(async ([client])=>client.close().catch(()=>{})));
    };
  }, 'magpie.analyze_image');
}
export const apply = activate;
