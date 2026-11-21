import type {PermissionMode, PermissionPromptRequest, PermissionResolutionScope} from '@cosmew/contracts';
/** `acceptEdits` is Claude Code's "switch to accept edits for this session": allow once, then change the mode. */
export type PermissionChoiceId = PermissionResolutionScope | 'acceptEdits';
export interface PermissionChoice {
  id: PermissionChoiceId;
  label: string;
  key: string;
  description?: string;
}
export const ACCEPT_EDITS_LABEL =
  'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)';
/** Edit/Write prompts (not apply-only escalations) may offer the mode switch from `default`. */
export function offersAcceptEdits(request: PermissionPromptRequest, mode?: PermissionMode): boolean {
  return mode === 'default' && request.capability === 'fs.write' && request.decisions.includes('once');
}
/** Number only decisions actually offered by the SDK; labels never widen their scope. */
export function permissionChoices(request: PermissionPromptRequest, mode?: PermissionMode) {
  const choices: PermissionChoice[] = [];
  const trust = request.capability === 'settings.trust';
  const network = request.capability === 'network.connect' && !!request.alwaysRule?.startsWith('domain:');
  if (request.decisions.includes('once')) choices.push({id: 'once', key: '', label: 'Yes'});
  if (offersAcceptEdits(request, mode)) choices.push({id: 'acceptEdits', key: '', label: ACCEPT_EDITS_LABEL});
  if (request.decisions.includes('session'))
    choices.push({
      id: 'session',
      key: '',
      label: trust
        ? 'Yes, trust this content during this session'
        : 'Yes, and don’t ask again for this scope during this session',
    });
  if (request.decisions.includes('always') && (request.alwaysRule || trust))
    choices.push({
      id: 'always',
      key: '',
      label: trust
        ? 'Yes, always trust this content (by hash)'
        : network
          ? 'Yes, always allow this domain'
          : 'Yes, and save this rule in project settings',
      description: trust
        ? 'Ask again when the file changes'
        : network
          ? `sandbox.network.allowedDomains: ${request.alwaysRule!.slice(7)}`
          : `Allow: ${request.alwaysRule}`,
    });
  choices.push({id: 'deny', key: '', label: trust ? 'No, skip this settings file' : 'No'});
  return choices.map((choice, index) => ({...choice, key: String(index + 1)}));
}
export function isEscalation(request: PermissionPromptRequest): boolean {
  if (request.commandSandbox !== undefined)
    return request.commandSandbox === 'escape' || request.commandSandbox === 'excluded';
  // Older callers and terminal-input prompts may still use the display strings.
  return /NO SANDBOX|dangerouslyDisableSandbox|WITHOUT (?:the )?sandbox/i.test(`${request.action} ${request.reason}`);
}
/** A write whose diff starts from `/dev/null` creates the file. */
export function createsFile(request: PermissionPromptRequest): boolean {
  return /^--- \/dev\/null$/m.test(request.diffPreview ?? '');
}
export function permissionTitle(request: PermissionPromptRequest, toolName = request.action): string {
  if (request.capability === 'fs.read') return 'Read file';
  if (request.capability === 'process.execute') return 'Bash command';
  if (/apply_patch|\bedit\b|\bwrite\b/.test(toolName) || request.capability === 'fs.write') {
    if (createsFile(request)) return 'Create file';
    return /\bwrite\b/.test(toolName) ? 'Write file' : 'Edit file';
  }
  if (/mcp__/i.test(toolName) || request.capability === 'mcp.call') return 'MCP tool';
  if (/web_search/i.test(toolName) || request.capability === 'network.search') return 'Web Search';
  if (/fetch/i.test(toolName)) return 'Fetch';
  if (request.capability === 'network.connect') return 'Network access';
  if (request.capability === 'settings.trust') return 'Trust settings';
  return toolName;
}
/** The question line under the body: `Do you want to make this edit to a.txt?` / `Do you want to proceed?`. */
export function permissionQuestion(request: PermissionPromptRequest, title: string): string {
  if (title === 'Create file') return `Do you want to create ${request.target}?`;
  if (title === 'Edit file' || title === 'Write file') return `Do you want to make this edit to ${request.target}?`;
  return 'Do you want to proceed?';
}
