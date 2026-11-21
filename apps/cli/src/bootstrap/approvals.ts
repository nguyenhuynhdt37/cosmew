import {
  isSafeAlwaysRule,
  suggestPermissionRule,
  type PermissionRuleTool,
  type SubagentPromptAttribution,
} from '@cosmew/contracts';
import {APPROVAL_KIND_FOR_REASON} from '@cosmew/security';
import type {ApprovalRequest} from '@cosmew/tools';
import type {WorkspaceRoot} from '@cosmew/workspace';
import type {FutrynClient} from '@cosmew/sdk';

/**
 * How tool and runtime permission requests are shown to the user. The decision itself is made by
 * the client's permission dialog, project rules and permission mode (ADR 0027/0028).
 */

type PermissionInput = Parameters<FutrynClient['requestPermission']>[0];

/** Why an action needs approval, in words the permission dialog can show. */
const APPROVAL_REASONS: Record<string, string> = {
  'secret-file': 'This file usually holds secrets (keys, passwords, tokens).',
  'project-read-rule': 'A read rule requires approval before opening this path.',
  'web-fetch': 'Fetches a public web page or document from this origin. Page contents are untrusted data.',
  'sandboxed-command':
    'Runs a shell command in the Cosmew sandbox: writes only in the working directory, .git read-only, credential locations hidden, network only through the domain-filtering proxy.',
  'process-execute':
    'Runs a shell command in the Cosmew sandbox (sandbox.autoAllowBashIfSandboxed is off): writes only in the working directory, network only through the proxy.',
  'unsandboxed-session':
    'The sandbox is disabled in settings: this command runs with your full user permissions (any file, any network).',
  'excluded-command':
    'This command matches sandbox.excludedCommands: it runs WITHOUT the sandbox, with your full user permissions.',
  'unsandboxed-escalation':
    'WITHOUT THE SANDBOX: this command would run with your full user permissions (any file, any network). Approve only if you trust the command and reason. "For session" remembers exactly this command in this directory.',
  'outside-writable-roots': 'This file is outside the writable directories of the sandbox.',
  'stdin-unsandboxed': 'Sends input to a running command that was launched without the sandbox.',
  'stdin-sandboxed': "Sends input to a running command inside the command's launch sandbox.",
  'stdin-process':
    'Sends input to a running command inside its launch sandbox (sandbox.autoAllowBashIfSandboxed is off).',
};

const reasonText = (reason: string) => APPROVAL_REASONS[reason] ?? reason;

type Offer = Pick<PermissionInput, 'decisions' | 'alwaysRule'>;
/**
 * The approvals a prompt offers (ADR 0055, Codex `available_decisions`): once and session always;
 * `always` only when a project Allow rule can stand for the request (Codex: an execpolicy amendment).
 */
function offer(rule: string | null): Offer {
  return rule ? {decisions: ['once', 'session', 'always'], alwaysRule: rule} : {decisions: ['once', 'session']};
}

function withAlwaysRule(reason: string, rule: string | null): string {
  if (!rule) return reason.slice(0, 400);
  const note = ` "Always" saves ${rule} for this project.`;
  return reason.slice(0, Math.max(0, 400 - note.length)) + note;
}

/** A command prompt's `always` rule: only for exactly one parsed sub-command; an unparsed script never matches an allow rule. */
function commandRule(tool: PermissionRuleTool, request: ApprovalRequest): string | null {
  if (!request.commands || request.commands.length !== 1) return null;
  const rule = suggestPermissionRule({
    tool,
    target: request.commands[0]!,
    // Commands that leave the sandbox and dangerous commands are never generalized to a prefix.
    exact: Boolean(request.unsandboxed) || Boolean(request.excluded) || Boolean(request.dangerous),
  });
  return rule &&
    isSafeAlwaysRule(rule, {
      tool,
      target: request.target,
      segments: request.commands,
    })
    ? rule
    : null;
}

/** The dialog request for a Cosmew tool call (read of a secret, patch, command or terminal input). */
export function toolPermissionRequest(request: ApprovalRequest, subagent?: SubagentPromptAttribution): PermissionInput {
  const withSubagent = (input: PermissionInput): PermissionInput => (subagent ? {...input, subagent} : input);
  // One approval table for every tool (ADR 0040): the policy reason names the permission kind.
  const kind = APPROVAL_KIND_FOR_REASON[request.reason];
  if (request.reason === 'tool-output-read')
    return withSubagent({
      capability: 'fs.read',
      kind: 'read',
      ruleTool: 'Tool',
      ruleTarget: 'tool_output',
      action: 'Read archived tool evidence',
      target: 'tool_output',
      reason: 'Retrieves captured evidence without repeating execution.',
      riskLevel: 'low',
    });
  if (request.capability === 'agent.state.write')
    return withSubagent({
      capability: request.capability,
      kind: 'edit',
      ruleTool: 'Tool',
      ruleTarget: request.target,
      action: 'Edit project memory',
      target: request.target,
      reason: 'Saves or deletes durable agent state for this project.',
      riskLevel: 'medium',
      ...offer(null),
    });
  if (request.capability === 'mcp.call') {
    const rule = isSafeAlwaysRule(request.target) ? request.target : null;
    return withSubagent({
      capability: 'mcp.call',
      kind: 'other',
      ruleTool: 'Mcp',
      ruleTarget: request.target,
      action: `Call ${request.target}`.slice(0, 200),
      target: request.target,
      reason: 'Calls a tool on a user-configured MCP server. The result is untrusted data.',
      riskLevel: 'medium',
      scopeKey: request.scopeKey,
      ...offer(rule),
    });
  }
  if (request.capability === 'network.search')
    return withSubagent({
      capability: 'network.search',
      kind: 'read',
      ruleTool: 'WebSearch',
      ruleTarget: 'web_search',
      action: 'Search the public web',
      target: request.target,
      reason: 'Sends the query to the configured search provider.',
      scopeKey: request.scopeKey,
      riskLevel: 'low',
    });
  if (request.capability === 'fs.write') {
    const rule = suggestPermissionRule({tool: 'Edit', target: request.target});
    return withSubagent({
      capability: 'fs.write',
      ...(kind ? {kind} : {}),
      action: 'Apply verified workspace patch',
      target: request.target,
      reason: withAlwaysRule(
        request.reason === 'outside-writable-roots'
          ? reasonText(request.reason)
          : 'Review the exact file changes before applying.',
        rule,
      ),
      riskLevel: 'high',
      scopeKey: request.scopeKey,
      diffPreview: request.diffPreview,
      ...offer(rule),
    });
  }
  if (request.capability === 'process.execute') {
    // The action names directory and sandbox, so a "session" answer is bound to all three.
    const justification = request.justification
      ? ` Model's reason: ${request.justification}`
      : request.unsandboxed
        ? ' The model gave no reason.'
        : '';
    // An escape from the sandbox is never answered by an Allow rule and never saved as one.
    const rule = request.unsandboxed ? null : commandRule('Bash', request);
    return withSubagent({
      capability: request.capability,
      ...(kind ? {kind} : {}),
      // Rules judge Codex's parsed sub-commands; an unparsed script never matches an allow rule.
      ...(request.commands !== undefined ? {ruleSegments: request.commands} : {}),
      ruleTool: 'Bash',
      ...(request.unsandboxed ? {ignoreAllowRules: true} : {}),
      action: request.unsandboxed
        ? `Run WITHOUT SANDBOX in ${(request.workdir ?? '.').slice(0, 60)}`
        : `Run in ${(request.workdir ?? '.').slice(0, 80)} · ${request.sandbox ?? 'sandbox'}`,
      target: request.target,
      reason: withAlwaysRule(reasonText(request.reason) + justification, rule),
      riskLevel: request.unsandboxed || request.excluded ? 'high' : 'medium',
      scopeKey: request.scopeKey,
      ...offer(rule),
    });
  }
  const rule =
    request.capability === 'fs.read'
      ? suggestPermissionRule({tool: 'Read', target: request.target})
      : request.capability === 'network.connect'
        ? suggestPermissionRule({tool: 'WebFetch', target: request.target})
        : null;
  return withSubagent({
    capability: request.capability,
    action: `${request.tool} ${request.target}`,
    target: request.target,
    reason: withAlwaysRule(reasonText(request.reason), rule),
    riskLevel: 'medium',
    ...offer(rule),
  });
}

/** How a session grant is listed in `/permissions`. */
export function grantLabel(grant: {capability: string; target: string}, workspace: WorkspaceRoot): string {
  if (grant.capability === 'process.execute') return commandGrantLabel(grant.target, workspace);
  if (grant.capability === 'fs.write') return 'Exact patch ' + grant.target.slice(6, 18);
  return workspace.relativeOf(grant.target);
}

/** `$ cmd` (plus `in dir` when not the root) for a session command grant. */
function commandGrantLabel(target: string, workspace: WorkspaceRoot): string {
  try {
    const {exec, cwd} = JSON.parse(target) as {exec: string; cwd: string};
    const dir = workspace.relativeOf(cwd);
    return `$ ${exec}${dir === '.' ? '' : ` (in ${dir})`}`;
  } catch {
    return '$ (command)';
  }
}
