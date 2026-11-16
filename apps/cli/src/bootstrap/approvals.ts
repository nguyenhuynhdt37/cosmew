import type {ApprovalRequest} from '@futryn/tools';
import type {WorkspaceRoot} from '@futryn/workspace';
import type {FutrynClient} from '@futryn/sdk';

/**
 * How tool permission requests are shown to the user. The decision itself is made by
 * the client's permission dialog, project rules and permission mode (ADR 0027/0028).
 */

type PermissionInput = Parameters<FutrynClient['requestPermission']>[0];

/** Why an action needs approval, in words the permission dialog can show. */
const APPROVAL_REASONS: Record<string, string> = {
  'secret-file': 'This file usually holds secrets (keys, passwords, tokens).',
  'process-execute':
    'Runs a shell command in the Futryn sandbox: workspace policy enforced, .git read-only, configured secret-file policy, no network.',
  'network-escalation':
    'Runs a shell command in the Futryn sandbox WITH network access. It can send project files anywhere.',
  'stdin-policy-drift': 'Sends input to a running command that was launched under a different sandbox mode.',
  'stdin-retained-escalation': 'Sends input to a running command that still has network access.',
  'stdin-input':
    'Sends input to a running command; for a shell or REPL this runs new commands. "Allow for session" covers this session only.',
};

const reasonText = (reason: string) => APPROVAL_REASONS[reason] ?? reason;

/** The dialog request for a Futryn tool call (read of a secret, patch, command or terminal input). */
export function toolPermissionRequest(request: ApprovalRequest): PermissionInput {
  if (request.capability === 'fs.write') {
    return {
      capability: 'fs.write',
      action: 'Apply verified workspace patch',
      target: request.target,
      reason: 'Review the exact file changes before applying.',
      riskLevel: 'high',
      scopeKey: request.scopeKey,
      diffPreview: request.diffPreview,
    };
  }
  if (request.capability === 'process.execute') {
    // The action names directory and sandbox, so a "session" answer is bound to all three.
    // Network escalation is its own capability, so Bash allow rules and auto mode never approve it.
    const justification = request.justification ? ` Model's reason: ${request.justification}` : '';
    return {
      capability: request.network ? 'network.connect' : request.capability,
      ...(request.network ? {kind: 'network' as const, ruleTarget: null} : {}),
      action: `Run in ${(request.workdir ?? '.').slice(0, 80)} · ${request.sandbox ?? 'sandbox'}`,
      target: request.target,
      reason: reasonText(request.reason) + justification,
      riskLevel: 'high',
      scopeKey: request.scopeKey,
    };
  }
  return {
    capability: request.capability,
    action: `${request.tool} ${request.target}`,
    target: request.target,
    reason: reasonText(request.reason),
    riskLevel: 'medium',
  };
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
