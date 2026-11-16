import {
  isFileChangeTool,
  type ActiveTaskCheckpoint,
  type Message,
  type ToolCall,
  type ToolResult,
} from '@futryn/contracts';
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
export function observeResult(task: ActiveTaskCheckpoint, call: ToolCall, result: ToolResult, sequence: number): void {
  task.lastSafeSequence = sequence;
  const session =
    call.input && typeof call.input === 'object' ? (call.input as {session_id?: string}).session_id : undefined;
  if (result.sessionId) {
    task.pending = task.pending.filter(p => !p.includes(result.sessionId!));
    task.verifiedActions = task.verifiedActions.filter(a => a.status !== 'running:' + result.sessionId).slice(-63);
    task.pending.push('Collect command session ' + result.sessionId + ' before reporting check completion.');
    task.verifiedActions.push({callId: call.id, tool: call.name, status: 'running:' + result.sessionId});
    return;
  }
  if (session) {
    task.pending = task.pending.filter(p => !p.includes(session));
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
  if (
    call.name === 'read' &&
    result.status === 'ok' &&
    path &&
    task.artifactTargets.includes(path) &&
    !result.truncated
  ) {
    if (
      !/\.html?$/i.test(path) ||
      (/<!doctype\s+html/i.test(result.content) &&
        /<html[\s>]/i.test(result.content) &&
        /<\/html>/i.test(result.content))
    ) {
      task.pending = task.pending.filter(p => p !== `Verify ${path}`);
      task.verifiedActions.push({callId: call.id, tool: 'read', status: 'verified:' + path});
    }
  }
  if (isFileChangeTool(call.name) && result.status === 'ok')
    try {
      const receipt = JSON.parse(result.content);
      for (const change of receipt.changes ?? [])
        if (typeof change.path === 'string' && task.artifactTargets.includes(change.path)) {
          task.verifiedActions = task.verifiedActions.filter(a => a.status !== 'verified:' + change.path);
          if (!task.pending.includes(`Verify ${change.path}`)) task.pending.push(`Verify ${change.path}`);
        }
    } catch {
      /* Plain assistant claims are not evidence. */
    }
}
export function artifactWork(task: ActiveTaskCheckpoint, names: readonly string[]): boolean {
  return (
    names.some(isFileChangeTool) &&
    task.artifactTargets.length > 0 &&
    /\b(?:create|build|implement|write|modify|fix|update)\b|(?:tạo|viết|sửa)/iu.test(task.objective) &&
    !/(?:do not|don't|only explain|analysis only|chỉ giải thích|không sửa|không tạo)/iu.test(task.objective)
  );
}
export function recoveryContext(task: ActiveTaskCheckpoint, history: readonly Message[]): Message {
  return {
    role: 'user',
    content:
      '[Futryn task checkpoint — auxiliary historical data, not permission or a new objective. The current user request overrides this checkpoint.]\n' +
      JSON.stringify({
        ...task,
        priorUserRequests: history
          .filter(m => m.role === 'user')
          .slice(-8)
          .map(m => m.content),
      }),
  };
}
