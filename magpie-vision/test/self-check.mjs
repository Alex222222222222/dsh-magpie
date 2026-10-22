import assert from 'node:assert/strict';
import { once } from 'node:events';
import pathModule from 'node:path';
import { createServer } from 'node:http';
import test from 'node:test';
import { activate, Config, imageData, sanitizeResult } from '../index.js';

const context = (registered = () => {}, warnings = []) => ({
  tools: { register(tool) { registered(tool); return () => {}; } },
  logger: Object.assign(() => ({ warn(message) { warnings.push(message); } }), { warn() {} }),
  effect(callback) { this.cleanup = callback(); }
});

async function mockMcpServer(options = {}) {
  const methods = [];
  const requests = [];
  let finishHeldCall;
  let markCallStarted;
  const callStarted = new Promise((resolve) => { markCallStarted = resolve; });
  const heldCall = new Promise((resolve) => { finishHeldCall = resolve; });
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (chunks.length === 0) { response.writeHead(202).end(); return; }
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    methods.push(message.method);
    requests.push({ headers: request.headers, message });
    if (message.method === 'notifications/initialized') { response.writeHead(202).end(); return; }
    if (options.httpFailMethod === message.method) { response.writeHead(500, { 'content-type': 'text/plain' }).end(options.errorBody ?? 'mock failure'); return; }
    if (options.failMethod === message.method) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: options.errorBody ?? 'mock failure' } }));
      return;
    }
    let result;
    if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } };
    else if (message.method === 'tools/list') result = { tools: options.tools ?? [{ name: 'analyze_image', description: 'mock', inputSchema: { type: 'object', properties: { image: { type: 'string' }, prompt: { type: 'string' } }, required: ['image'] } }] };
    else if (message.method === 'tools/call') {
      markCallStarted();
      if (options.holdCall) await heldCall;
      result = options.callResult ?? { content: [{ type: 'text', text: 'mock image result' }], structuredContent: { label: 'test' } };
    } else { response.writeHead(400).end(); return; }
    if (!response.destroyed) response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    methods, requests, callStarted,
    releaseCall: () => finishHeldCall(),
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function setupMcpInvocation(mock) {
  let tool;
  const ctx = context((registered) => { tool = registered; });
  ctx.fs = {
    async lstat() { return { type: 'file' }; },
    async resolve(path, { cwd }) {
      const displayPath = pathModule.resolve(path.startsWith('/') ? path : `${cwd}/${path}`);
      return { targetKey: displayPath, displayPath };
    },
    contains(parent, child) { return child.displayPath === parent.displayPath || child.displayPath.startsWith(`${parent.displayPath}/`); },
    async stat() { return { type: 'file', size: 8 }; },
    async readBytes() { return Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10); }
  };
  await activate(ctx, { enabled: true, endpointUrl: mock.url, tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: true });
  return { ctx, tool, exec: { agent: { session: { header: { cwd: '/workspace' } } }, signal: new AbortController().signal } };
}

test('Config applies documented defaults and keeps endpoint optional', () => {
  assert.deepEqual(Config({}), {
    enabled: true,
    tokenEnv: 'MAGPIE_VISION_TOKEN',
    allowInsecureHttp: false
  });
});

test('disabled configuration skips validation and tool registration', async () => {
  let registered = false;
  await activate(context(() => { registered = true; }), { enabled: false });
  assert.equal(registered, false);
});

test('enabled configuration reports a missing endpoint', async () => {
  await assert.rejects(
    activate({}, { enabled: true, tokenEnv: 'MAGPIE_VISION_TOKEN', allowInsecureHttp: false }),
    /endpointUrl is required/
  );
});

test('enabled configuration reports the configured missing token', async () => {
  const previous = process.env.MAGPIE_VISION_SELF_CHECK;
  delete process.env.MAGPIE_VISION_SELF_CHECK;
  try {
    await assert.rejects(
      activate({}, { enabled: true, endpointUrl: 'https://vision.example/mcp', tokenEnv: ' ', allowInsecureHttp: false }),
      /tokenEnv must name/
    );
    await assert.rejects(
      activate({}, { enabled: true, endpointUrl: 'https://vision.example/mcp', tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: false }),
      /MAGPIE_VISION_SELF_CHECK.*not set/
    );
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_VISION_SELF_CHECK;
    else process.env.MAGPIE_VISION_SELF_CHECK = previous;
  }
});

test('endpoint validation accepts HTTPS and explicitly allowed HTTP only', async () => {
  const previous = process.env.MAGPIE_VISION_SELF_CHECK;
  process.env.MAGPIE_VISION_SELF_CHECK = 'self-check-token';
  try {
    await assert.rejects(
      activate({}, { enabled: true, endpointUrl: 'http://vision.example/mcp', tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: false }),
      /HTTPS is required/
    );
    await assert.rejects(
      activate({}, { enabled: true, endpointUrl: 'ftp://vision.example/mcp', tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: true }),
      /must use http or https/
    );
    await assert.rejects(
      activate({}, { enabled: true, endpointUrl: 'https://user:password@vision.example/mcp', tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: true }),
      /must not contain credentials/
    );
    await assert.rejects(
      activate(context(), { enabled: true, endpointUrl: 'https://@vision.example/mcp', tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: true }),
      /must not contain credentials/
    );
    let tool;
    await activate(context((registered) => { tool = registered; }), { enabled: true, endpointUrl: 'https://vision.example/mcp', tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: false });
    assert.equal(tool.name, 'analyze_image');
    const warnings = [];
    await activate(context(() => {}, warnings), { enabled: true, endpointUrl: 'http://vision.example/mcp', tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: true });
    await activate(context(() => {}, warnings), { enabled: true, endpointUrl: 'https://vision.example/mcp', tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: true });
    assert.equal(warnings.length, 2);
    assert.match(warnings.join('\n'), /allowInsecureHttp.*enabled.*bearer.*expos/i);
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_VISION_SELF_CHECK;
    else process.env.MAGPIE_VISION_SELF_CHECK = previous;
  }
});

test('file validation rejects missing, symlink, directory, oversized, and unsupported inputs before network access', async () => {
  const previous = process.env.MAGPIE_VISION_SELF_CHECK;
  process.env.MAGPIE_VISION_SELF_CHECK = 'self-check-token';
  let tool;
  let readCount = 0;
  const ctx = context((registered) => { tool = registered; });
  ctx.fs = {
    async lstat(path) {
      if (path === 'missing') return undefined;
      if (path === 'link') return { type: 'symlink' };
      if (path === 'directory') return { type: 'directory' };
      return { type: 'file' };
    },
    async resolve(path, options = {}) {
      const displayPath = pathModule.resolve(path.startsWith('/') ? path : `${options.cwd}/${path}`);
      return { targetKey: displayPath, displayPath };
    },
    contains(parent, child) { return child.displayPath === parent.displayPath || child.displayPath.startsWith(`${parent.displayPath}/`); },
    async stat(target) { return { type: 'file', size: target.targetKey.endsWith('/oversized') ? 20 * 1024 * 1024 + 1 : 1 }; },
    async readBytes(target) {
      readCount++;
      return target.targetKey.endsWith('/unsupported') ? Uint8Array.of(1) : Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
    }
  };
  try {
    await activate(ctx, { enabled: true, endpointUrl: 'https://vision.example/mcp', tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: false });
    const exec = { agent: { session: { header: { cwd: '/workspace' } } }, signal: new AbortController().signal };
    await assert.rejects(tool.execute({ path: 'missing' }, exec), /image not found/);
    await assert.rejects(tool.execute({ path: 'link' }, exec), /not a regular file/);
    await assert.rejects(tool.execute({ path: 'directory' }, exec), /not a regular file/);
    await assert.rejects(tool.execute({ path: '../outside.png' }, exec), /outside the agent working directory/);
    await assert.rejects(tool.execute({ path: '/private/outside.png' }, exec), /outside the agent working directory/);
    await assert.rejects(tool.execute({ path: 'oversized' }, exec), /20 MiB/);
    await assert.rejects(tool.execute({ path: 'unsupported' }, exec), /PNG, JPEG, WebP, or GIF/);
    assert.equal(readCount, 1);
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_VISION_SELF_CHECK;
    else process.env.MAGPIE_VISION_SELF_CHECK = previous;
  }
});

test('image paths must remain within the active agent working directory', async () => {
  const previous = process.env.MAGPIE_VISION_SELF_CHECK;
  process.env.MAGPIE_VISION_SELF_CHECK = 'self-check-token';
  let tool;
  let readCount = 0;
  const ctx = context((registered) => { tool = registered; });
  ctx.fs = {
    async lstat() { return { type: 'file' }; },
    async resolve(path, { cwd }) {
      const displayPath = pathModule.resolve(path.startsWith('/') ? path : `${cwd}/${path}`);
      return { targetKey: displayPath, displayPath };
    },
    contains(parent, child) { return child.displayPath.startsWith(`${parent.displayPath}/`); },
    async stat() { return { type: 'file', size: 8 }; },
    async readBytes() { readCount++; return Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10); }
  };
  try {
    await activate(ctx, { enabled: true, endpointUrl: 'https://vision.example/mcp', tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: false });
    const exec = { agent: { session: { header: { cwd: '/workspace/project' } } }, signal: new AbortController().signal };
    await assert.rejects(tool.execute({ path: '../outside.png' }, exec), /outside the agent working directory/);
    await assert.rejects(tool.execute({ path: '/private/outside.png' }, exec), /outside the agent working directory/);
    assert.equal(readCount, 0);
  } finally {
    await ctx.cleanup();
    if (previous === undefined) delete process.env.MAGPIE_VISION_SELF_CHECK;
    else process.env.MAGPIE_VISION_SELF_CHECK = previous;
  }
});

test('tool discovery verifies analyze_image before transmitting image bytes', async () => {
  const previous = process.env.MAGPIE_VISION_SELF_CHECK;
  process.env.MAGPIE_VISION_SELF_CHECK = 'self-check-token';
  const mock = await mockMcpServer({ tools: [{ name: 'different_tool', inputSchema: { type: 'object', properties: {} } }] });
  let tool;
  let readCount = 0;
  const ctx = context((registered) => { tool = registered; });
  ctx.fs = {
    async lstat() { return { type: 'file' }; },
    async resolve() { return { targetKey: '/workspace/photo.png', displayPath: '/workspace/photo.png' }; },
    contains() { return true; },
    async stat() { return { type: 'file', size: 8 }; },
    async readBytes() { readCount++; return Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10); }
  };
  try {
    await activate(ctx, { enabled: true, endpointUrl: mock.url, tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: true });
    await assert.rejects(tool.execute({ path: 'photo.png' }, { agent: { session: { header: { cwd: '/workspace' } } }, signal: new AbortController().signal }), /vision request failed: MCP server does not provide analyze_image/);
    assert.deepEqual(mock.methods, ['initialize', 'notifications/initialized', 'tools/list']);
    assert.equal(readCount, 1);
  } finally {
    await ctx.cleanup();
    await mock.close();
    if (previous === undefined) delete process.env.MAGPIE_VISION_SELF_CHECK;
    else process.env.MAGPIE_VISION_SELF_CHECK = previous;
  }
});

test('MCP call discovers the tool, sends the image with bearer auth, and preserves results', async () => {
  const previous = process.env.MAGPIE_VISION_SELF_CHECK;
  process.env.MAGPIE_VISION_SELF_CHECK = 'local-mock-token';
  const mock = await mockMcpServer();
  let ctx;
  let tool;
  let exec;
  try {
    ({ ctx, tool, exec } = await setupMcpInvocation(mock));
    const result = await tool.execute({ path: 'photo.png', prompt: 'read its label' }, exec);
    const toolCall = mock.requests.find(({ message }) => message.method === 'tools/call');
    assert.deepEqual(mock.methods, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    assert.equal(toolCall.headers.authorization, 'Bearer local-mock-token');
    assert.deepEqual(toolCall.message.params.arguments, { image: 'data:image/png;base64,iVBORw0KGgo=', prompt: 'read its label' });
    assert.deepEqual(result, { content: [{ type: 'text', text: 'mock image result' }], structuredContent: { label: 'test' } });
  } finally {
    if (ctx?.cleanup) await ctx.cleanup();
    await mock.close();
    if (previous === undefined) delete process.env.MAGPIE_VISION_SELF_CHECK;
    else process.env.MAGPIE_VISION_SELF_CHECK = previous;
  }
});

test('MCP isError and JSON-RPC failures become sanitized tool failures', async () => {
  const previous = process.env.MAGPIE_VISION_SELF_CHECK;
  process.env.MAGPIE_VISION_SELF_CHECK = 'local-mock-token';
  const isErrorServer = await mockMcpServer({ callResult: { isError: true, content: [{ type: 'text', text: 'local-mock-token was rejected' }] } });
  const failedServer = await mockMcpServer({ failMethod: 'tools/call', errorBody: 'local-mock-token transport detail' });
  let ctx;
  let tool;
  try {
    ({ ctx, tool } = await setupMcpInvocation(isErrorServer));
    await assert.rejects(tool.execute({ path: 'photo.png' }, { agent: { session: { header: { cwd: '/workspace' } } }, signal: new AbortController().signal }), /\[redacted\] was rejected/);
    await ctx.cleanup();
    ({ ctx, tool } = await setupMcpInvocation(failedServer));
    await assert.rejects(tool.execute({ path: 'photo.png' }, { agent: { session: { header: { cwd: '/workspace' } } }, signal: new AbortController().signal }), /\[redacted\] transport detail/);
    assert.deepEqual(failedServer.methods, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  } finally {
    if (ctx?.cleanup) await ctx.cleanup();
    await isErrorServer.close();
    await failedServer.close();
    if (previous === undefined) delete process.env.MAGPIE_VISION_SELF_CHECK;
    else process.env.MAGPIE_VISION_SELF_CHECK = previous;
  }
});

test('HTTP transport failures redact the bearer token and close the client', async () => {
  const previous = process.env.MAGPIE_VISION_SELF_CHECK;
  process.env.MAGPIE_VISION_SELF_CHECK = 'local-mock-token';
  const mock = await mockMcpServer({ httpFailMethod: 'tools/call', errorBody: 'local-mock-token rejected by local test server' });
  let ctx;
  let tool;
  try {
    ({ ctx, tool } = await setupMcpInvocation(mock));
    await assert.rejects(tool.execute({ path: 'photo.png' }, { agent: { session: { header: { cwd: '/workspace' } } }, signal: new AbortController().signal }), (error) => {
      assert.match(error.message, /vision request failed/);
      assert.match(error.message, /\[redacted\]/);
      assert.doesNotMatch(error.message, /local-mock-token/);
      return true;
    });
    assert.deepEqual(mock.methods, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  } finally {
    if (ctx?.cleanup) await ctx.cleanup();
    await mock.close();
    if (previous === undefined) delete process.env.MAGPIE_VISION_SELF_CHECK;
    else process.env.MAGPIE_VISION_SELF_CHECK = previous;
  }
});

test('cancellation aborts an in-flight MCP call and releases its client', async () => {
  const previous = process.env.MAGPIE_VISION_SELF_CHECK;
  process.env.MAGPIE_VISION_SELF_CHECK = 'local-mock-token';
  const mock = await mockMcpServer({ holdCall: true });
  let ctx;
  let tool;
  try {
    ({ ctx, tool } = await setupMcpInvocation(mock));
    const controller = new AbortController();
    const pending = tool.execute({ path: 'photo.png' }, { agent: { session: { header: { cwd: '/workspace' } } }, signal: controller.signal });
    await mock.callStarted;
    controller.abort(new Error('test cancellation'));
    await assert.rejects(pending, /test cancellation|abort/i);
    await ctx.cleanup();
    mock.releaseCall();
  } finally {
    if (ctx?.cleanup) await ctx.cleanup();
    mock.releaseCall();
    await mock.close();
    if (previous === undefined) delete process.env.MAGPIE_VISION_SELF_CHECK;
    else process.env.MAGPIE_VISION_SELF_CHECK = previous;
  }
});

test('plugin cleanup aborts and closes an active MCP client', async () => {
  const previous = process.env.MAGPIE_VISION_SELF_CHECK;
  process.env.MAGPIE_VISION_SELF_CHECK = 'local-mock-token';
  const mock = await mockMcpServer({ holdCall: true });
  let ctx;
  let tool;
  try {
    ({ ctx, tool } = await setupMcpInvocation(mock));
    const pending = tool.execute({ path: 'photo.png' }, { agent: { session: { header: { cwd: '/workspace' } } }, signal: new AbortController().signal });
    await mock.callStarted;
    const cleanup = ctx.cleanup();
    await assert.rejects(pending, /shutting down|abort|close|cancel/i);
    await cleanup;
    mock.releaseCall();
    assert.deepEqual(mock.methods, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  } finally {
    if (ctx?.cleanup) await ctx.cleanup();
    mock.releaseCall();
    await mock.close();
    if (previous === undefined) delete process.env.MAGPIE_VISION_SELF_CHECK;
    else process.env.MAGPIE_VISION_SELF_CHECK = previous;
  }
});

test('successful MCP content is preserved while bearer values are redacted', () => {
  const result = sanitizeResult({
    content: [{ type: 'text', text: 'secret-token appears in this response' }],
    structuredContent: { value: 'secret-token' }
  }, 'secret-token');
  assert.deepEqual(result, {
    content: [{ type: 'text', text: '[redacted] appears in this response' }],
    structuredContent: { value: '[redacted]' }
  });
});

test('image data checks bytes and accepts only PNG, JPEG, WebP, or GIF', () => {
  const png = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3);
  assert.equal(imageData('photo.png', png), `data:image/png;base64,${Buffer.from(png).toString('base64')}`);
  assert.equal(imageData('photo.jpeg', Uint8Array.of(255, 216, 255)), 'data:image/jpeg;base64,/9j/');
  assert.equal(imageData('photo.gif', Buffer.from('GIF89a')), 'data:image/gif;base64,R0lGODlh');
  assert.equal(imageData('photo.webp', Buffer.from('RIFF0000WEBP')), `data:image/webp;base64,${Buffer.from('RIFF0000WEBP').toString('base64')}`);
  assert.throws(() => imageData('photo.png', Uint8Array.of(1)), /PNG, JPEG, WebP, or GIF/);
  assert.throws(() => imageData('large.gif', new Uint8Array(20 * 1024 * 1024 + 1)), /20 MiB/);
});
