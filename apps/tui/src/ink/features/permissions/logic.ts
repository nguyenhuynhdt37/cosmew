import type {PermissionPromptRequest, PermissionResolutionScope} from '@futryn/contracts';
export function permissionChoices(request: PermissionPromptRequest) {
  const choices: {id: PermissionResolutionScope; label: string; key: string; description?: string}[] = [];
  if (request.decisions.includes('once')) choices.push({id: 'once', key: '1', label: '1 Lần này'});
  if (request.decisions.includes('session')) choices.push({id: 'session', key: '2', label: '2 Cả phiên'});
  if (request.decisions.includes('always') && request.alwaysRule)
    choices.push({id: 'always', key: '3', label: '3 Luôn cho project', description: `Allow: ${request.alwaysRule}`});
  choices.push({id: 'deny', key: '4', label: '4 Không và nói lý do'});
  return choices;
}
export function isEscalation(request: PermissionPromptRequest): boolean {
  return (
    /NO SANDBOX|require_escalated|WITHOUT (?:the )?sandbox/i.test(`${request.action} ${request.reason}`) ||
    !!request.alwaysRule?.startsWith('Unsandboxed(')
  );
}
