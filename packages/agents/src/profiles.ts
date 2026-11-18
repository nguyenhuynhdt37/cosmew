import {
  BUILTIN_SUBAGENT_TYPES,
  SANDBOX_MODE_RANK,
  type HostAgentRoleConfig,
  type SandboxModeSetting,
  type SubagentType,
  type ToolDescriptor,
} from '@futryn/contracts';

export interface AgentProfile {
  id: SubagentType;
  name: string;
  aliases: readonly string[];
  description: string;
  developerInstructions: string;
  /** True when the role may only inspect and never mutate workspace files. */
  readOnly: boolean;
  /** Upper bound on the sandbox mode this role may run under (can only narrow the parent's sandbox). */
  maxSandboxMode: SandboxModeSetting;
  /** Whether commands may escalate out of the sandbox (`require_escalated`) when parent policy allows. */
  allowEscalation: boolean;
  /** Whether commands may use pre-configured or granted sandbox network. */
  allowNetworkInSandbox: boolean;
  /** Explicit allowlist of tools; undefined means all parent tools except `forbiddenTools`. */
  allowedTools?: readonly string[];
  /** Tools always withheld from this role regardless of parent tools. */
  forbiddenTools: readonly string[];
  model?: string;
  reasoningEffort?: string;
}

const EXPLORE_TOOLS = ['read', 'glob', 'grep', 'lsp', 'web_search', 'web_fetch', 'skill', 'exec_command'] as const;

const PLAN_TOOLS = ['read', 'glob', 'grep', 'lsp', 'web_search', 'web_fetch', 'skill', 'update_plan'] as const;

export const BUILTIN_PROFILES: Record<SubagentType, AgentProfile> = {
  explore: {
    id: 'explore',
    name: 'Explore',
    aliases: ['explorer'],
    description:
      'Read-only codebase explorer for specific, well-scoped questions (file discovery, keyword/symbol searches, call flows). Spawn multiple explore agents in parallel when you have independent questions, and trust their findings without repeating the same search.',
    developerInstructions: [
      'You are an explore subagent specialized in fast, authoritative codebase navigation and analysis.',
      'Rules:',
      '- Your role is strictly read-only: search, read, inspect symbols, and answer the assigned question.',
      '- Issue independent read/grep/glob/lsp calls in parallel whenever possible.',
      '- Shell commands (exec_command) run in a read-only sandbox; never attempt to create, edit, delete, move, or copy files, including temporary files.',
      '- Cite concrete workspace-relative file paths and line numbers in your final summary.',
    ].join('\n'),
    readOnly: true,
    maxSandboxMode: 'read-only',
    allowEscalation: false,
    allowNetworkInSandbox: false,
    allowedTools: EXPLORE_TOOLS,
    forbiddenTools: [
      'edit',
      'write',
      'apply_patch',
      'lsp_rename',
      'memory',
      'update_plan',
      'request_permissions',
      'request_user_input',
      'agent',
    ],
  },
  worker: {
    id: 'worker',
    name: 'Worker',
    aliases: [],
    description:
      'Execution agent for bounded code changes, bug fixes, test repairs, or disjoint refactor slices. Assign explicit file/module ownership and remind the worker that it is not alone in the codebase and must not revert edits made by others.',
    developerInstructions: [
      'You are a worker subagent responsible for implementing a concrete, bounded engineering task.',
      'Rules:',
      '- Respect the file and module ownership assigned in your prompt; keep changes focused on your scope.',
      '- You are NOT alone in the codebase: other agents or the user may be editing concurrently. Never revert or overwrite unfamiliar changes outside your scope; adapt your implementation to coexist cleanly.',
      '- Verify your changes with the available tools and list all modified file paths in your final response.',
    ].join('\n'),
    readOnly: false,
    maxSandboxMode: 'danger-full-access',
    allowEscalation: true,
    allowNetworkInSandbox: true,
    forbiddenTools: ['request_user_input', 'memory'],
  },
  general: {
    id: 'general',
    name: 'General',
    aliases: ['default'],
    description:
      'General-purpose subagent for researching complex questions and executing multi-step tasks autonomously. Use it to run independent units of work in parallel.',
    developerInstructions: [
      'You are a general-purpose subagent executing a delegated multi-step task.',
      'Rules:',
      '- Complete the assigned task end-to-end using the offered tools and verify observable outcomes.',
      '- You cannot ask the user questions directly; if a minor detail is ambiguous, make the safest reasonable choice and state your assumption.',
      '- Return a concise, evidence-backed summary of what you found or changed.',
    ].join('\n'),
    readOnly: false,
    maxSandboxMode: 'danger-full-access',
    allowEscalation: true,
    allowNetworkInSandbox: true,
    forbiddenTools: ['request_user_input', 'memory'],
  },
  plan: {
    id: 'plan',
    name: 'Plan',
    aliases: [],
    description:
      'Read-only planning subagent that inspects relevant files and symbols and returns a structured, step-by-step implementation plan with affected files, risks, and verification steps.',
    developerInstructions: [
      'You are a read-only planning subagent (Plan mode).',
      'Rules:',
      '- Inspect only the files and symbols needed to design an accurate plan. Never modify files or execute shell commands.',
      '- Return a structured, actionable plan containing: objective, ordered implementation steps, affected files/modules, edge cases or risks, and verification commands/tests.',
    ].join('\n'),
    readOnly: true,
    maxSandboxMode: 'read-only',
    allowEscalation: false,
    allowNetworkInSandbox: false,
    allowedTools: PLAN_TOOLS,
    forbiddenTools: [
      'edit',
      'write',
      'apply_patch',
      'lsp_rename',
      'exec_command',
      'write_stdin',
      'memory',
      'request_permissions',
      'request_user_input',
      'agent',
    ],
  },
};

export const BUILTIN_AGENT_PROFILES = BUILTIN_PROFILES;

export function listBuiltinAgentProfiles(roleOverrides: Record<string, HostAgentRoleConfig> = {}): AgentProfile[] {
  return BUILTIN_SUBAGENT_TYPES.map(type => resolveAgentProfile(type, roleOverrides)!);
}

export function resolveAgentProfile(
  agentType: string,
  roleOverrides: Record<string, HostAgentRoleConfig> = {},
): AgentProfile | undefined {
  const normalized = agentType.trim().toLowerCase();
  if (!normalized) return undefined;
  const match = (Object.values(BUILTIN_PROFILES) as AgentProfile[]).find(
    profile => profile.id === normalized || profile.aliases.includes(normalized),
  );
  if (!match) return undefined;
  const override = roleOverrides[match.id] ?? roleOverrides[normalized];
  if (!override) return {...match};
  return {
    ...match,
    ...(override.description?.trim() ? {description: override.description.trim()} : {}),
    ...(override.developerInstructions?.trim()
      ? {developerInstructions: `${match.developerInstructions}\n\n${override.developerInstructions.trim()}`}
      : {}),
    ...(override.model?.trim() ? {model: override.model.trim()} : {}),
    ...(override.reasoningEffort?.trim() ? {reasoningEffort: override.reasoningEffort.trim()} : {}),
  };
}

/**
 * Compute the effective sandbox mode for a subagent: a role can only narrow the parent's sandbox,
 * never widen it (e.g. a `worker` under a `read-only` parent stays `read-only`; an `explore`
 * under `workspace-write` or `danger-full-access` is narrowed to `read-only`).
 */
export function effectiveSubagentSandbox(
  parent: {mode: SandboxModeSetting; escalation: 'on-request' | 'never'; network: boolean},
  profile: AgentProfile,
): {mode: SandboxModeSetting; escalation: 'on-request' | 'never'; network: boolean} {
  const mode =
    SANDBOX_MODE_RANK[profile.maxSandboxMode] < SANDBOX_MODE_RANK[parent.mode] ? profile.maxSandboxMode : parent.mode;
  const escalation =
    parent.escalation === 'never' || !profile.allowEscalation || mode === 'read-only' ? 'never' : 'on-request';
  const network = parent.network && profile.allowNetworkInSandbox && mode === 'workspace-write';
  return {mode, escalation, network};
}

/**
 * Filter the parent's offered tool descriptors for a subagent. A subagent toolset can only narrow
 * the parent's tools: it never adds a tool the parent lacks, never exposes `request_user_input` or
 * `memory`, and withholds `agent` whenever `depth >= maxDepth` or the profile forbids it.
 */
export function filterSubagentTools(
  parentDescriptors: readonly ToolDescriptor[],
  profile: AgentProfile,
  options: {depth: number; maxDepth: number; parentAnalysisOnly?: boolean},
): ToolDescriptor[] {
  const allowSet = profile.allowedTools ? new Set(profile.allowedTools) : null;
  const forbidSet = new Set(profile.forbiddenTools);
  forbidSet.add('request_user_input');
  forbidSet.add('memory');
  if (options.depth >= options.maxDepth || profile.readOnly) forbidSet.add('agent');
  if (options.parentAnalysisOnly || profile.readOnly) {
    for (const writeTool of ['edit', 'write', 'apply_patch', 'lsp_rename', 'request_permissions']) {
      forbidSet.add(writeTool);
    }
    if (options.parentAnalysisOnly) {
      forbidSet.add('exec_command');
      forbidSet.add('write_stdin');
    }
  }
  return parentDescriptors.filter(descriptor => {
    if (forbidSet.has(descriptor.name)) return false;
    if (allowSet && !allowSet.has(descriptor.name)) return false;
    return true;
  });
}

export function isToolAllowedForProfile(
  toolName: string,
  profile: AgentProfile,
  options: {depth: number; maxDepth: number; parentAnalysisOnly?: boolean},
): boolean {
  if (toolName === 'request_user_input' || toolName === 'memory') return false;
  if (
    toolName === 'agent' &&
    (options.depth >= options.maxDepth || profile.readOnly || profile.forbiddenTools.includes('agent'))
  ) {
    return false;
  }
  if (profile.forbiddenTools.includes(toolName)) return false;
  if (profile.allowedTools && !profile.allowedTools.includes(toolName)) return false;
  if (options.parentAnalysisOnly || profile.readOnly) {
    if (['edit', 'write', 'apply_patch', 'lsp_rename', 'request_permissions'].includes(toolName)) return false;
    if (options.parentAnalysisOnly && (toolName === 'exec_command' || toolName === 'write_stdin')) return false;
  }
  return true;
}

/**
 * Build the `agent` tool description (kept under 2000 characters to satisfy `requestSchema`).
 */
export function buildAgentToolDescription(roleOverrides: Record<string, HostAgentRoleConfig> = {}): string {
  const roles = listBuiltinAgentProfiles(roleOverrides)
    .map(role => {
      const pinned = [
        role.model ? `model=${role.model}` : '',
        role.reasoningEffort ? `effort=${role.reasoningEffort}` : '',
      ]
        .filter(Boolean)
        .join(', ');
      return `- ${role.id}: ${role.description}${pinned ? ` (${pinned})` : ''}`;
    })
    .join('\n');
  const text = [
    'Spawn a subagent in an isolated child conversation for a well-scoped task and return its final summary.',
    'Issue multiple `agent` calls in the same response to run independent subtasks in parallel.',
    'Omit `model` and `reasoning_effort` unless the user explicitly asks for an override. Set `fork_context: true` only when the child needs the parent conversation history; otherwise pass all required context in `prompt`.',
    'Available agent_type values:',
    roles,
  ].join('\n');
  return text.slice(0, 1950);
}
