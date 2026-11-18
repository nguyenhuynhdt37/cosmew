import {APPROVAL_POLICY_FOR_MODE, type AppearanceConfig} from '@futryn/contracts';
import {KEYMAP} from '../../hooks';

export interface SettingRow {
  label: string;
  value: string;
}

/** The rows shown in /config, in the order the controller's index maps to. */
export function settingsRows(appearance: AppearanceConfig, effectiveMode: 'dark' | 'light'): SettingRow[] {
  const a = appearance.animations;
  return [
    {label: 'Active Theme', value: `${appearance.theme} (Enter cycles Auto / Dark / Light)`},
    {
      label: 'Color Mode',
      value: `${appearance.mode === 'system' ? 'AUTO' : appearance.mode.toUpperCase()} (resolved: ${effectiveMode})`,
    },
    {label: 'Wallpaper', value: 'Unavailable for these themes'},
    {label: 'Animations Enabled', value: a.enabled ? 'ENABLED' : 'DISABLED'},
    {label: 'Motion Mode', value: a.motion.toUpperCase()},
    {label: 'Animation Speed', value: `${a.speed.toFixed(2)}x`},
    {label: 'Cell Size / Density', value: `${a.cellSize}x`},
    {label: 'Readability Veil', value: `${Math.round(a.veil * 100)}%`},
    {label: 'Reduced Motion', value: a.reducedMotion ? 'ON' : 'OFF'},
    {label: 'Pause When Unfocused', value: a.pauseUnfocused ? 'ON' : 'OFF'},
    {label: 'Reactive Agent Effects', value: a.reactiveEffects ? 'ON' : 'OFF'},
    {label: 'Syntax Highlighting', value: appearance.syntaxHighlighting ? 'ON' : 'OFF'},
    {label: 'Sidebar Panel', value: appearance.sidebar ? 'VISIBLE' : 'COLLAPSED'},
  ];
}

export const SETTINGS_ROW_COUNT = 13;

export const clampStep = (value: number, step: number, min: number, max: number, digits = 2): number =>
  Math.max(min, Math.min(max, Number((value + step).toFixed(digits))));

export const SETTINGS_SECTIONS = [
  'General',
  'Models & Providers',
  'Agent',
  'Terminal & Security',
  'Sessions',
  'Appearance',
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
export type ConfigurationAction =
  | 'models'
  | 'accounts'
  | 'effort'
  | 'permissions'
  | 'sessions'
  | 'context'
  | 'status'
  | 'mode'
  | 'budget-steps'
  | 'budget-calls'
  | 'budget-tokens'
  | 'budget-time'
  | 'budget-cost'
  | `appearance-${number}`;
export interface ConfigurationRow extends SettingRow {
  action?: ConfigurationAction;
  disabled?: string;
  source?: string;
}

/** Effective values and actions derive from the SDK, not a second configuration store. */
export function configurationRows(
  client: import('@futryn/sdk').FutrynClient,
  section: SettingsSection,
  appearance: AppearanceConfig,
  effectiveMode: 'dark' | 'light',
): ConfigurationRow[] {
  const status = client.status();
  if (section === 'Appearance')
    return settingsRows(appearance, effectiveMode).map((row, index) => ({
      ...row,
      action: `appearance-${index}` as const,
      source: client.appearanceSource(
        index === 0
          ? 'theme'
          : index === 1
            ? 'mode'
            : index === 2
              ? 'wallpaper'
              : index === 11
                ? 'syntaxHighlighting'
                : index === 12
                  ? 'sidebar'
                  : 'animations',
      ),
      ...(index === 2 ? {disabled: 'Wallpaper is unavailable for the current themes.'} : {}),
    }));
  if (section === 'General')
    return [
      {label: 'Workspace', value: status.workspace, source: 'launch directory'},
      {
        label: 'Active directory',
        value: status.workspace,
        disabled: 'Changing directory requires a new CLI launch; workspace authorization is bound to this directory.',
      },
      {
        label: 'Shell',
        value: 'Runtime-selected shell',
        disabled: 'There is no persistent shell-selection API. exec_command validates the shell for each invocation.',
      },
      {label: 'Notifications', value: 'Unavailable', disabled: 'Desktop notifications are not implemented.'},
      {label: 'Language', value: 'English interface', disabled: 'Interface language selection is not implemented.'},
      {
        label: 'Terminal shortcuts',
        value: KEYMAP.map(key => `${key.keys}: ${key.label}`).join(' · '),
        source: 'KEYMAP',
      },
    ];
  if (section === 'Models & Providers')
    return [
      {
        label: 'Provider',
        value: status.activeProvider?.name ?? 'Not connected',
        action: 'accounts',
        source: 'account selection',
      },
      {label: 'Account', value: status.activeAccount?.alias ?? 'Not connected', action: 'accounts', source: 'user'},
      {
        label: 'Default model',
        value: status.selection?.modelId ?? 'Not selected',
        action: 'models',
        source: 'user / session selection',
      },
      {
        label: 'Reasoning effort',
        value: status.reasoningEffort ?? 'Provider default',
        action: 'effort',
        source: 'per-model preference',
        ...(!status.activeModel?.reasoningEfforts?.length
          ? {disabled: 'The active model does not advertise reasoning effort controls.'}
          : {}),
      },
      {label: 'Endpoint / sign-in', value: 'Use secure provider connection flow', action: 'accounts'},
      {label: 'Tools capability', value: status.activeModel?.capabilities.tools ?? 'Unknown', action: 'status'},
    ];
  if (section === 'Agent') {
    const budget = client.defaultTurnBudget();
    const current = client.turnBudget();
    const source = JSON.stringify(current) === JSON.stringify(budget.value) ? budget.source : 'session override';
    return [
      {label: 'Mode', value: client.mode(), action: 'mode', source: 'session'},
      {
        label: 'Available tools',
        value: client.availableTools().join(', ') || 'None',
        action: 'permissions',
        source: 'effective authorization',
      },
      {label: 'Execution owner', value: status.executionBackend?.label ?? 'No active model', action: 'status'},
      {label: 'Request rounds', value: current?.maxSteps?.toString() ?? 'Unlimited', action: 'budget-steps', source},
      {label: 'Tool calls', value: current?.maxToolCalls?.toString() ?? 'Unlimited', action: 'budget-calls', source},
      {
        label: 'Token budget',
        value: current?.maxTokens?.toLocaleString() ?? 'Unlimited',
        action: 'budget-tokens',
        source,
      },
      {
        label: 'Time budget',
        value: current?.maxDurationMs ? `${current.maxDurationMs / 1000}s` : 'Unlimited',
        action: 'budget-time',
        source,
      },
      {
        label: 'Estimated cost budget',
        value: current?.maxCostUSD ? `$${current.maxCostUSD}` : 'Unlimited',
        action: 'budget-cost',
        source,
      },
      {label: 'Context / output limits', value: 'Model limits and automatic context management', action: 'context'},
    ];
  }
  if (section === 'Terminal & Security')
    return [
      {label: 'Runtime ownership', value: status.executionBackend?.toolOwner ?? 'No active model', action: 'status'},
      {
        label: 'Terminal availability',
        value: client.availableTools().includes('exec_command')
          ? 'exec_command available; approval and sandbox checked per invocation'
          : 'exec_command unavailable for this session',
        action: 'status',
      },
      {
        label: 'Approval policy',
        value: `${client.permissionPreset()} · ${client.sandboxMode()} sandbox · ${client.permissionMode()} (${APPROVAL_POLICY_FOR_MODE[client.permissionMode()]})`,
        action: 'permissions',
        source: 'session only',
      },
      {
        label: 'Workspace rules',
        value: 'Inspect effective allow / ask / deny rules',
        action: 'permissions',
        source: 'user settings',
      },
      {
        label: 'Pending approvals',
        value: `${client.listPermissions().filter(request => request.status === 'pending').length}`,
        action: 'permissions',
      },
      {
        label: 'Sandbox policy',
        value: 'Enforced by the selected execution runtime',
        disabled:
          'Sandbox backend and policy are selected at launch. A UI preference cannot increase execution authority.',
      },
      {
        label: 'Native limitations',
        value: 'macOS detached descendants may be unconfirmed; Linux needs separate acceptance',
        disabled: 'Runtime acceptance is platform-specific. A completed call does not prove descendant containment.',
      },
    ];
  return [
    {label: 'Active session', value: status.activeSessionId ?? 'No session yet', action: 'sessions'},
    {label: 'Persistence', value: 'SQLite journal; completed and interrupted turns retained', source: 'built-in'},
    {label: 'Resume', value: 'Select saved session', action: 'sessions'},
    {
      label: 'Resume behavior',
      value: 'Explicit selection through /resume',
      disabled: 'Automatic resume preference is not implemented.',
    },
    {label: 'History controls', value: 'New chats retain previous sessions; deletion is explicit', action: 'sessions'},
    {label: 'Compaction', value: 'Automatic extractive context management', action: 'context'},
    {
      label: 'Manual compaction',
      value: 'Use /compact while idle',
      action: 'context',
    },
  ];
}
