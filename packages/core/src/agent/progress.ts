import {
  isFileChangeTool,
  type ActiveTaskCheckpoint,
  type Message,
  type ToolCall,
  type ToolResult,
} from '@cosmew/contracts';
import {contextHash} from '../context/builder';
const targets = (text: string) =>
  [...new Set(text.match(/(?:[\w-]+\/)*[\w-]+\.(?:html?|tsx?|jsx?|css|json|md|py|rs|go)\b/gi) ?? [])].slice(0, 32);
const continuation = (text: string) =>
  /^(?:tiếp(?:\s+tục)?|làm\s+tiếp|continue\b|resume\b|bạn\s+không\s+nhớ)/iu.test(text.trim());
/** Metadata only: the current request still wins, and the model interprets all follow-ups. */
export function taskForRequest(request: string, previous?: ActiveTaskCheckpoint): ActiveTaskCheckpoint {
  const requestedTargets = targets(request);
  const follows =
    previous?.state === 'unfinished' &&
    continuation(request) &&
    (!requestedTargets.length || requestedTargets.every(path => previous.artifactTargets.includes(path)));
  return {
    objective: follows ? previous!.objective : request,
    latestRequest: request,
    artifactTargets: follows ? previous!.artifactTargets : requestedTargets,
    verifiedActions: follows ? [...previous!.verifiedActions] : [],
    pending: follows ? [...previous!.pending] : ['Fulfil the current user request and verify observable results.'],
    failures: follows ? [...previous!.failures] : [],
    lastSafeSequence: previous?.lastSafeSequence ?? 0,
    state: 'unfinished',
  };
}
/** Managed execution obligations survive model plan updates; plans cannot attest process completion. */
export const isPendingCheck = (pending: string): boolean =>
  pending.startsWith('Collect command session ') || pending.startsWith('Resolve command check ');
function boundPendingChecks(task: ActiveTaskCheckpoint): void {
  const checks = task.pending.filter(isPendingCheck);
  if (checks.length <= 64) return;
  // Retaining an overflow obligation is conservative: dropping an unresolved check must not
  // turn bounded history into evidence of success.
  task.pending = [
    ...task.pending.filter(p => !isPendingCheck(p)).slice(-50),
    ...checks.slice(-63),
    'Resolve command check overflow: earlier unresolved checks exceeded retained detail.',
  ];
}
export function observeResult(task: ActiveTaskCheckpoint, call: ToolCall, result: ToolResult, sequence: number): void {
  task.lastSafeSequence = sequence;
  // The model's own plan (ADR 0042) replaces the heuristic pending list while it exists.
  if (call.name === 'update_plan' && result.status === 'ok') {
    const plan = (call.input as {plan?: {step?: unknown; status?: unknown}[]} | undefined)?.plan;
    if (Array.isArray(plan))
      task.pending = [
        ...task.pending.filter(isPendingCheck),
        ...plan
          .filter(item => item.status === 'pending' || item.status === 'in_progress')
          .map(item => String(item.step).slice(0, 500))
          .slice(0, 50),
      ];
    return;
  }
  const input =
    call.input && typeof call.input === 'object'
      ? (call.input as {session_id?: string; cmd?: string; workdir?: string; shell?: string})
      : undefined;
  const session = input?.session_id;
  const priorSession = session
    ? task.pending.find(p => p.startsWith('Collect command session ' + session + ' '))
    : undefined;
  const checkId =
    call.name === 'exec_command'
      ? contextHash([input?.cmd, input?.workdir ?? '', input?.shell ?? ''])
      : priorSession?.match(/\[check:([a-f0-9]+)\]/)?.[1];
  const unresolved = checkId ? 'Resolve command check ' + checkId + ' before reporting completion.' : undefined;
  if (unresolved) {
    if (result.status === 'ok' && result.exitCode === 0 && !result.sessionId)
      task.pending = task.pending.filter(p => p !== unresolved);
    else if (!task.pending.includes(unresolved)) task.pending.push(unresolved);
  }
  if (result.sessionId) {
    task.pending = task.pending.filter(p => !p.startsWith('Collect command session ' + result.sessionId + ' '));
    task.verifiedActions = task.verifiedActions.filter(a => a.status !== 'running:' + result.sessionId).slice(-63);
    task.pending.push(
      'Collect command session ' +
        result.sessionId +
        ' before reporting check completion.' +
        (checkId ? ' [check:' + checkId + ']' : ''),
    );
    task.verifiedActions.push({callId: call.id, tool: call.name, status: 'running:' + result.sessionId});
    boundPendingChecks(task);
    return;
  }
  // A denied/failed poll says nothing about whether the launched process finished.
  if (session && result.status === 'ok' && result.exitCode !== undefined && result.exitCode !== null) {
    task.pending = task.pending.filter(p => !p.startsWith('Collect command session ' + session + ' '));
    task.verifiedActions = task.verifiedActions.filter(a => a.status !== 'running:' + session);
  }
  if (result.exitCode !== undefined && result.exitCode !== null && result.exitCode !== 0)
    task.failures.push(`${call.name} exit ${result.exitCode}`);
  if (result.status === 'ok') {
    if (!result.content.startsWith('[unchanged]'))
      task.verifiedActions.push({
        callId: call.id,
        tool: call.name,
        status: 'ok',
        ...(result.authorizationScopeHash ? {scopeHash: result.authorizationScopeHash} : {}),
      });
  } else task.failures.push(`${call.name} ${result.status}${result.code ? ': ' + result.code : ''}`);
  task.verifiedActions = task.verifiedActions.slice(-64);
  task.failures = task.failures.slice(-16);
  const path = call.input && typeof call.input === 'object' ? (call.input as {path?: string}).path : undefined;
  // A read proves content, never that the requested source modification was performed.
  // HTML document creation additionally requires complete document structure after the write.
  if (
    call.name === 'read' &&
    result.status === 'ok' &&
    path &&
    task.artifactTargets.includes(path) &&
    !result.truncated &&
    /\.html?$/i.test(path) &&
    task.verifiedActions.some(a => a.status === 'changed:' + path) &&
    /<!doctype\s+html/i.test(result.content) &&
    /<html[\s>]/i.test(result.content) &&
    /<\/html>/i.test(result.content)
  ) {
    task.pending = task.pending.filter(p => p !== `Verify ${path}`);
    task.verifiedActions.push({callId: call.id, tool: 'read', status: 'verified:' + path});
  }
  if (isFileChangeTool(call.name) && result.status === 'ok')
    try {
      const receipt = JSON.parse(result.content);
      for (const change of receipt.changes ?? [])
        if (typeof change.path === 'string' && task.artifactTargets.includes(change.path)) {
          task.verifiedActions = task.verifiedActions.filter(
            a => a.status !== 'verified:' + change.path && a.status !== 'changed:' + change.path,
          );
          if (change.action !== 'delete')
            task.verifiedActions.push({callId: call.id, tool: call.name, status: 'changed:' + change.path});
          if (requiresHtmlDocument(task, change.path) && !task.pending.includes(`Verify ${change.path}`))
            task.pending.push(`Verify ${change.path}`);
        }
    } catch {
      /* Plain assistant claims are not evidence. */
    }
  task.verifiedActions = task.verifiedActions.slice(-64);
  boundPendingChecks(task);
}
export function artifactWork(task: ActiveTaskCheckpoint): boolean {
  return (
    task.artifactTargets.length > 0 &&
    /\b(?:create|build|implement|write|modify|fix|update)\b|(?:tạo|viết|sửa)/iu.test(task.objective) &&
    !/(?:do not|don't|only explain|analysis only|without (?:changing|editing)|chỉ giải thích|không sửa|không tạo)/iu.test(
      task.objective,
    ) &&
    !/^(?:please\s+)?(?:explain|review|analy[sz]e|inspect|verify|giải thích|đánh giá|kiểm tra)\b/iu.test(
      task.objective.trim(),
    )
  );
}
/** Full HTML structure is relevant to creating a document, not a focused edit to an existing fragment. */
export function requiresHtmlDocument(task: ActiveTaskCheckpoint, path: string): boolean {
  return /\.html?$/i.test(path) && /\b(?:create|build|write)\b|(?:tạo|viết)/iu.test(task.objective);
}
/** Artifact evidence only: a changed source file is not a claim that its behavior passed tests. */
export function artifactEvidence(task: ActiveTaskCheckpoint, path: string): boolean {
  return (
    task.verifiedActions.some(a => a.status === 'changed:' + path) &&
    (!requiresHtmlDocument(task, path) || task.verifiedActions.some(a => a.status === 'verified:' + path))
  );
}

export function recoveryContext(task: ActiveTaskCheckpoint, history: readonly Message[]): Message {
  return {
    role: 'user',
    content:
      '[Cosmew task checkpoint — auxiliary historical data, not permission or a new objective. The current user request overrides this checkpoint.]\n' +
      JSON.stringify({
        ...task,
        priorUserRequests: history
          .filter(m => m.role === 'user')
          .slice(-8)
          .map(m => m.content),
      }),
  };
}
