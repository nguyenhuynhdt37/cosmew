import {APPROVAL_KIND_FOR_REASON} from '@futryn/security';
import type {ApprovalRequest} from '@futryn/tools';
import type {WorkspaceRoot} from '@futryn/workspace';
import type {FutrynClient} from '@futryn/sdk';
import type {RuntimeApprover} from '../subscriptions/host';

/**
 * How tool and runtime permission requests are shown to the user. The decision itself is made by
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
  'dangerous-command':
    'This command is on the dangerous list (forced rm, also through sudo/env/sh -c). It runs in the Futryn sandbox if approved.',
  'unverified-command':
    'Futryn could not verify every sub-command (parse error, $(...) substitution, eval or a dynamic program name). It runs in the Futryn sandbox if approved.',
  'outside-writable-roots':
    'The session sandbox is read-only here: approving lets Futryn write this file anyway (workspace policy still applies).',
  'request-permissions':
    'The model asks for more than the sandbox allows. "Allow once" grants it for the rest of this turn, "for session" until the session ends.',
  'stdin-policy-drift': 'Sends input to a running command that was launched under a different sandbox mode.',
  'stdin-retained-escalation': 'Sends input to a running command that still has network access.',
  'stdin-input':
    'Sends input to a running command; for a shell or REPL this runs new commands. "Allow for session" covers this session only.',
};

const reasonText = (reason: string) => APPROVAL_REASONS[reason] ?? reason;

/** The dialog request for a Futryn tool call (read of a secret, patch, command or terminal input). */
export function toolPermissionRequest(request: ApprovalRequest): PermissionInput {
  // One approval table for every tool (ADR 0040): the policy reason names the permission kind.
  const kind = APPROVAL_KIND_FOR_REASON[request.reason];
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
    };
  }
  if (request.capability === 'fs.write') {
    return {
      capability: 'fs.write',
      ...(kind ? {kind} : {}),
      action: 'Apply verified workspace patch',
      target: request.target,
      reason:
        request.reason === 'outside-writable-roots'
          ? reasonText(request.reason)
          : 'Review the exact file changes before applying.',
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
      ...(request.network ? {kind: 'network' as const, ruleTarget: null} : kind ? {kind} : {}),
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

/** Native runtime tools map onto the same capabilities as Futryn tools (ADR 0027). */
const RUNTIME_CAPABILITY = {
  secret: 'fs.read',
  edit: 'fs.write',
  execute: 'process.execute',
  network: 'network.connect',
  other: 'extension.service',
} as const;

const RUNTIME_ACTION = {
  secret: 'read a sensitive file',
  edit: 'change files',
  execute: 'run a command',
  network: 'use the network',
  other: 'use a tool',
} as const;

/** Native runtime tools ask through the same prompt and permission mode as Futryn tools. */
export function runtimeApprover(client: () => FutrynClient | undefined): RuntimeApprover {
  return async (request, signal) => {
    const current = client();
    if (!current?.toolsEnabled()) return false;
    const decision = await current.requestPermission(
      {
        capability: RUNTIME_CAPABILITY[request.kind],
        kind: request.kind,
        action: `${request.runtime}: ${request.label}`.slice(0, 200),
        target: request.label.slice(0, 1024) || request.kind,
        reason: `The ${request.runtime} runtime wants to ${RUNTIME_ACTION[request.kind]} in this project.`,
        riskLevel: request.kind === 'execute' || request.kind === 'edit' ? 'high' : 'medium',
        scopeKey: `runtime:${request.runtime}:${request.kind}:${request.fingerprint}`,
        ruleTarget: request.ruleTarget,
      },
      signal,
    );
    return decision !== 'deny';
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
