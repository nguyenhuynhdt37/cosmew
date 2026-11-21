import {PERMISSION_MODE_LABELS, type AppearanceConfig} from '@cosmew/contracts';

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
  client: import('@cosmew/sdk').FutrynClient,
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
        value: 'Defaults plus ~/.cosmew/keybindings.json (run /keybindings to edit)',
        source: 'keymap',
      },
      {
        label: 'Editor mode',
        value: 'Not implemented',
        disabled: 'Not implemented: vim editing mode is not available; the prompt uses the default (emacs-style) keys.',
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
        label: 'Permission mode',
        value: `${PERMISSION_MODE_LABELS[client.permissionMode()]} · sandbox ${client.status().sandbox.enabled ? 'on' : 'off'}`,
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

export const SETTINGS_TABS = ['Status', 'Config', 'Usage', 'Stats'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

type Fields = readonly (readonly [string, string])[];
const NOT_REPORTED = 'Not reported';

/** Empty user config is "None", never a fake connected row. */
function mcpServersField(client: import('@cosmew/sdk').FutrynClient): string {
  const report = client.mcpStatus();
  if (report.servers.length === 0) return 'None · /mcp';
  const connected = report.servers.filter(server => server.state === 'connected').length;
  return `${connected} connected · /mcp`;
}

/** Render the settings sources the SDK actually loaded, rather than a fixed parity placeholder. */
function settingsSourcesField(client: import('@cosmew/sdk').FutrynClient): {sources: string; diagnostics: string[]} {
  try {
    const snapshot = client.permissionSettings();
    const labels = snapshot.files
      .filter(file => file.exists)
      .map(file =>
        file.scope === 'user'
          ? 'User settings'
          : file.scope === 'project'
            ? 'Shared project settings'
            : 'Project local settings',
      );
    return {
      sources: labels.length ? [...new Set(labels)].join(', ') : 'Defaults',
      diagnostics: snapshot.diagnostics.slice(0, 3),
    };
  } catch {
    // Embedded/test clients may not expose file-backed permission settings.
    return {sources: 'Defaults', diagnostics: []};
  }
}

/** `Status` tab: connection and session facts straight from the SDK (no request is sent). */
export function statusFields(client: import('@cosmew/sdk').FutrynClient): Fields {
  const status = client.status();
  const settings = settingsSourcesField(client);
  return [
    ['Workspace', status.workspace],
    ['Session ID', status.activeSessionId ?? 'Not started'],
    ['', ''],
    ['Provider', status.activeProvider?.name ?? 'Not connected'],
    ['Account', status.activeAccount?.alias ?? 'Not connected'],
    [
      'Login method',
      status.activeProvider?.auth === 'oauth' ? 'oauth' : (status.activeAccount?.credential.kind ?? 'None'),
    ],
    ['', ''],
    ['Model', status.selection?.modelId ?? 'Not selected'],
    [
      'Permissions',
      `${PERMISSION_MODE_LABELS[status.permissionMode]} · sandbox ${status.sandbox.enabled ? 'on' : 'OFF'} · ${status.pendingPermissions} pending`,
    ],
    ['Backend', status.executionBackend?.label ?? 'No model selected'],
    ['MCP servers', mcpServersField(client)],
    ['Setting sources', settings.sources],
    ...(settings.diagnostics.length ? [['Settings diagnostics', settings.diagnostics.join(' · ')] as const] : []),
  ];
}

/** `Stats` tab: session totals the SDK actually measured. */
export function statsFields(client: import('@cosmew/sdk').FutrynClient): Fields {
  const usage = client.usage();
  let diff: ReturnType<typeof client.getWorkspaceDiff> | null = null;
  try {
    // A backend without Git reports UNSUPPORTED; the panel must still render.
    diff = client.toolsEnabled() ? client.getWorkspaceDiff() : null;
  } catch {
    diff = null;
  }
  const n = (value: number | null | undefined) => (value == null ? '—' : value.toLocaleString('en-US'));
  const last = usage.last?.usage;
  return [
    ['Session', ''],
    ['Estimated cost', usage.costUSD == null ? NOT_REPORTED : `$${usage.costUSD.toFixed(4)}`],
    ['Total duration (API)', NOT_REPORTED],
    ['Total duration (wall)', NOT_REPORTED],
    [
      'Total code changes',
      diff?.state === 'ready'
        ? `${diff.totalAdditions} lines added, ${diff.totalDeletions} lines removed`
        : NOT_REPORTED,
    ],
    [
      'Usage',
      `${n(usage.inputTokens)} input, ${n(usage.outputTokens)} output, ${n(last?.cacheReadTokens)} cache read, ${n(last?.cacheWriteTokens)} cache write (last turn)`,
    ],
  ];
}

export interface UsageMeter {
  label: string;
  percent: number | null;
  text: string;
  reset?: string;
}
/** Provider-reported limits as bars; empty when no account reported one. */
export function usageMeters(client: import('@cosmew/sdk').FutrynClient): UsageMeter[] {
  return client.limits().flatMap(account =>
    account.items
      .filter(item => item.unit !== 'USD')
      .map(item => ({
        label: item.label,
        percent: item.unlimited ? null : (item.usedPercent ?? null),
        text: item.unlimited
          ? 'unlimited'
          : item.usedPercent == null
            ? 'usage unknown'
            : `${Math.round(item.usedPercent)}% used`,
        reset: item.resetAt ? `Resets ${item.resetAt}` : undefined,
      })),
  );
}
