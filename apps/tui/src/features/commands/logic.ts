import {SLASH_COMMANDS, parseSlashCommand} from '@futryn/sdk';
import type {EffortPlan, OverlayCommandTable} from './types';

/** Overlay aliases are a projection of the command registry, never a second definition table. */
export const OVERLAY_COMMANDS: OverlayCommandTable = Object.fromEntries(
  SLASH_COMMANDS.filter(command => command.overlay).flatMap(command =>
    [command.command, ...command.aliases].map(name => [name, command.overlay!]),
  ),
);

export function isUnsupported(input: string): boolean {
  return parseSlashCommand(input).definition?.handler === 'unavailable';
}

export function unsupportedMessage(trimmed: string, _lower: string): string {
  return parseSlashCommand(trimmed).definition?.unavailable ?? 'Not implemented.';
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
