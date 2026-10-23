import assert from 'node:assert/strict';
import { once } from 'node:events';
import pathModule from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import * as plugin from '../index.js';

const { activate, Config, imageData, sanitizeResult, searchEndpoint, visionEndpoint } = plugin;

const waitFor = async (predicate, message) => {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(predicate(), message);
};

async function runRetryTest(callback) {
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const scheduled = [];
  globalThis.setTimeout = (handler, delay, ...args) => {
    if (![500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000].includes(delay)) return nativeSetTimeout(handler, delay, ...args);
    const timer = { handler: () => handler(...args), delay, cleared: false, unref() { return this; } };
    scheduled.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    if (timer && typeof timer === 'object' && 'cleared' in timer) timer.cleared = true;
    else nativeClearTimeout(timer);
  };
  try {
    await callback({ scheduled, async runNext() {
      const timer = scheduled.find((item) => !item.cleared);
      assert.ok(timer, 'expected a scheduled retry');
      timer.cleared = true;
      timer.handler();
      await new Promise((resolve) => nativeSetTimeout(resolve, 20));
      return timer.delay;
    } });
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    globalThis.clearTimeout = nativeClearTimeout;
  }
}

const context = (registered = () => {}, warnings = []) => {
  const sections = new Map();
  const disposers = [];
  return {
    tools: {
      register(tool) { registered(tool); return () => {}; },
      get(name, scope) { return name === 'analyze_image' && !(scope && scope.hidden) ? { name } : undefined; }
    },
    systemPrompt: {
      section(section) {
        sections.set(section.name, section);
        const dispose = () => sections.delete(section.name);
        disposers.push(dispose);
        return dispose;
      }
    },
    sections,
    logger: Object.assign(() => ({ warn(message) { warnings.push(message); } }), { warn() {} }),
    effect(callback) { disposers.push(callback()); },
    async cleanup() { for (const dispose of disposers.splice(0).reverse()) await dispose(); }
  };
};

async function mockMcpServer(options = {}) {
  const methods = [];
  const requests = [];
  const waitForMethod = (method, count) => waitFor(
    () => methods.filter((item) => item === method).length >= count,
    `expected ${count} ${method} requests, got ${methods.filter((item) => item === method).length}`
  );
  let activeFailures = 0;
  let maxConcurrentFailures = 0;
  let releaseFailure;
  let notifyFailureStarted;
  const failureStarted = new Promise((resolve) => { notifyFailureStarted = resolve; });
  const heldFailure = new Promise((resolve) => { releaseFailure = resolve; });
  let finishHeldCall;
  let markCallStarted;
  const callStarted = new Promise((resolve) => { markCallStarted = resolve; });
  const heldCall = new Promise((resolve) => { finishHeldCall = resolve; });
  const failureCounts = new Map(Object.entries(options.failureCounts ?? {}));
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (chunks.length === 0) { response.writeHead(202).end(); return; }
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    methods.push(message.method);
    requests.push({ headers: request.headers, url: request.url, message });
    const failuresRemaining = failureCounts.get(message.method) ?? 0;
    if (failuresRemaining > 0) {
      failureCounts.set(message.method, failuresRemaining - 1);
      activeFailures++;
      maxConcurrentFailures = Math.max(maxConcurrentFailures, activeFailures);
      notifyFailureStarted();
      if (options.delayFailure) await heldFailure;
      activeFailures--;
      if (options.httpFailMethod === message.method) {
        response.writeHead(500, { 'content-type': 'text/plain' }).end(options.errorBody ?? 'mock failure');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: options.errorBody ?? 'mock failure' } }));
      return;
    }
    if (message.method === 'notifications/initialized') { response.writeHead(202).end(); return; }
    if (options.httpFailMethod === message.method) {
      markCallStarted();
      if (options.delayHttpFailure) await heldCall;
      response.writeHead(500, { 'content-type': 'text/plain' }).end(options.errorBody ?? 'mock failure');
      return;
    }
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
    methods, requests, callStarted, failureStarted, waitForMethod,
    get maxConcurrentFailures() { return maxConcurrentFailures; },
    releaseCall: () => finishHeldCall(),
    releaseFailure: () => releaseFailure(),
    gatewayUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    })
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
  await activate(ctx, { enabled: true, gatewayUrl: mock.gatewayUrl, tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: true });
  return { ctx, tool, exec: { agent: { session: { header: { cwd: '/workspace' } } }, signal: new AbortController().signal } };
}

async function assertToolConfigError(config, pattern) {
  let tool;
  const ctx = context((registered) => { tool = registered; });
  await activate(ctx, config);
  try {
    await assert.rejects(
      tool.execute({ path: 'photo.png' }, { signal: new AbortController().signal }),
      pattern
    );
  } finally {
    await ctx.cleanup();
  }
}

const readConfig = (config) => Object.fromEntries(Object.entries(config).map(([key, value]) => [key, typeof value?.get === 'function' ? value.get() : value]));

test('Config applies documented defaults as live references the settings page can edit', () => {
  const config = Config({});
  assert.deepEqual(readConfig(config), {
    enabled: true,
    instructionMode: 'normal',
    webSearchEnabled: false,
    webSearchInstructionMode: 'normal',
    gatewayUrl: undefined,
    tokenEnv: 'MAGPIE_API_KEY',
    allowInsecureHttp: false
  });
  for (const field of ['instructionMode', 'gatewayUrl', 'tokenEnv', 'allowInsecureHttp']) {
    assert.equal(typeof config[field]?.get, 'function', `${field} must be volatile so the settings page can edit it`);
  }
});

test('web search config defaults off with independently editable live settings', () => {
  const config = Config({});
  assert.equal(readConfig(config).webSearchEnabled, false);
  assert.equal(readConfig(config).webSearchInstructionMode, 'normal');
  for (const field of ['webSearchEnabled', 'webSearchInstructionMode']) {
    assert.equal(typeof config[field]?.get, 'function', `${field} must be volatile`);
  }
  assert.throws(() => Config({ webSearchInstructionMode: 'always' }), /webSearchInstructionMode/);
});

test('web search instructions stay independent of images and follow live mode and visible names', async () => {
  let enabled = true;
  let mode = 'normal';
  let names = ['mcp__magpie_search__web_search', 'mcp__magpie_search__news_search'];
  const ctx = context(() => assert.fail('image-disabled search prompt must not register an image tool'));
  ctx.tools.schemas = (scope) => [...(scope?.hidden ? [] : names), 'analyze_image', 'mcp__other__search'].map((name) => ({ name }));
  await activate(ctx, {
    enabled: false,
    instructionMode: 'force',
    webSearchEnabled: { get: () => enabled },
    webSearchInstructionMode: { get: () => mode }
  });
  try {
    assert.equal(ctx.sections.has('magpie:instructions'), false);
    const section = ctx.sections.get('magpie:web-search-instructions');
    assert.ok(section, 'search prompt must be installed even when images are disabled');
    assert.equal(section.text({ scope: {} }), '');
    mode = 'suggest';
    assert.match(section.text({ scope: {} }), /prefer.*mcp__magpie_search__web_search.*mcp__magpie_search__news_search/);
    assert.doesNotMatch(section.text({}), /analyze_image|mcp__other/);
    assert.equal(section.text({ scope: { hidden: true } }), '');
    mode = 'force';
    assert.match(section.text({}), /MUST use.*mcp__magpie_search__web_search/);
    names = ['mcp__magpie_search__updated_search'];
    assert.match(section.text({}), /mcp__magpie_search__updated_search/);
    assert.doesNotMatch(section.text({}), /mcp__magpie_search__web_search/);
    enabled = false;
    assert.equal(section.text({}), '');
    enabled = true;
    names = [];
    assert.equal(section.text({}), '');
  } finally {
    await ctx.cleanup();
  }
  assert.equal(ctx.sections.size, 0);
});

test('web search instructions support plain settings without changing image guidance', async () => {
  const ctx = context();
  ctx.tools.schemas = () => [{ name: 'mcp__magpie_search__web_search' }];
  const config = { enabled: true, instructionMode: 'suggest', webSearchEnabled: true, webSearchInstructionMode: 'force' };
  await activate(ctx, config);
  try {
    assert.match(ctx.sections.get('magpie:instructions').text({}), /prefer the analyze_image tool/);
    const section = ctx.sections.get('magpie:web-search-instructions');
    assert.ok(section);
    assert.match(section.text({}), /MUST use.*mcp__magpie_search__web_search/);
    config.webSearchEnabled = false;
    assert.equal(section.text({}), '');
  } finally {
    await ctx.cleanup();
  }
});

test('web search disabled defaults make no network requests with blank shared settings', async () => {
  const mock = await mockMcpServer();
  const ctx = context((tool) => { if (tool.name !== 'analyze_image') assert.fail(`disabled search registered ${tool.name}`); });
  ctx.tools.schemas = () => [{ name: 'mcp__magpie_search__web_search' }];
  try {
    const config = Config({ enabled: true, webSearchEnabled: false, gatewayUrl: mock.gatewayUrl, tokenEnv: '', webSearchInstructionMode: 'force' });
    await activate(ctx, config);
    const section = ctx.sections.get('magpie:web-search-instructions');
    assert.ok(section, 'live search settings must be supported while disabled');
    assert.equal(section.text({}), '');
    assert.deepEqual(mock.methods, []);
  } finally {
    await ctx.cleanup();
    await mock.close();
  }
});

test('web search discovers advertised tools independently from image enablement', async () => {
  const previous = process.env.MAGPIE_VISION_SELF_CHECK;
  process.env.MAGPIE_VISION_SELF_CHECK = 'search-self-check-token';
  const mock = await mockMcpServer({ tools: [
    { name: 'web_search', description: 'Search the web', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'news_search', description: 'Search news', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
    { name: 'search with spaces and a name that makes the public form exceed the DSH limit while remaining unique', inputSchema: { type: 'object', properties: {} } }
  ] });
  const registered = [];
  const ctx = context((tool) => registered.push(tool));
  try {
    await activate(ctx, {
      enabled: false,
      webSearchEnabled: true,
      gatewayUrl: mock.gatewayUrl,
      tokenEnv: 'MAGPIE_VISION_SELF_CHECK',
      allowInsecureHttp: true
    });
    assert.deepEqual(registered.slice(0, 2).map((tool) => tool.name), [
      'mcp__magpie_search__web_search',
      'mcp__magpie_search__news_search'
    ]);
    const longName = 'search with spaces and a name that makes the public form exceed the DSH limit while remaining unique';
    const normalizedLongName = `mcp__magpie_search__${longName}`.replace(/[^A-Za-z0-9_-]/g, '_');
    const hash = createHash('sha256').update(`magpie_search\0${longName}`).digest('hex').slice(0, 12);
    assert.equal(registered[2].name, `${normalizedLongName.slice(0, 51)}_${hash}`);
    assert.equal(registered[2].name.length, 64);
    assert.match(registered[2].name, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(mock.methods, ['initialize', 'notifications/initialized', 'tools/list']);
    assert.equal(mock.requests[0].url, '/mcp/magpie/web-search');
    assert.equal(mock.requests[0].headers.authorization, 'Bearer search-self-check-token');
    assert.equal(searchEndpoint('  https://example.com/gateway///  '), 'https://example.com/gateway/mcp/magpie/web-search');
  } finally {
    await ctx.cleanup();
    await mock.close();
    if (previous === undefined) delete process.env.MAGPIE_VISION_SELF_CHECK;
    else process.env.MAGPIE_VISION_SELF_CHECK = previous;
  }
});

test('web search forwards raw names and arguments and preserves canonical results', async () => {
  const previous = process.env.MAGPIE_VISION_SELF_CHECK;
  process.env.MAGPIE_VISION_SELF_CHECK = 'search-self-check-token';
  const mock = await mockMcpServer({
    tools: [{ name: 'web_search', description: 'Search the web', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }],
    callResult: { content: [{ type: 'text', text: 'two results; bearer: search-self-check-token' }, { type: 'resource', resource: { uri: 'https://example.com/result', mimeType: 'text/plain', text: 'linked result' } }], structuredContent: { count: 2, bearer: 'search-self-check-token' } }
  });
  let tool;
  const ctx = context((registered) => { tool = registered; });
  try {
    await activate(ctx, {
      enabled: false,
      webSearchEnabled: true,
      gatewayUrl: mock.gatewayUrl,
      tokenEnv: 'MAGPIE_VISION_SELF_CHECK',
      allowInsecureHttp: true
    });
    const args = { query: 'weather in Paris' };
    const result = await tool.execute(args, { signal: new AbortController().signal });
    const call = mock.requests.find(({ message }) => message.method === 'tools/call');
    assert.equal(call.message.params.name, 'web_search');
    assert.deepEqual(call.message.params.arguments, args);
    assert.deepEqual(result, { content: [{ type: 'text', text: 'two results; bearer: [redacted]' }, { type: 'resource', resource: { uri: 'https://example.com/result', mimeType: 'text/plain', text: 'linked result' } }], structuredContent: { count: 2, bearer: '[redacted]' } });
  } finally {
    await ctx.cleanup();
    await mock.close();
    if (previous === undefined) delete process.env.MAGPIE_VISION_SELF_CHECK;
    else process.env.MAGPIE_VISION_SELF_CHECK = previous;
  }
});

test('web search call errors redact bearer values', async () => {
  const previous = process.env.MAGPIE_VISION_SELF_CHECK;
  process.env.MAGPIE_VISION_SELF_CHECK = 'search-self-check-token';
  const mock = await mockMcpServer({ failMethod: 'tools/call', errorBody: 'search-self-check-token call rejected' });
  let tool;
  const ctx = context((registered) => { if (registered.name.startsWith('mcp__magpie_search__')) tool = registered; });
  try {
    await activate(ctx, {
      enabled: false,
      webSearchEnabled: true,
      gatewayUrl: mock.gatewayUrl,
      tokenEnv: 'MAGPIE_VISION_SELF_CHECK',
      allowInsecureHttp: true
    });
    await assert.rejects(tool.execute({}, { signal: new AbortController().signal }), (error) => {
      assert.match(error.message, /\[redacted\] call rejected/);
      assert.doesNotMatch(error.message, /search-self-check-token/);
      return true;
    });
  } finally {
    await ctx.cleanup();
    await mock.close();
    if (previous === undefined) delete process.env.MAGPIE_VISION_SELF_CHECK;
    else process.env.MAGPIE_VISION_SELF_CHECK = previous;
  }
});

test('web search skips invalid schemas, task-required tools, and individual registration conflicts', async () => {
  const previous = process.env.MAGPIE_VISION_SELF_CHECK;
  process.env.MAGPIE_VISION_SELF_CHECK = 'search-self-check-token';
  const schema = { type: 'object', properties: {} };
  const mock = await mockMcpServer({ tools: [
    { name: 'valid_one', inputSchema: schema },
    { name: 'valid_one', inputSchema: schema },
    { name: 'invalid_schema', inputSchema: { type: 'object', properties: { query: { type: 'string', pattern: '.*' } } } },
    { name: 'task_required', inputSchema: schema, execution: { taskSupport: 'required' } },
    { name: 'conflict', inputSchema: schema },
    { name: 'valid_two', inputSchema: schema }
  ] });
  const registered = [];
  const warnings = [];
  const ctx = context((tool) => {
    if (tool.name === 'mcp__magpie_search__conflict') throw new Error('name already registered');
    registered.push(tool);
  }, warnings);
  try {
    await activate(ctx, {
      enabled: false,
      webSearchEnabled: true,
      gatewayUrl: mock.gatewayUrl,
      tokenEnv: 'MAGPIE_VISION_SELF_CHECK',
      allowInsecureHttp: true
    });
    assert.deepEqual(registered.map((tool) => tool.name), ['mcp__magpie_search__valid_one', 'mcp__magpie_search__valid_two'], warnings.join('\n'));
    assert.match(warnings.join('\n'), /duplicate tool name/);
    assert.match(warnings.join('\n'), /invalid_schema/);
    assert.match(warnings.join('\n'), /task_required/);
    assert.match(warnings.join('\n'), /conflict/);
  } finally {
    await ctx.cleanup();
    await mock.close();
    if (previous === undefined) delete process.env.MAGPIE_VISION_SELF_CHECK;
    else process.env.MAGPIE_VISION_SELF_CHECK = previous;
  }
});

test('web search initial list failures retry and recover without overlapping requests', async () => {
  const previous = process.env.MAGPIE_VISION_SELF_CHECK;
  process.env.MAGPIE_VISION_SELF_CHECK = 'search-self-check-token';
  const mock = await mockMcpServer({ failureCounts: { 'tools/list': 1 }, delayFailure: true, errorBody: 'search-self-check-token list rejected', tools: [{ name: 'web_search', inputSchema: { type: 'object', properties: {} } }] });
  const warnings = [];
  const registered = [];
  let resolveRegistration;
  const registration = new Promise((resolve) => { resolveRegistration = resolve; });
  const ctx = context((tool) => { registered.push(tool); resolveRegistration(); }, warnings);
  try {
    const activation = activate(ctx, { enabled: false, webSearchEnabled: true, gatewayUrl: mock.gatewayUrl, tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: true });
    await mock.failureStarted;
    assert.deepEqual(mock.methods, ['initialize', 'notifications/initialized', 'tools/list']);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.deepEqual(mock.methods, ['initialize', 'notifications/initialized', 'tools/list'], 'retry must not overlap the failed request');
    mock.releaseFailure();
    await activation;
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.deepEqual(mock.methods, ['initialize', 'notifications/initialized', 'tools/list', 'initialize', 'notifications/initialized', 'tools/list']);
    await registration;
    assert.equal(mock.maxConcurrentFailures, 1);
    assert.match(warnings.join('\n'), /web search.*\[redacted\] list rejected/i);
    assert.doesNotMatch(warnings.join('\n'), /search-self-check-token/);
  } finally {
    mock.releaseFailure();
    await ctx.cleanup();
    await mock.close();
    if (previous === undefined) delete process.env.MAGPIE_VISION_SELF_CHECK;
    else process.env.MAGPIE_VISION_SELF_CHECK = previous;
  }
});

test('web search initial failures retry ten times then stop at capped backoff', async () => {
  const previous = process.env.MAGPIE_VISION_SELF_CHECK;
  process.env.MAGPIE_VISION_SELF_CHECK = 'search-self-check-token';
  const mock = await mockMcpServer({ failureCounts: { initialize: 10 }, errorBody: 'search-self-check-token connect rejected' });
  const warnings = [];
  const ctx = context(() => {}, warnings);
  try {
    await runRetryTest(async ({ scheduled, runNext }) => {
      await activate(ctx, { enabled: false, webSearchEnabled: true, gatewayUrl: mock.gatewayUrl, tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: true });
      const delays = [];
      for (let attempt = 2; attempt <= 10; attempt++) {
        delays.push(await runNext());
        await mock.waitForMethod('initialize', attempt);
        await waitFor(() => warnings.filter((line) => /initial connection attempt/.test(line)).length >= attempt, `attempt ${attempt} should settle before scheduling the next retry`);
      }
      assert.deepEqual(delays, [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
      assert.equal(mock.methods.filter((method) => method === 'initialize').length, 10);
      assert.equal(scheduled.filter(({ cleared }) => !cleared).length, 0);
      assert.doesNotMatch(warnings.join('\n'), /search-self-check-token/);
    });
  } finally {
    await ctx.cleanup();
    await mock.close();
    if (previous === undefined) delete process.env.MAGPIE_VISION_SELF_CHECK;
    else process.env.MAGPIE_VISION_SELF_CHECK = previous;
  }
});

test('web search cleanup cancels a pending retry timer', async () => {
  const previous = process.env.MAGPIE_VISION_SELF_CHECK;
  process.env.MAGPIE_VISION_SELF_CHECK = 'search-self-check-token';
  const mock = await mockMcpServer({ failMethod: 'tools/list', errorBody: 'temporary list failure' });
  const ctx = context();
  try {
    await runRetryTest(async ({ scheduled }) => {
      await activate(ctx, { enabled: false, webSearchEnabled: true, gatewayUrl: mock.gatewayUrl, tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: true });
      assert.deepEqual(mock.methods, ['initialize', 'notifications/initialized', 'tools/list']);
      assert.equal(scheduled.filter(({ cleared }) => !cleared).length, 1);
      await ctx.cleanup();
      assert.equal(scheduled.filter(({ cleared }) => !cleared).length, 0);
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.deepEqual(mock.methods, ['initialize', 'notifications/initialized', 'tools/list']);
  } finally {
    await ctx.cleanup();
    await mock.close();
    if (previous === undefined) delete process.env.MAGPIE_VISION_SELF_CHECK;
    else process.env.MAGPIE_VISION_SELF_CHECK = previous;
  }
});

test('web search cleanup closes an in-flight client', async () => {
  const previous = process.env.MAGPIE_VISION_SELF_CHECK;
  process.env.MAGPIE_VISION_SELF_CHECK = 'search-self-check-token';
  const mock = await mockMcpServer({ failureCounts: { 'tools/list': 1 }, delayFailure: true });
  const ctx = context();
  try {
    const activation = activate(ctx, { enabled: false, webSearchEnabled: true, gatewayUrl: mock.gatewayUrl, tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: true });
    await mock.failureStarted;
    await ctx.cleanup();
    await assert.doesNotReject(activation);
    mock.releaseFailure();
    assert.deepEqual(mock.methods, ['initialize', 'notifications/initialized', 'tools/list']);
  } finally {
    mock.releaseFailure();
    await ctx.cleanup();
    await mock.close();
    if (previous === undefined) delete process.env.MAGPIE_VISION_SELF_CHECK;
    else process.env.MAGPIE_VISION_SELF_CHECK = previous;
  }
});

test('web search initial connection errors are logged without rejecting activation', async () => {
  const previous = process.env.MAGPIE_VISION_SELF_CHECK;
  process.env.MAGPIE_VISION_SELF_CHECK = 'search-self-check-token';
  const warnings = [];
  const registered = [];
  const ctx = context((tool) => registered.push(tool), warnings);
  try {
    await assert.doesNotReject(activate(ctx, {
      enabled: true,
      webSearchEnabled: true,
      gatewayUrl: 'https://user:search-self-check-token@example.com',
      tokenEnv: 'MAGPIE_VISION_SELF_CHECK',
      allowInsecureHttp: false
    }));
    assert.match(warnings.join('\n'), /web search/i);
    assert.doesNotMatch(warnings.join('\n'), /search-self-check-token/);
    assert.ok(registered.some((tool) => tool.name === 'analyze_image'));
  } finally {
    await ctx.cleanup();
    if (previous === undefined) delete process.env.MAGPIE_VISION_SELF_CHECK;
    else process.env.MAGPIE_VISION_SELF_CHECK = previous;
  }
});

test('web search list failures preserve image activation and redact bearer diagnostics', async () => {
  const previous = process.env.MAGPIE_VISION_SELF_CHECK;
  process.env.MAGPIE_VISION_SELF_CHECK = 'search-self-check-token';
  const mock = await mockMcpServer({ failMethod: 'tools/list', errorBody: 'search-self-check-token list rejected' });
  const warnings = [];
  const registered = [];
  const ctx = context((tool) => registered.push(tool), warnings);
  try {
    await activate(ctx, {
      enabled: true,
      webSearchEnabled: true,
      gatewayUrl: mock.gatewayUrl,
      tokenEnv: 'MAGPIE_VISION_SELF_CHECK',
      allowInsecureHttp: true
    });
    assert.deepEqual(mock.methods, ['initialize', 'notifications/initialized', 'tools/list']);
    assert.ok(registered.some((tool) => tool.name === 'analyze_image'));
    assert.match(warnings.join('\n'), /web search.*\[redacted\] list rejected/i);
    assert.doesNotMatch(warnings.join('\n'), /search-self-check-token/);
  } finally {
    await ctx.cleanup();
    await mock.close();
    if (previous === undefined) delete process.env.MAGPIE_VISION_SELF_CHECK;
    else process.env.MAGPIE_VISION_SELF_CHECK = previous;
  }
});

test('the vision MCP endpoint is derived from the gateway URL', () => {
  assert.equal(visionEndpoint('https://magpie-gateway.alex1222.com/'), 'https://magpie-gateway.alex1222.com/mcp/magpie/vision');
  assert.equal(visionEndpoint('https://magpie-gateway.alex1222.com'), 'https://magpie-gateway.alex1222.com/mcp/magpie/vision');
  assert.equal(visionEndpoint('https://example.com/gateway/'), 'https://example.com/gateway/mcp/magpie/vision');
  assert.equal(visionEndpoint('  https://example.com  '), 'https://example.com/mcp/magpie/vision');
});

test('normal mode contributes no text and a live mode change applies without restart', async () => {
  const previous = process.env.MAGPIE_VISION_SELF_CHECK;
  process.env.MAGPIE_VISION_SELF_CHECK = 'self-check-token';
  try {
    let mode = 'normal';
    const ctx = context();
    await activate(ctx, {
      enabled: true,
      instructionMode: { get: () => mode },
      gatewayUrl: 'https://vision.example/',
      tokenEnv: 'MAGPIE_VISION_SELF_CHECK',
      allowInsecureHttp: false
    });
    const section = ctx.sections.get('magpie:instructions');
    assert.equal(section.text({ scope: {} }), '');
    mode = 'force';
    assert.match(section.text({ scope: {} }), /You MUST use analyze_image/);
    await ctx.cleanup();
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_VISION_SELF_CHECK;
    else process.env.MAGPIE_VISION_SELF_CHECK = previous;
  }
});

test('suggest and force modes contribute mode-specific guidance only when the tool is visible', async () => {
  const previous = process.env.MAGPIE_VISION_SELF_CHECK;
  process.env.MAGPIE_VISION_SELF_CHECK = 'self-check-token';
  try {
    for (const [instructionMode, expected] of [
      ['suggest', /prefer the analyze_image tool/],
      ['force', /You MUST use analyze_image/]
    ]) {
      const ctx = context();
      await activate(ctx, { enabled: true, instructionMode, gatewayUrl: 'https://vision.example/', tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: false });
      const section = ctx.sections.get('magpie:instructions');
      assert.ok(section);
      assert.match(section.text({ scope: {} }), expected);
      assert.equal(section.text({ scope: { hidden: true } }), '');
      ctx.tools.get = (name) => name === 'analyze_image' ? { name } : undefined;
      assert.match(section.text({}), expected);
      await ctx.cleanup();
      assert.equal(ctx.sections.size, 0);
    }
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_VISION_SELF_CHECK;
    else process.env.MAGPIE_VISION_SELF_CHECK = previous;
  }
});

test('disabled plugin registers no tools or system prompt', async () => {
  const ctx = context(() => assert.fail('disabled plugin must not register its tool'));
  await activate(ctx, { enabled: false, instructionMode: 'force' });
  assert.equal(ctx.sections.size, 0);
});

test('invalid instruction mode is rejected by configuration', () => {
  assert.throws(() => Config({ instructionMode: 'always' }), /instructionMode/);
});

test('disabled configuration skips validation and tool registration', async () => {
  let registered = false;
  await activate(context(() => { registered = true; }), { enabled: false });
  assert.equal(registered, false);
});

test('blank gateway configuration activates and reports the missing URL only when the tool is called', async () => {
  let tool;
  const ctx = context((registered) => { tool = registered; });
  await activate(ctx, Config({}));
  assert.equal(tool.name, 'analyze_image');
  assert.ok(ctx.sections.has('magpie:instructions'));
  await assert.rejects(
    tool.execute({ path: 'photo.png' }, { signal: new AbortController().signal }),
    /gatewayUrl is required/
  );
  await ctx.cleanup();
});

test('enabled configuration reports a missing token when the tool is called', async () => {
  const previous = process.env.MAGPIE_VISION_SELF_CHECK;
  delete process.env.MAGPIE_VISION_SELF_CHECK;
  try {
    await assertToolConfigError(
      { enabled: true, gatewayUrl: 'https://vision.example/', tokenEnv: ' ', allowInsecureHttp: false },
      /tokenEnv must name/
    );
    await assertToolConfigError(
      { enabled: true, gatewayUrl: 'https://vision.example/', tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: false },
      /MAGPIE_VISION_SELF_CHECK.*not set/
    );
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_VISION_SELF_CHECK;
    else process.env.MAGPIE_VISION_SELF_CHECK = previous;
  }
});

test('gateway validation accepts HTTPS and explicitly allowed HTTP only', async () => {
  const previous = process.env.MAGPIE_VISION_SELF_CHECK;
  process.env.MAGPIE_VISION_SELF_CHECK = 'self-check-token';
  try {
    await assertToolConfigError(
      { enabled: true, gatewayUrl: 'http://vision.example/', tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: false },
      /HTTPS is required/
    );
    await assertToolConfigError(
      { enabled: true, gatewayUrl: 'ftp://vision.example/', tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: true },
      /must use http or https/
    );
    await assertToolConfigError(
      { enabled: true, gatewayUrl: 'https://user:password@vision.example/', tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: true },
      /must not contain credentials/
    );
    await assertToolConfigError(
      { enabled: true, gatewayUrl: 'https://@vision.example/', tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: true },
      /must not contain credentials/
    );
    let tool;
    const ctx = context((registered) => { tool = registered; });
    await activate(ctx, { enabled: true, gatewayUrl: 'https://vision.example/', tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: false });
    assert.equal(tool.name, 'analyze_image');
    const warnings = [];
    await activate(context(() => {}, warnings), { enabled: true, gatewayUrl: 'http://vision.example/', tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: true });
    await activate(context(() => {}, warnings), { enabled: true, gatewayUrl: 'https://vision.example/', tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: true });
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
    await activate(ctx, { enabled: true, gatewayUrl: 'https://vision.example/', tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: false });
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
    await activate(ctx, { enabled: true, gatewayUrl: 'https://vision.example/', tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: false });
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
    await activate(ctx, { enabled: true, gatewayUrl: mock.gatewayUrl, tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: true });
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

test('a settings write to the gateway applies to the next call without restart', async () => {
  const previous = process.env.MAGPIE_VISION_SELF_CHECK;
  process.env.MAGPIE_VISION_SELF_CHECK = 'live-token';
  const first = await mockMcpServer();
  const second = await mockMcpServer();
  let ctx;
  let tool;
  let gatewayUrl = first.gatewayUrl;
  try {
    const fs = {
      async lstat() { return { type: 'file' }; },
      async resolve(path) { const displayPath = pathModule.resolve(path); return { targetKey: displayPath, displayPath }; },
      contains(parent, child) { return child.displayPath.startsWith(parent.displayPath); },
      async stat() { return { type: 'file', size: 8 }; },
      async readBytes() { return Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10); }
    };
    ctx = context((registered) => { tool = registered; });
    ctx.fs = fs;
    await activate(ctx, {
      enabled: true,
      gatewayUrl: { get: () => gatewayUrl },
      tokenEnv: 'MAGPIE_VISION_SELF_CHECK',
      allowInsecureHttp: true
    });
    const exec = { agent: { session: { header: { cwd: '/workspace' } } }, signal: new AbortController().signal };
    await tool.execute({ path: '/workspace/photo.png' }, exec);
    assert.deepEqual(first.methods, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    assert.deepEqual(second.methods, []);
    gatewayUrl = second.gatewayUrl;
    await tool.execute({ path: '/workspace/photo.png' }, exec);
    assert.deepEqual(second.methods, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  } finally {
    if (ctx?.cleanup) await ctx.cleanup();
    await first.close();
    await second.close();
    if (previous === undefined) delete process.env.MAGPIE_VISION_SELF_CHECK;
    else process.env.MAGPIE_VISION_SELF_CHECK = previous;
  }
});

test('analyze_image accepts image parameter alias, files in /tmp, and direct data URLs', async () => {
  const previous = process.env.MAGPIE_VISION_SELF_CHECK;
  process.env.MAGPIE_VISION_SELF_CHECK = 'local-mock-token';
  const mock = await mockMcpServer();
  let ctx;
  let tool;
  let exec;
  try {
    ({ ctx, tool, exec } = await setupMcpInvocation(mock));

    // 1. Calling with image parameter alias pointing to /tmp file
    await tool.execute({ image: '/tmp/kcl_proposal-1.png', prompt: 'test /tmp file' }, exec);
    let toolCall = mock.requests.find(({ message }) => message.method === 'tools/call');
    assert.ok(toolCall.message.params.arguments.image.startsWith('data:image/png;base64,'));
    assert.equal(toolCall.message.params.arguments.prompt, 'test /tmp file');

    // 2. Calling with direct pre-encoded data URL
    mock.requests.length = 0;
    await tool.execute({ image: 'data:image/jpeg;base64,iVBORw0KGgo=', prompt: 'direct data URL' }, exec);
    toolCall = mock.requests.find(({ message }) => message.method === 'tools/call');
    assert.equal(toolCall.message.params.arguments.image, 'data:image/jpeg;base64,iVBORw0KGgo=');
    assert.equal(toolCall.message.params.arguments.prompt, 'direct data URL');
  } finally {
    if (ctx?.cleanup) await ctx.cleanup();
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
    assert.equal(mock.requests.find(({ message }) => message.method === 'initialize').message.params.clientInfo.name, 'dsh-magpie');
    assert.equal(toolCall.headers.authorization, 'Bearer local-mock-token');
    assert.equal(mock.requests[0].url, '/mcp/magpie/vision');
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
    controller.abort(new Error('local-mock-token test cancellation'));
    const cancellation = await pending.then(() => undefined, (error) => error);
    assert.ok(cancellation instanceof Error);
    assert.match(cancellation.message, /\[redacted\].*test cancellation/);
    assert.doesNotMatch(cancellation.message, /local-mock-token/);
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

test('plugin cleanup aborts a filesystem read already in progress', async () => {
  const previous = process.env.MAGPIE_VISION_SELF_CHECK;
  process.env.MAGPIE_VISION_SELF_CHECK = 'local-mock-token';
  let markReadStarted;
  const readStarted = new Promise((resolve) => { markReadStarted = resolve; });
  let releaseRead;
  let readAborted = false;
  let tool;
  const ctx = context((registered) => { tool = registered; });
  ctx.fs = {
    async lstat() { return { type: 'file' }; },
    async resolve(path, { cwd }) {
      const displayPath = pathModule.resolve(path.startsWith('/') ? path : `${cwd}/${path}`);
      return { targetKey: displayPath, displayPath };
    },
    contains(parent, child) { return child.displayPath.startsWith(`${parent.displayPath}/`); },
    async stat() { return { type: 'file', size: 8 }; },
    readBytes(_target, signal) {
      markReadStarted();
      return new Promise((resolve, reject) => {
        releaseRead = () => resolve(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10));
        signal.addEventListener('abort', () => { readAborted = true; reject(signal.reason); }, { once: true });
      });
    }
  };
  const controller = new AbortController();
  let pending;
  try {
    await activate(ctx, { enabled: true, gatewayUrl: 'http://127.0.0.1:1', tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: true });
    pending = tool.execute({ path: 'photo.png' }, { agent: { session: { header: { cwd: '/workspace' } } }, signal: controller.signal });
    await readStarted;
    await ctx.cleanup();
    assert.equal(readAborted, true);
    await assert.rejects(pending, /shutting down|abort|cancel/i);
  } finally {
    controller.abort(new Error('test cleanup'));
    releaseRead?.();
    if (pending) await pending.catch(() => {});
    if (ctx.cleanup) await ctx.cleanup();
    if (previous === undefined) delete process.env.MAGPIE_VISION_SELF_CHECK;
    else process.env.MAGPIE_VISION_SELF_CHECK = previous;
  }
});

test('cancellation redacts a transport failure racing with abort', async () => {
  const previous = process.env.MAGPIE_VISION_SELF_CHECK;
  process.env.MAGPIE_VISION_SELF_CHECK = 'local-mock-token';
  const mock = await mockMcpServer({ httpFailMethod: 'tools/call', delayHttpFailure: true, errorBody: 'local-mock-token server rejection' });
  let ctx;
  let tool;
  try {
    ({ ctx, tool } = await setupMcpInvocation(mock));
    const controller = new AbortController();
    const pending = tool.execute({ path: 'photo.png' }, { agent: { session: { header: { cwd: '/workspace' } } }, signal: controller.signal });
    await mock.callStarted;
    mock.releaseCall();
    controller.abort(new Error('local-mock-token cancellation raced with HTTP failure'));
    const error = await pending.then(() => undefined, (failure) => failure);
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /local-mock-token/);
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
