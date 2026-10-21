import assert from 'node:assert/strict';
import test from 'node:test';
import { activate, Config, imageData, sanitizeResult } from '../index.js';

const context = (registered = () => {}, warnings = []) => ({
  tools: { register(tool) { registered(tool); return () => {}; } },
  logger: Object.assign(() => ({ warn(message) { warnings.push(message); } }), { warn() {} }),
  effect(callback) { this.cleanup = callback(); }
});

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
    async resolve(path) { return { targetKey: path, displayPath: `/workspace/${path}` }; },
    async stat(target) { return { type: 'file', size: target.targetKey === 'oversized' ? 20 * 1024 * 1024 + 1 : 1 }; },
    async readBytes() { readCount++; return Uint8Array.of(1); }
  };
  try {
    await activate(ctx, { enabled: true, endpointUrl: 'https://vision.example/mcp', tokenEnv: 'MAGPIE_VISION_SELF_CHECK', allowInsecureHttp: false });
    const exec = { agent: { session: { header: { cwd: '/workspace' } } }, signal: new AbortController().signal };
    await assert.rejects(tool.execute({ path: 'missing' }, exec), /image not found/);
    await assert.rejects(tool.execute({ path: 'link' }, exec), /not a regular file/);
    await assert.rejects(tool.execute({ path: 'directory' }, exec), /not a regular file/);
    await assert.rejects(tool.execute({ path: 'oversized' }, exec), /20 MiB/);
    await assert.rejects(tool.execute({ path: 'unsupported' }, exec), /PNG, JPEG, WebP, or GIF/);
    assert.equal(readCount, 1);
  } finally {
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
