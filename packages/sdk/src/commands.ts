export interface SlashCommandDef {
  command: string;
  aliases: string[];
  title: string;
  description: string;
  category: 'Navigation' | 'Appearance' | 'Providers & Models' | 'Sessions' | 'Workspace & Security';
  shortcut?: string;
  arguments?: 'optional' | 'required';
  duringRequest?: boolean;
  unavailable?: string;
}

export const SLASH_COMMANDS: readonly SlashCommandDef[] = [
  { command: '/usage', aliases: ['/cost', '/stats'], title: 'Usage & Estimated Cost', description: 'Per-turn and session usage with coverage and pricing provenance', category: 'Navigation', duringRequest: true },
  { command: '/context', aliases: [], title: 'Context Window', description: 'Model limits, output reserve, measured or estimated context', category: 'Navigation', duringRequest: true },
  { command: '/effort', aliases: ['/model effort'], title: 'Reasoning Effort', description: 'Set an effort advertised by the active provider/model', category: 'Providers & Models', arguments: 'optional' },
  {
    command: '/theme', duringRequest: true,
    aliases: ['/themes'],
    title: 'Theme Picker',
    description: 'Choose Auto, Dark, or Light',
    category: 'Appearance',
    shortcut: 'Ctrl+T',
  },
  {
    command: '/model', arguments: 'optional',
    aliases: ['/models'],
    title: 'Select Model',
    description: 'Search and select active model from discovered or cached provider catalog',
    category: 'Providers & Models',
    shortcut: 'Ctrl+L',
  },
  {
    command: '/login', arguments: 'optional',
    aliases: ['/connect'],
    title: 'Connect Provider Account',
    description: 'Connect providers with supported browser/device sign-in, API keys or custom endpoints',
    category: 'Providers & Models',
  },
  {
    command: '/logout', arguments: 'optional', aliases: [], title: 'Sign Out',
    description: 'Confirm sign-out of a named account and delete its local credential', category: 'Providers & Models',
  },
  { command: '/switch', aliases: ['/account'], title: 'Switch Account', description: 'Use another connected account; the chat continues in a new session', category: 'Providers & Models', arguments: 'optional' },
  {
    command: '/doctor', aliases: [], title: 'Diagnose Connection',
    description: 'Validate active provider connectivity and runtime configuration', category: 'Providers & Models',
  },
  {
    command: '/mcp', unavailable: 'Not implemented: MCP integration.', aliases: [], title: 'MCP Management',
    description: 'Not implemented in PA1/TUI1; MCP authentication is separate', category: 'Workspace & Security',
  },
  {
    command: '/plugin', unavailable: 'Not implemented: plugin host.', aliases: ['/plugins'], title: 'Plugin Management',
    description: 'Not implemented in PA1/TUI1; no plugin host is enabled', category: 'Workspace & Security',
  },
  {
    command: '/compact', unavailable: 'Not implemented: context compaction backend. Use /clear or /resume.', aliases: [], title: 'Compact Context',
    description: 'Not implemented: summarization and provenance backend unavailable', category: 'Sessions',
  },
  {
    command: '/resume', arguments: 'optional',
    aliases: ['/sessions', '/continue'],
    title: 'Session Picker',
    description: 'Browse, search, resume, or delete saved conversation sessions',
    category: 'Sessions',
    shortcut: 'Ctrl+S',
  },
  {
    command: '/permissions',
    aliases: ['/perm'],
    title: 'Permission Requests',
    description: 'Inspect and resolve pending security permission prompts (Allow once / Session / Deny)',
    category: 'Workspace & Security',
  },
  {
    command: '/diff',
    aliases: [],
    title: 'Workspace Diff Viewer',
    description: 'Inspect git working tree changes with syntax-colored unified diff hunks',
    category: 'Workspace & Security',
    shortcut: 'Ctrl+D',
  },
  {
    command: '/config',
    aliases: ['/settings'],
    title: 'Appearance & TUI Settings',
    description: 'Configure Auto/Dark/Light appearance, motion, and sidebar',
    category: 'Appearance',
  },
  {
    command: '/status', duringRequest: true,
    aliases: [],
    title: 'System & Provider Status',
    description: 'View active provider, account, model, session stats, and backend capabilities',
    category: 'Navigation',
  },
  {
    command: '/clear',
    aliases: ['/new', '/reset'],
    title: 'Clear Conversation',
    description: 'Start a fresh conversation; previous sessions remain available via /resume',
    category: 'Sessions',
  },
  {
    command: '/help', duringRequest: true,
    aliases: ['/?'],
    title: 'Keyboard & Command Help',
    description: 'Show all FUTRYN keyboard shortcuts, slash commands, and navigation rules',
    category: 'Navigation',
  },
  {
    command: '/exit',
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
  { command: '/theme set', aliases: ['/themes set'], title: 'Legacy Theme Command', description: 'Use /theme', category: 'Appearance', arguments: 'optional', unavailable: 'Use /theme to choose Auto, Dark, or Light.' },
  {
    command: '/theme edit',
    aliases: ['/editor', '/customize'],
    title: 'Theme Editor',
    description: 'Custom theme editing is unavailable',
    unavailable: 'Custom themes are unavailable. Use /theme to choose Auto, Dark, or Light.',
    category: 'Appearance',
  },
  {
    command: '/accounts', arguments: 'optional',
    aliases: [],
    title: 'Manage Accounts',
    description: 'Manage connected provider accounts, switch active account, or log out',
    category: 'Providers & Models',
  },
];


export interface ParsedSlashCommand { definition?: SlashCommandDef; args: string; input: string; error?: string }
export function parseSlashCommand(raw: string): ParsedSlashCommand {
  const input = raw.trim(); const lower = input.toLowerCase();
  const entries = [...SLASH_COMMANDS, ...LEGACY_COMMANDS].flatMap(definition => [definition.command, ...definition.aliases].map(name => ({name, definition})))
    .sort((a, b) => b.name.length - a.name.length);
  const entry = entries.find(({name}) => lower === name || lower.startsWith(name + ' '));
  if (!entry) return { args: '', input, error: lower === '/usege' ? 'Unknown command /usege. Use /usage.' : `Unknown slash command "${input}". Type /help for commands.` };
  const args = input.slice(entry.name.length).trim();
  if ((args && !entry.definition.arguments) || (!args && entry.definition.arguments === 'required')) return { definition: entry.definition, args, input, error: `Usage: ${entry.definition.command}${entry.definition.arguments ? ' <value>' : ''}` };
  return { definition: entry.definition, args, input: entry.definition.command + (args ? ' ' + args : '') };
}

/** Enter accepts a literal command prefix; explicit arguments and unknown
 * subcommands are parsed as typed rather than being replaced by fuzzy matches. */
export function acceptSlashSelection(input: string, chosen?: SlashCommandDef): string {
  const raw = input.trim(); if (!chosen) return raw;
  const prefix = [chosen.command, ...chosen.aliases].some(name => name.toLowerCase().startsWith(raw.toLowerCase()));
  return prefix || (!/\s/.test(raw) && !parseSlashCommand(raw).definition) ? chosen.command : raw;
}
