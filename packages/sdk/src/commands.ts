export type CommandOverlay =
  | 'usage'
  | 'context'
  | 'effort'
  | 'themes'
  | 'models'
  | 'sessions'
  | 'sandbox'
  | 'permissions'
  | 'diff'
  | 'settings'
  | 'status'
  | 'help'
  | 'agents'
  | 'background-tasks'
  | 'connect'
  | 'mcp'
  | 'hooks'
  | 'rewind';
export type CommandHandler =
  | 'overlay'
  | 'effort'
  | 'sandbox'
  | 'permissions'
  | 'backend'
  | 'switch'
  | 'model'
  | 'resume'
  | 'fork'
  | 'doctor'
  | 'login'
  | 'logout'
  | 'accounts'
  | 'clear'
  | 'compact'
  | 'autocompact'
  | 'btw'
  | 'add-dir'
  | 'reload-skills'
  | 'skills'
  | 'memory'
  | 'exit'
  | 'keybindings'
  | 'init'
  | 'export'
  | 'copy'
  | 'rename'
  | 'mode'
  | 'unavailable';

export interface SlashCommandDef {
  /** Dispatch key, interpreted by the UI command router; every definition has one handler. */
  handler: CommandHandler;
  overlay?: CommandOverlay;
  requires?: 'model' | 'workspace' | 'independent';
  autocomplete?: boolean;
  help?: boolean;
  command: string;
  aliases: string[];
  title: string;
  description: string;
  category: 'Navigation' | 'Appearance' | 'Providers & Models' | 'Sessions' | 'Workspace & Security';
  shortcut?: string;
  arguments?: 'optional' | 'required';
  duringRequest?: boolean;
  /** Read-only inspection may be available while mutating arguments remain blocked. */
  argumentsDuringRequest?: boolean;
  unavailable?: string;
}

/**
 * Claude Code keeps environment-dependent commands out of the command menu when
 * a capability is unavailable, but still recognizes the full command name so it
 * can explain why it cannot run. Keep the same distinction in the shared registry.
 */
function unavailableClaudeCommand(
  command: string,
  aliases: string[] = [],
  argumentsMode?: 'optional' | 'required',
): SlashCommandDef {
  const label = command.slice(1).replace(/-/g, ' ');
  return {
    command,
    handler: 'unavailable',
    aliases,
    title: label[0]!.toUpperCase() + label.slice(1),
    description: `Claude Code command ${command} is not available in Cosmew yet`,
    category: 'Workspace & Security',
    autocomplete: false,
    help: false,
    ...(argumentsMode ? {arguments: argumentsMode} : {}),
    unavailable: `${command} is not implemented in Cosmew yet.`,
  };
}

const CLAUDE_UNAVAILABLE_COMMANDS: readonly SlashCommandDef[] = [
  unavailableClaudeCommand('/advisor', [], 'optional'),
  unavailableClaudeCommand('/artifact-capabilities'),
  unavailableClaudeCommand('/artifact-diagramming'),
  unavailableClaudeCommand('/artifacts'),
  unavailableClaudeCommand('/auto-mode-setup'),
  unavailableClaudeCommand('/autofix-pr', [], 'optional'),
  unavailableClaudeCommand('/background', ['/bg'], 'optional'),
  unavailableClaudeCommand('/batch', [], 'required'),
  unavailableClaudeCommand('/branch', [], 'optional'),
  unavailableClaudeCommand('/bug', ['/share'], 'optional'),
  unavailableClaudeCommand('/cd', [], 'required'),
  unavailableClaudeCommand('/chrome'),
  unavailableClaudeCommand('/claude-api', [], 'optional'),
  unavailableClaudeCommand('/claude-in-chrome', [], 'optional'),
  unavailableClaudeCommand('/color', [], 'optional'),
  unavailableClaudeCommand('/debug', [], 'optional'),
  unavailableClaudeCommand('/deep-research', [], 'required'),
  unavailableClaudeCommand('/design', [], 'optional'),
  unavailableClaudeCommand('/design-login'),
  unavailableClaudeCommand('/design-sync', [], 'optional'),
  unavailableClaudeCommand('/desktop', ['/app']),
  unavailableClaudeCommand('/dataviz', [], 'optional'),
  unavailableClaudeCommand('/fast', [], 'optional'),
  unavailableClaudeCommand('/feedback', [], 'optional'),
  unavailableClaudeCommand('/fewer-permission-prompts'),
  unavailableClaudeCommand('/focus', [], 'optional'),
  unavailableClaudeCommand('/goal', [], 'optional'),
  unavailableClaudeCommand('/heapdump'),
  unavailableClaudeCommand('/import', [], 'optional'),
  unavailableClaudeCommand('/ide'),
  unavailableClaudeCommand('/insights'),
  unavailableClaudeCommand('/install-github-app'),
  unavailableClaudeCommand('/install-slack-app'),
  unavailableClaudeCommand('/list-agents', ['/peers']),
  unavailableClaudeCommand('/loop', ['/proactive'], 'optional'),
  unavailableClaudeCommand('/mobile', ['/ios', '/android']),
  unavailableClaudeCommand('/output-style', [], 'optional'),
  unavailableClaudeCommand('/passes'),
  unavailableClaudeCommand('/plugin-authoring'),
  unavailableClaudeCommand('/powerup'),
  unavailableClaudeCommand('/privacy-settings'),
  unavailableClaudeCommand('/radio'),
  unavailableClaudeCommand('/rate-limit-options'),
  unavailableClaudeCommand('/recap'),
  unavailableClaudeCommand('/reload-plugins', [], 'optional'),
  unavailableClaudeCommand('/remote-control', ['/rc']),
  unavailableClaudeCommand('/remote-env'),
  unavailableClaudeCommand('/release-notes'),
  unavailableClaudeCommand('/restart', ['/update']),
  unavailableClaudeCommand('/run', [], 'optional'),
  unavailableClaudeCommand('/schedule', ['/routines'], 'optional'),
  unavailableClaudeCommand('/scroll-speed'),
  unavailableClaudeCommand('/security-review'),
  unavailableClaudeCommand('/simplify', [], 'optional'),
  unavailableClaudeCommand('/skill-doctor'),
  unavailableClaudeCommand('/slides', [], 'optional'),
  unavailableClaudeCommand('/setup-bedrock'),
  unavailableClaudeCommand('/setup-vertex'),
  unavailableClaudeCommand('/statusline', [], 'optional'),
  unavailableClaudeCommand('/stickers'),
  unavailableClaudeCommand('/stop'),
  unavailableClaudeCommand('/subtask', [], 'required'),
  unavailableClaudeCommand('/team-onboarding'),
  unavailableClaudeCommand('/teleport', ['/tp']),
  unavailableClaudeCommand('/terminal-setup'),
  unavailableClaudeCommand('/tui', [], 'optional'),
  unavailableClaudeCommand('/ultrareview', [], 'optional'),
  unavailableClaudeCommand('/update-config', [], 'optional'),
  unavailableClaudeCommand('/upgrade'),
  unavailableClaudeCommand('/usage-credits'),
  unavailableClaudeCommand('/verify', [], 'optional'),
  unavailableClaudeCommand('/voice', [], 'optional'),
  unavailableClaudeCommand('/web-setup'),
  unavailableClaudeCommand('/workflow-authoring'),
  unavailableClaudeCommand('/workflows'),
];

export const SLASH_COMMANDS: readonly SlashCommandDef[] = [
  {
    command: '/sandbox',
    handler: 'sandbox',
    overlay: 'sandbox',
    aliases: [],
    arguments: 'optional',
    duringRequest: true,
    argumentsDuringRequest: true,
    title: 'Sandbox',
    description:
      'Configure sandbox Mode, Dependencies, Overrides and Config; /sandbox exclude "<pattern>" adds an exclusion',
    category: 'Workspace & Security',
  },
  {
    command: '/usage',
    handler: 'overlay',
    overlay: 'usage',
    aliases: ['/cost', '/stats'],
    title: 'Usage & Estimated Cost',
    description: 'Per-turn and session usage with coverage and pricing provenance',
    category: 'Navigation',
    duringRequest: true,
  },
  {
    command: '/context',
    handler: 'overlay',
    overlay: 'context',
    aliases: [],
    arguments: 'optional',
    title: 'Context Window',
    description: 'Model limits, output reserve, measured or estimated context',
    category: 'Navigation',
    duringRequest: true,
  },
  {
    command: '/effort',
    handler: 'effort',
    aliases: [],
    title: 'Reasoning Effort',
    description: 'Set an effort advertised by the active provider/model',
    category: 'Providers & Models',
    arguments: 'optional',
  },
  {
    command: '/theme',
    handler: 'overlay',
    overlay: 'themes',
    duringRequest: true,
    aliases: ['/themes'],
    title: 'Theme Picker',
    description: 'Choose Auto, Dark, or Light',
    category: 'Appearance',
  },
  {
    command: '/model',
    handler: 'model',
    overlay: 'models',
    arguments: 'optional',
    aliases: ['/models'],
    title: 'Select Model',
    description: 'Search and select active model from discovered or cached provider catalog',
    category: 'Providers & Models',
  },
  {
    command: '/login',
    handler: 'login',
    arguments: 'optional',
    aliases: ['/connect'],
    title: 'Connect Provider Account',
    description: 'Connect providers with supported browser/device sign-in, API keys or custom endpoints',
    category: 'Providers & Models',
  },
  {
    command: '/logout',
    handler: 'logout',
    arguments: 'optional',
    aliases: [],
    title: 'Sign Out',
    description: 'Confirm sign-out of a named account and delete its local credential',
    category: 'Providers & Models',
  },
  {
    command: '/switch',
    handler: 'switch',
    aliases: ['/account'],
    title: 'Switch Account',
    description: 'Use another connected account while continuing the current conversation',
    category: 'Providers & Models',
    arguments: 'optional',
  },
  {
    command: '/doctor',
    handler: 'doctor',
    aliases: ['/checkup'],
    title: 'Diagnose Connection',
    description: 'Validate active provider connectivity and runtime configuration',
    category: 'Providers & Models',
  },
  {
    command: '/mcp',
    handler: 'overlay',
    overlay: 'mcp',
    aliases: [],
    arguments: 'optional',
    title: 'MCP Servers',
    description: 'Manage user MCP servers, tools, connections and authentication',
    category: 'Workspace & Security',
  },
  {
    command: '/hooks',
    handler: 'overlay',
    overlay: 'hooks',
    aliases: [],
    title: 'Hooks',
    description: 'Inspect configured lifecycle hooks, scopes, matchers and trust status',
    category: 'Workspace & Security',
    duringRequest: true,
  },
  {
    command: '/add-dir',
    handler: 'add-dir',
    requires: 'workspace',
    aliases: [],
    arguments: 'optional',
    title: 'Add Working Directory',
    description: 'List or add an additional working directory for this session (--save persists to local settings)',
    category: 'Workspace & Security',
  },
  {
    command: '/reload-skills',
    handler: 'reload-skills',
    requires: 'workspace',
    aliases: [],
    title: 'Reload Skills',
    description: 'Rescan project, user and system skill directories without restarting',
    category: 'Workspace & Security',
    duringRequest: true,
  },
  {
    command: '/autocompact',
    handler: 'autocompact',
    aliases: [],
    arguments: 'optional',
    title: 'Auto-Compact',
    description: 'Toggle or set automatic context compaction (on|off|status)',
    category: 'Sessions',
    duringRequest: true,
    argumentsDuringRequest: true,
  },
  {
    command: '/btw',
    handler: 'btw',
    requires: 'model',
    aliases: [],
    arguments: 'required',
    title: 'Side Question',
    description: 'Ask a quick side question using current context without modifying session history or running tools',
    category: 'Sessions',
  },
  {
    command: '/rewind',
    handler: 'overlay',
    overlay: 'rewind',
    aliases: ['/checkpoint', '/undo'],
    title: 'Rewind',
    description: 'Restore conversation and/or tracked text edits from a checkpoint',
    category: 'Sessions',
  },
  {
    command: '/plugin',
    handler: 'unavailable',
    autocomplete: false,
    help: false,
    unavailable: 'Not implemented: plugin host.',
    aliases: ['/plugins'],
    title: 'Plugin Management',
    description: 'Not implemented in PA1/TUI1; no plugin host is enabled',
    category: 'Workspace & Security',
  },
  {
    command: '/memory',
    handler: 'memory',
    aliases: [],
    title: 'Memories',
    description: 'List, read or delete memories; /memory open opens the user memory folder',
    category: 'Workspace & Security',
    arguments: 'optional',
  },
  {
    command: '/tasks',
    handler: 'overlay',
    overlay: 'background-tasks',
    aliases: ['/bashes'],
    title: 'Background Tasks',
    description: 'Show background shells and agents, inspect live output, or stop a running task',
    category: 'Workspace & Security',
    duringRequest: true,
  },
  {
    command: '/agents',
    handler: 'overlay',
    overlay: 'agents',
    requires: 'workspace',
    aliases: [],
    title: 'Agents',
    description: "List agent types (built-in and custom) and this session's subagents; view a transcript or stop one",
    category: 'Workspace & Security',
    duringRequest: true,
  },
  {
    command: '/skills',
    handler: 'skills',
    aliases: ['/skill'],
    title: 'Skills',
    description: 'Manage skill visibility and browse skills by source',
    category: 'Workspace & Security',
    duringRequest: true,
  },
  {
    command: '/compact',
    handler: 'compact',
    arguments: 'optional',
    aliases: [],
    title: 'Compact Context',
    description:
      'Summarize older history with the current model to free context; optional text says what to preserve (idle only)',
    category: 'Sessions',
  },
  {
    command: '/resume',
    handler: 'resume',
    overlay: 'sessions',
    arguments: 'optional',
    aliases: ['/sessions', '/continue'],
    title: 'Session Picker',
    description: 'Browse, search, resume, or delete saved conversation sessions',
    category: 'Sessions',
  },
  {
    command: '/fork',
    handler: 'fork',
    aliases: [],
    arguments: 'optional',
    title: 'Fork Session',
    description: 'Copy committed conversation history into a new session without replaying tools',
    category: 'Sessions',
  },
  {
    command: '/permissions',
    duringRequest: true,
    handler: 'permissions',
    overlay: 'permissions',
    arguments: 'optional',
    aliases: ['/perm', '/allowed-tools'],
    title: 'Permissions',
    description:
      'Manage allow, ask and deny rules; /permissions [default|acceptEdits|plan|bypassPermissions] changes the session mode',
    category: 'Workspace & Security',
  },
  {
    command: '/backend',
    duringRequest: true,
    handler: 'backend',
    arguments: 'optional',
    aliases: [],
    title: 'Execution Backend',
    description: 'Shows who runs the agent loop and the project tools for the selected model',
    category: 'Workspace & Security',
  },
  {
    command: '/diff',
    duringRequest: true,
    handler: 'overlay',
    overlay: 'diff',
    requires: 'workspace',
    aliases: [],
    title: 'Workspace Diff Viewer',
    description: 'Inspect git working tree changes with syntax-colored unified diff hunks',
    category: 'Workspace & Security',
  },
  {
    command: '/config',
    handler: 'overlay',
    overlay: 'settings',
    aliases: ['/settings'],
    arguments: 'optional',
    title: 'Configuration',
    description: 'Inspect effective coding-agent configuration and edit supported settings',
    category: 'Appearance',
  },
  {
    command: '/status',
    handler: 'overlay',
    overlay: 'status',
    duringRequest: true,
    aliases: [],
    title: 'System & Provider Status',
    description: 'View active provider, account, model, session stats, and backend capabilities',
    category: 'Navigation',
  },
  {
    command: '/plan',
    handler: 'mode',
    requires: 'independent',
    aliases: [],
    arguments: 'optional',
    title: 'Plan Mode',
    description: 'Plan with read-only tools; optional request starts a planning turn',
    category: 'Workspace & Security',
  },
  {
    command: '/code-review',
    handler: 'mode',
    requires: 'independent',
    aliases: ['/review'],
    arguments: 'optional',
    title: 'Code Review',
    description: 'Review the current diff for correctness, security and regressions',
    category: 'Workspace & Security',
  },
  {
    command: '/chat',
    handler: 'mode',
    aliases: ['/implement'],
    title: 'Chat / Implementation Mode',
    description: 'Return to chat; modifications still require the current permission policy',
    category: 'Workspace & Security',
  },
  {
    command: '/clear',
    handler: 'clear',
    arguments: 'optional',
    aliases: ['/new', '/reset'],
    title: 'Clear Conversation',
    description: 'Start a fresh conversation; previous sessions remain available via /resume',
    category: 'Sessions',
  },
  {
    command: '/help',
    handler: 'overlay',
    overlay: 'help',
    duringRequest: true,
    aliases: ['/?'],
    title: 'Keyboard & Command Help',
    description: 'Show all COSMEW keyboard shortcuts, slash commands, and navigation rules',
    category: 'Navigation',
  },
  {
    command: '/init',
    handler: 'init',
    requires: 'model',
    aliases: [],
    title: 'Initialize Project Instructions',
    description: 'Analyze the project and generate AGENTS.md',
    category: 'Workspace & Security',
  },
  {
    command: '/export',
    handler: 'export',
    aliases: [],
    arguments: 'optional',
    title: 'Export Conversation',
    description: 'Export the conversation as plain text',
    category: 'Sessions',
  },
  {
    command: '/copy',
    handler: 'copy',
    aliases: [],
    arguments: 'optional',
    title: 'Copy Response',
    description: 'Copy a recent assistant response or select a code block or quote',
    category: 'Sessions',
  },
  {
    command: '/rename',
    handler: 'rename',
    aliases: [],
    arguments: 'optional',
    title: 'Rename Session',
    description: 'Name the current session for /resume',
    category: 'Sessions',
  },
  {
    command: '/keybindings',
    handler: 'keybindings',
    aliases: [],
    title: 'Keyboard Shortcuts File',
    description: 'Create or edit ~/.cosmew/keybindings.json in $VISUAL/$EDITOR; changes reload automatically',
    category: 'Navigation',
    duringRequest: true,
  },
  {
    command: '/exit',
    handler: 'exit',
    aliases: ['/quit'],
    title: 'Exit COSMEW',
    description: 'Restore terminal state cleanly and exit the TUI',
    category: 'Navigation',
  },
  ...CLAUDE_UNAVAILABLE_COMMANDS,
];

// Legacy COSMEW-only commands remain parseable for existing users. They are
// intentionally absent from the public discovery, autocomplete, and help list.
const LEGACY_COMMANDS: readonly SlashCommandDef[] = [
  {
    command: '/theme set',
    handler: 'unavailable',
    aliases: ['/themes set'],
    title: 'Legacy Theme Command',
    description: 'Use /theme',
    category: 'Appearance',
    arguments: 'optional',
    unavailable: 'Use /theme to choose Auto, Dark, or Light.',
  },
  {
    command: '/theme edit',
    handler: 'unavailable',
    aliases: ['/customize'],
    title: 'Theme Editor',
    description: 'Custom theme editing is unavailable',
    unavailable: 'Custom themes are unavailable. Use /theme to choose Auto, Dark, or Light.',
    category: 'Appearance',
  },
  {
    command: '/accounts',
    handler: 'accounts',
    arguments: 'optional',
    aliases: [],
    title: 'Manage Accounts',
    description: 'Manage connected provider accounts, switch active account, or log out',
    category: 'Providers & Models',
  },
];

export interface ParsedSlashCommand {
  definition?: SlashCommandDef;
  args: string;
  input: string;
  error?: string;
}
export function parseSlashCommand(raw: string): ParsedSlashCommand {
  const input = raw.trim();
  const lower = input.toLowerCase();
  const entries = [...SLASH_COMMANDS, ...LEGACY_COMMANDS]
    .flatMap(definition => [definition.command, ...definition.aliases].map(name => ({name, definition})))
    .sort((a, b) => b.name.length - a.name.length);
  const entry = entries.find(({name}) => lower === name || lower.startsWith(name + ' '));
  if (!entry)
    return {
      args: '',
      input,
      error:
        lower === '/usege'
          ? 'Unknown command /usege. Use /usage.'
          : `Unknown slash command "${input}". Type /help for commands.`,
    };
  const args = input.slice(entry.name.length).trim();
  if ((args && !entry.definition.arguments) || (!args && entry.definition.arguments === 'required'))
    return {
      definition: entry.definition,
      args,
      input,
      error: `Usage: ${entry.definition.command}${entry.definition.arguments ? ' <value>' : ''}`,
    };
  return {definition: entry.definition, args, input: entry.definition.command + (args ? ' ' + args : '')};
}

/** Match command-menu separators the same way Claude Code does. */
export function normalizeSlashCommandName(value: string): string {
  return value.toLowerCase().replace(/^\//, '').replace(/[-_:]/g, '');
}

/** Enter accepts a literal command prefix; explicit arguments and unknown
 * subcommands are parsed as typed rather than being replaced by fuzzy matches. */
export function acceptSlashSelection(input: string, chosen?: SlashCommandDef): string {
  const raw = input.trim();
  if (!chosen) return raw;
  const query = normalizeSlashCommandName(raw);
  const prefix = [chosen.command, ...chosen.aliases].some(name => {
    const normalized = normalizeSlashCommandName(name);
    return normalized.startsWith(query);
  });
  return prefix ? chosen.command : raw;
}

/** Canonical shortcut lookup used by the application, with no second command table. */
export function commandForShortcut(key: string): SlashCommandDef | undefined {
  return SLASH_COMMANDS.find(command => command.shortcut === key);
}
