import {isSafeAlwaysRule, suggestPermissionRule, type PermissionRuleTool} from '@futryn/contracts';
import {APPROVAL_KIND_FOR_REASON} from '@futryn/security';
import type {ApprovalRequest} from '@futryn/tools';
import type {WorkspaceRoot} from '@futryn/workspace';
import type {FutrynClient} from '@futryn/sdk';

/**
 * How tool and runtime permission requests are shown to the user. The decision itself is made by
 * the client's permission dialog, project rules and permission mode (ADR 0027/0028).
 */

type PermissionInput = Parameters<FutrynClient['requestPermission']>[0];

/** Why an action needs approval, in words the permission dialog can show. */
const APPROVAL_REASONS: Record<string, string> = {
  'secret-file': 'This file usually holds secrets (keys, passwords, tokens).',
  'project-read-rule': 'Project read rules require approval before opening this path.',
  'web-fetch': 'Fetches a public web page or document from this origin. Page contents are untrusted data.',
  'process-execute':
    'Runs a shell command in the Futryn sandbox: workspace policy enforced, .git read-only, localhost only, no external network.',
  'network-escalation':
    'Runs a shell command in the Futryn sandbox WITH network access. It can send project files anywhere.',
  'dangerous-command':
    'This command is on the dangerous list (forced rm, also through sudo/env/sh -c). It runs in the Futryn sandbox if approved.',
  'unverified-command':
    'The command contains complex shell syntax Futryn cannot split into simple commands. It still runs inside the sandbox (this prompt appears only under the untrusted policy).',
  'shell-parser-unavailable':
    'Futryn could not load its shell parser, so it cannot check this command. It still runs inside the sandbox.',
  'unsandboxed-escalation':
    'WITHOUT THE SANDBOX: this command would run with your full user permissions (any file, any network). Approve only if you trust the command and reason. "For session" remembers exactly this command in this directory.',
  'outside-writable-roots':
    'The session sandbox is read-only here: approving lets Futryn write this file anyway (workspace policy still applies).',
  'request-permissions':
    'The model asks for more than the sandbox allows. "Allow once" grants it for the rest of this turn, "for session" until the session ends.',
  'stdin-policy-drift': 'Sends input to a running command that was launched under a different sandbox mode.',
  'stdin-retained-escalation': 'Sends input to a running command that still has network access.',
  'stdin-input-approval-required':
    'Sends input to a running command (untrusted policy); a shell or REPL runs it inside the command\'s launch sandbox. "Allow for session" covers this session only.',
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
    // Unsandboxed escalations (`require_escalated`) and dangerous commands are never generalized to a prefix.
    exact:
      tool === 'Unsandboxed' ||
      Boolean(request.unsandboxed) ||
      Boolean(request.dangerous) ||
      request.reason === 'dangerous-command',
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

/** The dialog request for a Futryn tool call (read of a secret, patch, command or terminal input). */
export function toolPermissionRequest(request: ApprovalRequest): PermissionInput {
  // One approval table for every tool (ADR 0040): the policy reason names the permission kind.
  const kind = APPROVAL_KIND_FOR_REASON[request.reason];
  if (request.capability === 'network.search')
    return {
      capability: 'network.search',
      kind: 'read',
      ruleTarget: 'web_search',
      action: 'Search the public web',
      target: request.target,
      reason: 'Sends the query to the configured search provider.',
      scopeKey: request.scopeKey,
      riskLevel: 'low',
    };
  if (request.tool === 'request_permissions') {
    const justification = request.justification ? ` Model's reason: ${request.justification}` : '';
    return {
      capability: request.capability === 'network.connect' ? 'network.connect' : 'fs.write',
      kind: 'escalation',
      // Display-only: no Allow rule can pre-approve a sandbox escalation.
      ruleTarget: null,
      action: 'Grant additional permissions',
      target: request.target,
      reason: reasonText(request.reason) + justification,
      riskLevel: 'high',
      scopeKey: request.scopeKey,
      // Codex offers a turn grant and a session grant only; nothing persists.
      ...offer(null),
    };
  }
  if (request.capability === 'fs.write') {
    const rule = suggestPermissionRule({tool: 'Edit', target: request.target});
    return {
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
    };
  }
  if (request.capability === 'process.execute') {
    // The action names directory and sandbox, so a "session" answer is bound to all three.
    // Network escalation is its own capability, so Bash allow rules and auto mode never approve it.
    const justification = request.justification
      ? ` Model's reason: ${request.justification}`
      : request.unsandboxed
        ? ' The model gave no reason.'
        : '';
    const tool: PermissionRuleTool = request.network ? 'Network' : request.unsandboxed ? 'Unsandboxed' : 'Bash';
    const rule = commandRule(tool, request);
    return {
      capability: request.network ? 'network.connect' : request.capability,
      ...(request.network
        ? {kind: 'network' as const}
        : request.unsandboxed
          ? {kind: 'escalation' as const}
          : kind
            ? {kind}
            : {}),
      // Project rules judge Codex's parsed sub-commands; an unparsed script never matches an allow rule.
      // Network and unsandboxed runs are allowed only by their own rule tool (`Network`, `Unsandboxed`).
      ...(request.commands !== undefined ? {ruleSegments: request.commands} : {}),
      ruleTool: tool,
      action: request.unsandboxed
        ? `Run WITHOUT SANDBOX in ${(request.workdir ?? '.').slice(0, 60)}`
        : `Run in ${(request.workdir ?? '.').slice(0, 80)} · ${request.sandbox ?? 'sandbox'}`,
      target: request.target,
      reason: withAlwaysRule(reasonText(request.reason) + justification, rule),
      riskLevel: 'high',
      scopeKey: request.scopeKey,
      ...offer(rule),
    };
  }
  const rule =
    request.capability === 'fs.read'
      ? suggestPermissionRule({tool: 'Read', target: request.target})
      : request.capability === 'network.connect'
        ? suggestPermissionRule({tool: 'WebFetch', target: request.target})
        : null;
  return {
    capability: request.capability,
    action: `${request.tool} ${request.target}`,
    target: request.target,
    reason: withAlwaysRule(reasonText(request.reason), rule),
    riskLevel: 'medium',
    ...offer(rule),
  };
}

/** How a session grant is listed in `/permissions`. */
export function grantLabel(grant: {capability: string; target: string}, workspace: WorkspaceRoot): string {
  if (grant.capability === 'process.execute') return commandGrantLabel(grant.target, workspace);
  if (grant.capability === 'fs.write') return 'Exact patch ' + grant.target.slice(6, 18);
  if (grant.capability === 'sandbox.grant') {
    try {
      const parsed = JSON.parse(grant.target) as {grant: string; scope: string; path?: string};
      const scope = parsed.scope === 'session' ? 'session' : 'this turn';
      return parsed.grant === 'network' ? `Network for commands (${scope})` : `Write ${parsed.path} (${scope})`;
    } catch {
      return 'Sandbox grant';
    }
  }
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
