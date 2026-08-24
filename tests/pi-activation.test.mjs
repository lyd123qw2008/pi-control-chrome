import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_TOOL_NAMES, applyBrowserToolMask, createBrowserActivation } from '../pi-extension/activation.js';

test('Pi browser activation starts hidden and masks only browser tools', () => {
  const activation = createBrowserActivation();
  const calls = [];
  const api = {
    getActiveTools: () => ['read', 'browser_status', 'write'],
    setActiveTools: names => calls.push(names),
  };
  applyBrowserToolMask(api, activation.active);
  assert.deepEqual(calls, [['read', 'write']]);
  assert.equal(activation.active, false);
});

test('Pi Skill activation exposes all browser tools and does not drop ordinary tools', () => {
  const activation = createBrowserActivation();
  const calls = [];
  const api = {
    getActiveTools: () => ['read', 'write'],
    setActiveTools: names => calls.push(names),
  };
  activation.setActive(true);
  applyBrowserToolMask(api, activation.active);
  assert.deepEqual(calls[0], ['read', 'write', ...BROWSER_TOOL_NAMES]);
  assert.equal(new Set(calls[0]).size, 2 + BROWSER_TOOL_NAMES.length);
});

test('Pi activation reset hides tools at session boundaries and tracks real use separately', () => {
  const activation = createBrowserActivation();
  activation.setActive(true);
  activation.markUsed();
  assert.equal(activation.used, true);
  activation.clearUsed();
  assert.equal(activation.active, true);
  assert.equal(activation.used, false);
  activation.reset();
  assert.equal(activation.active, false);
  assert.equal(activation.used, false);
});
