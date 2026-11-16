import type {EffortPlan, OverlayCommandTable} from './types';

/** Commands that only open an overlay, by lowercase text (aliases included). */
export const OVERLAY_COMMANDS: OverlayCommandTable = {
  '/models': 'models',
  '/model': 'models',
  '/sessions': 'sessions',
  '/resume': 'sessions',
  '/continue': 'sessions',
  '/permissions': 'permissions',
  '/perm': 'permissions',
  '/diff': 'diff',
  '/settings': 'settings',
  '/config': 'settings',
  '/status': 'status',
  '/help': 'help',
  '/?': 'help',
};

/** Commands whose backend does not exist yet; they explain instead of failing silently. */
const UNSUPPORTED = ['/mcp', '/plugin', '/plugins', '/compact'];

export function isUnsupported(lower: string): boolean {
  return UNSUPPORTED.some(c => lower === c || lower.startsWith(c + ' '));
}

export function unsupportedMessage(trimmed: string, lower: string): string {
  const detail = lower.startsWith('/mcp')
    ? 'MCP authentication remains separate from provider authentication.'
    : lower.startsWith('/compact')
      ? 'Context summarization backend is unavailable; use /clear or /resume.'
      : 'No plugin host or plugin authentication drivers are enabled.';
  return `${trimmed.split(' ')[0]}: Not implemented in PA1/TUI1. ${detail}`;
}

/** Decide what `/effort [arg]` should do given the model's advertised levels. */
export function planEffort(args: string, available: string[]): EffortPlan {
  if (!available.length)
    return {
      kind: 'banner',
      message: 'Reasoning effort is not advertised by this model/transport. Provider default is used.',
    };
  const value = args === 'auto' ? 'default' : args;
  if (!value) return {kind: 'open'};
  if (value !== 'status' && value !== 'default' && !available.includes(value)) {
    return {
      kind: 'banner',
      message: `Available efforts: ${available.join(', ')}. Use /effort <level> or /effort auto. Advanced Claude-only modes are not supported by this transport.`,
    };
  }
  return {kind: 'apply', level: value === 'status' ? null : value, available};
}
