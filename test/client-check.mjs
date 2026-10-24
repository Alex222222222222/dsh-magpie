import assert from 'node:assert/strict';
import test from 'node:test';

let loaded;
globalThis.window = { __ModuleLoader__: { load: (entry) => { loaded = entry; } } };
await import('../client.js');

const messages = new Proxy({}, { get: (_, prop) => prop });
const Button = 'Button';
const Input = 'Input';
const SegmentedControl = 'SegmentedControl';
const Switch = 'Switch';

const requireStub = (id) => {
  if (id === 'react') return { createElement, useEffect, useState };
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Button, Input, SegmentedControl, Switch };
  throw new Error(`unexpected module request: ${id}`);
};

let hooks = [];
let cursor = 0;
function createElement(type, props, ...children) {
  return { type, props: { ...props, ...(children.length === 0 ? {} : { children }) } };
}
function useState(initial) {
  const index = cursor++;
  if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
  return [hooks[index], (next) => {
    hooks[index] = typeof next === 'function' ? next(hooks[index]) : next;
  }];
}
function useEffect(effect, deps) {
  const index = cursor++;
  const previous = hooks[index];
  if (previous !== undefined && deps !== undefined && previous.deps?.length === deps.length && previous.deps.every((dep, at) => Object.is(dep, deps[at]))) return;
  hooks[index] = { deps };
  effect();
}

const bundle = loaded.factory(requireStub);
const { ConfigurationPage } = bundle;

function render(props) {
  cursor = 0;
  return ConfigurationPage(props);
}
function freshRender() {
  hooks = [];
  cursor = 0;
}
function findAll(node, type, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, type, found);
    return found;
  }
  if (node === null || typeof node !== 'object') return found;
  if (node.type === type) found.push(node);
  findAll(node.props?.children, type, found);
  return found;
}
function text(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(text).join('');
  return text(node.props?.children);
}

const inputByPlaceholder = (tree, placeholder) => findAll(tree, 'Input').find((i) => i.props.placeholder?.includes(placeholder));
const buttonByText = (tree, label) => findAll(tree, 'Button').find((button) => text(button) === label);

const t = (key) => messages[key];
const copies = {
  ready: {
    status: 'ready',
    value: { gatewayUrl: 'https://example.com/', tokenEnv: 'MAGPIE_API_KEY', enabled: true, instructionMode: 'suggest', allowInsecureHttp: false, webSearchEnabled: false, webSearchInstructionMode: 'normal' },
    base: { gatewayUrl: 'https://example.com/', enabled: true, instructionMode: 'normal', tokenEnv: 'MAGPIE_API_KEY', allowInsecureHttp: false, webSearchEnabled: false, webSearchInstructionMode: 'normal' },
    user: { instructionMode: 'suggest' },
    writable: true,
    revision: 7
  }
};

test('the bundle registers one client module for this package', () => {
  assert.equal(loaded.id, '@alex222222222222/magpie');
  assert.deepEqual(bundle.inject, ['slots', 'locale']);
  assert.equal(typeof bundle.apply, 'function');
  assert.equal(bundle.NS, 'settings.magpie');
});

test('apply registers the locale and a row configuration page under the package key', () => {
  const registered = [];
  const effects = [];
  const ctx = {
    locale: {
      bind: (namespace) => {
        assert.equal(namespace, 'settings.magpie');
        return t;
      },
      register: (namespace, dictionaries) => {
        assert.equal(namespace, 'settings.magpie');
        assert.equal(dictionaries.en.allowInsecureHttp, 'Allow plain HTTP');
        return () => {};
      }
    },
    slots: {
      inject: (slot, register) => {
        assert.equal(slot, 'plugins.row.config');
        return register();
      },
      register: (options, component) => {
        registered.push({ options, component });
        return () => {};
      }
    },
    effect: (callback, label) => {
      effects.push({ label, disposer: callback() });
      return () => {};
    }
  };
  bundle.apply(ctx);
  assert.equal(registered.length, 1);
  assert.deepEqual(registered[0].options, { name: 'plugins.row.config', key: '@alex222222222222/magpie#magpie', locale: 'settings.magpie' });
  assert.equal(registered[0].component, ConfigurationPage);
  assert.deepEqual(effects.map(({ label }) => label), ['magpie: settings copy', 'magpie: settings page']);
  assert.deepEqual(effects.map(({ disposer }) => typeof disposer), ['function', 'function']);
});

test('the summary view describes the page and a missing form renders nothing', () => {
  freshRender();
  assert.equal(render({ t, view: 'summary' }), messages.description);
  assert.equal(render({ t, view: 'page' }), null);
});

test('an unavailable deployment reports it instead of a form', () => {
  freshRender();
  const tree = render({ t, view: 'page', form: { state: { status: 'unavailable' } } });
  assert.equal(text(tree), messages.unavailable);
});

test('the page stages all seven settings and saves them in one revision-fenced write', async () => {
  freshRender();
  const calls = [];
  const form = { state: copies.ready, mutate: async (ops, revision) => { calls.push({ ops, revision }); return true; } };
  let tree = render({ t, view: 'page', form });

  const inputs = findAll(tree, 'Input');
  assert.equal(inputs.length, 2);
  const segmented = findAll(tree, 'SegmentedControl');
  assert.equal(segmented.length, 2);
  assert.equal(segmented[0].props.value, 'suggest');
  assert.equal(segmented[1].props.value, 'normal');
  const toggle = findAll(tree, 'Switch');
  assert.equal(toggle.length, 3);
  assert.equal(toggle[0].props.checked, true);
  assert.equal(toggle[1].props.checked, false);
  assert.equal(toggle[2].props.checked, false);

  // Edit gatewayUrl
  inputs[0].props.onChange({ target: { value: 'https://other.example' } });
  // Disable image analysis independently of web search
  toggle[0].props.onChange(false);
  // Allow plain HTTP
  toggle[1].props.onChange(true);
  // Enable web search independently of image analysis
  toggle[2].props.onChange(true);
  // Edit webSearchInstructionMode
  segmented[1].props.onChange('force');

  tree = render({ t, view: 'page', form });
  assert.equal(findAll(tree, 'Input')[0].props.value, 'https://other.example');
  assert.equal(findAll(tree, 'Switch')[0].props.checked, false);
  assert.equal(findAll(tree, 'Switch')[1].props.checked, true);
  assert.equal(findAll(tree, 'Switch')[2].props.checked, true);
  assert.equal(findAll(tree, 'SegmentedControl')[1].props.value, 'force');

  await buttonByText(tree, messages.save).props.onClick();
  assert.deepEqual(calls, [{
    ops: [
      { op: 'set', path: ['gatewayUrl'], value: 'https://other.example' },
      { op: 'set', path: ['tokenEnv'], value: 'MAGPIE_API_KEY' },
      { op: 'set', path: ['enabled'], value: false },
      { op: 'set', path: ['instructionMode'], value: 'suggest' },
      { op: 'set', path: ['allowInsecureHttp'], value: true },
      { op: 'set', path: ['webSearchEnabled'], value: true },
      { op: 'set', path: ['webSearchInstructionMode'], value: 'force' }
    ],
    revision: 7
  }]);
  assert.match(text(render({ t, view: 'page', form })), /saved/);
});

test('page fields do not use a service-specific gateway placeholder or repeat the page description', () => {
  freshRender();
  const tree = render({ t, view: 'page', form: { state: copies.ready } });
  assert.equal(findAll(tree, 'Input')[0].props.placeholder, 'https://example.com/');
  assert.equal(text(tree).split(messages.description).length - 1, 0);
});

test('an invalid draft blocks saving and is reported on the field', async () => {
  freshRender();
  const calls = [];
  const form = { state: copies.ready, mutate: async (...args) => { calls.push(args); return false; } };
  let tree = render({ t, view: 'page', form });
  findAll(tree, 'Input')[0].props.onChange({ target: { value: 'not a url' } });
  tree = render({ t, view: 'page', form });
  assert.match(text(tree), /invalidGateway/);
  assert.equal(buttonByText(tree, messages.save).props.disabled, true);
  assert.deepEqual(calls, []);
});

test('discard resets drafts back to stored snapshot values', async () => {
  freshRender();
  const form = { state: copies.ready, mutate: async () => false };
  let tree = render({ t, view: 'page', form });
  findAll(tree, 'Input')[0].props.onChange({ target: { value: 'https://temporary.example' } });
  findAll(tree, 'Switch')[0].props.onChange(false);
  findAll(tree, 'Switch')[1].props.onChange(true);
  findAll(tree, 'Switch')[2].props.onChange(true);
  tree = render({ t, view: 'page', form });
  assert.equal(findAll(tree, 'Input')[0].props.value, 'https://temporary.example');
  assert.equal(findAll(tree, 'Switch')[0].props.checked, false);
  assert.equal(findAll(tree, 'Switch')[1].props.checked, true);
  assert.equal(findAll(tree, 'Switch')[2].props.checked, true);
  buttonByText(tree, messages.discard).props.onClick();
  tree = render({ t, view: 'page', form });
  assert.equal(findAll(tree, 'Input')[0].props.value, 'https://example.com/');
  assert.equal(findAll(tree, 'Switch')[0].props.checked, true);
  assert.equal(findAll(tree, 'Switch')[2].props.checked, false);
});

test('a read-only document disables the controls and says so', () => {
  freshRender();
  const tree = render({ t, view: 'page', form: { state: { ...copies.ready, writable: false } } });
  assert.equal(findAll(tree, 'Input')[0].props.disabled, true);
  assert.equal(buttonByText(tree, messages.save).props.disabled, true);
  assert.match(text(tree), /readOnly/);
});
