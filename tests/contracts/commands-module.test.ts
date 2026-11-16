import { expect, test } from 'bun:test';
import { OVERLAY_COMMANDS, isUnsupported, planEffort, unsupportedMessage } from '@futryn/tui';

test('every overlay command alias resolves to the overlay its command opens', () => {
  expect(OVERLAY_COMMANDS['/config']).toBe('settings');
  expect(OVERLAY_COMMANDS['/settings']).toBe('settings');
  expect(OVERLAY_COMMANDS['/perm']).toBe('permissions');
  expect(OVERLAY_COMMANDS['/continue']).toBe('sessions');
  expect(OVERLAY_COMMANDS['/?']).toBe('help');
  expect(OVERLAY_COMMANDS['/login']).toBeUndefined(); // login has arguments and its own flow
});

test('unsupported backends explain themselves instead of failing silently', () => {
  for (const command of ['/mcp', '/plugin', '/plugins x', '/compact']) expect(isUnsupported(command)).toBe(true);
  expect(isUnsupported('/mcpx')).toBe(false);
  expect(unsupportedMessage('/compact', '/compact')).toContain('Not implemented');
  expect(unsupportedMessage('/mcp', '/mcp')).toContain('MCP authentication');
});

test('effort planning handles models without levels, unknown levels, auto and status', () => {
  expect(planEffort('', []).kind).toBe('banner');
  expect(planEffort('', ['low', 'high'])).toEqual({ kind: 'open' });
  expect(planEffort('bogus', ['low', 'high']).kind).toBe('banner');
  expect(planEffort('auto', ['low'])).toEqual({ kind: 'apply', level: 'default', available: ['low'] });
  expect(planEffort('status', ['low'])).toEqual({ kind: 'apply', level: null, available: ['low'] });
  expect(planEffort('high', ['low', 'high'])).toEqual({ kind: 'apply', level: 'high', available: ['low', 'high'] });
});
