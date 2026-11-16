export type CommandOverlay =
  | 'usage'
  | 'context'
  | 'effort'
  | 'themes'
  | 'models'
  | 'sessions'
  | 'permissions'
  | 'diff'
  | 'settings'
  | 'status'
  | 'help'
  | 'connect';
export type CommandHandler =
  | 'overlay'
  | 'effort'
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
  | 'exit'
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

export const SLASH_COMMANDS: readonly SlashCommandDef[] = [
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
    title: 'Context Window',
    description: 'Model limits, output reserve, measured or estimated context',
    category: 'Navigation',
    duringRequest: true,
  },
  {
    command: '/effort',
    handler: 'effort',
    aliases: ['/model effort'],
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
    shortcut: 'Ctrl+T',
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
    shortcut: 'Ctrl+L',
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
    description: 'Use another connected account; the chat continues in a new session',
    category: 'Providers & Models',
    arguments: 'optional',
  },
  {
    command: '/doctor',
    handler: 'doctor',
    aliases: [],
    title: 'Diagnose Connection',
    description: 'Validate active provider connectivity and runtime configuration',
    category: 'Providers & Models',
  },
  {
    command: '/mcp',
    handler: 'unavailable',
    autocomplete: false,
    unavailable: 'Not implemented: MCP integration. MCP authentication remains separate from provider authentication.',
    aliases: [],
    title: 'MCP Management',
    description: 'Not implemented in PA1/TUI1; MCP authentication is separate',
    category: 'Workspace & Security',
  },
  {
    command: '/plugin',
    handler: 'unavailable',
    autocomplete: false,
    unavailable: 'Not implemented: plugin host.',
    aliases: ['/plugins'],
    title: 'Plugin Management',
    description: 'Not implemented in PA1/TUI1; no plugin host is enabled',
    category: 'Workspace & Security',
  },
  {
    command: '/compact',
    handler: 'unavailable',
    autocomplete: false,
    unavailable:
      'Not implemented: manual compaction. Automatic extractive compaction exists, but no safe manual checkpoint action is exposed by the session backend.',
    aliases: [],
    title: 'Compact Context',
    description: 'Unavailable: automatic compaction exists; manual checkpoint action is not exposed',
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
    shortcut: 'Ctrl+S',
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
    aliases: ['/perm'],
    title: 'Permissions',
    description:
      'Pending prompts; /permissions default|acceptEdits|auto|plan|bypassPermissions sets the mode (Shift+Tab cycles)',
    category: 'Workspace & Security',
  },
  {
    command: '/backend',
    duringRequest: true,
    handler: 'backend',
    arguments: 'optional',
    aliases: [],
    title: 'Execution Backend',
    description: 'Who runs the agent loop and the project tools (always Futryn tools; no runtime delegation)',
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
    shortcut: 'Ctrl+D',
  },
  {
    command: '/config',
    handler: 'overlay',
    overlay: 'settings',
    aliases: ['/settings'],
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
    command: '/review',
    handler: 'mode',
    requires: 'independent',
    aliases: [],
    arguments: 'optional',
    title: 'Review Changes',
    description: 'Review actual workspace changes without modifying files',
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
    shortcut: 'Ctrl+N',
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
    description: 'Show all FUTRYN keyboard shortcuts, slash commands, and navigation rules',
    category: 'Navigation',
  },
  {
    command: '/exit',
    handler: 'exit',
    aliases: ['/quit'],
    title: 'Exit FUTRYN',
    description: 'Restore terminal state cleanly and exit the TUI',
    category: 'Navigation',
    shortcut: 'Ctrl+C',
  },
];

// Legacy FUTRYN-only commands remain parseable for existing users. They are
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
    aliases: ['/editor', '/customize'],
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

/** Enter accepts a literal command prefix; explicit arguments and unknown
 * subcommands are parsed as typed rather than being replaced by fuzzy matches. */
export function acceptSlashSelection(input: string, chosen?: SlashCommandDef): string {
  const raw = input.trim();
  if (!chosen) return raw;
  const prefix = [chosen.command, ...chosen.aliases].some(name => name.toLowerCase().startsWith(raw.toLowerCase()));
  return prefix || (!/\s/.test(raw) && !parseSlashCommand(raw).definition) ? chosen.command : raw;
}

/** Canonical shortcut lookup used by the application, with no second command table. */
export function commandForShortcut(key: string): SlashCommandDef | undefined {
  return SLASH_COMMANDS.find(command => command.shortcut === key);
}
