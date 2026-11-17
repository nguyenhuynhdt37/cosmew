import type {Application} from '../../apps/cli/src/bootstrap/startup';

export interface EvidenceCall {
  callId: string;
  tool: string;
  verified: boolean;
  authorizationScopeMatched: boolean | null;
  journalVerified: boolean;
  auditVerified: boolean;
  decision: string | null;
}
export interface TurnEvidence {
  source: 'sqlite-journal-and-tool-audit';
  sessionId: string;
  turnId: string;
  modelRequests: number;
  journalVerified: boolean;
  dispatcherVerified: boolean;
  truncated: boolean;
  calls: EvidenceCall[];
  unavailable?: boolean;
}
export interface ObservedToolCall {
  callId: string;
  name: string;
  status?: string;
  code?: string;
}
export function collectTurnEvidence(
  app: Application,
  sessionId: string,
  turnId: string,
  calls: ObservedToolCall[],
  auditAfter: number,
): TurnEvidence {
  const empty: TurnEvidence = {
    source: 'sqlite-journal-and-tool-audit',
    sessionId,
    turnId,
    modelRequests: 0,
    journalVerified: false,
    dispatcherVerified: false,
    truncated: false,
    calls: [],
  };
  try {
    const turn = app.conversations.recover(sessionId).turns.find(turn => turn.id === turnId);
    if (!turn) return {...empty, unavailable: true};
    // Read the audit independently of streamed tool events. Do not export inputs, targets or content.
    const rows = app.db
      .query(
        'SELECT rowid AS position, call_id, tool, phase, decision, outcome, code, scope_hash FROM tool_audit WHERE rowid>? ORDER BY rowid LIMIT 10001',
      )
      .all(auditAfter) as {
      position: number;
      call_id: string;
      tool: string;
      phase: string;
      decision: string | null;
      outcome: string | null;
      code: string | null;
      scope_hash: string | null;
    }[];
    const truncated = rows.length > 10000 || calls.length > 1000;
    const evidence = calls.slice(0, 1000).map(call => {
      const called = turn.events.filter(event => event.data.type === 'tool.call' && event.data.call.id === call.callId);
      const intended = turn.events.filter(
        event => event.data.type === 'tool.intent' && event.data.callId === call.callId,
      );
      const results = turn.events.filter(
        event => event.data.type === 'tool.result' && event.data.result.callId === call.callId,
      );
      const result = results[0]?.data;
      const journalVerified =
        called.length === 1 &&
        intended.length === 1 &&
        results.length === 1 &&
        called[0]!.seq < intended[0]!.seq &&
        intended[0]!.seq < results[0]!.seq &&
        called[0]!.data.type === 'tool.call' &&
        called[0]!.data.call.name === call.name &&
        result?.type === 'tool.result' &&
        result.result.name === call.name &&
        result.result.status === call.status &&
        result.result.code === call.code;
      const audit = rows.slice(0, 10000).filter(row => row.call_id === call.callId);
      const requested = audit.filter(row => row.phase === 'requested');
      const completed = audit.filter(row => row.phase === 'completed');
      const decided = audit.filter(
        row => row.phase === 'decided' && ['allow', 'once', 'session', 'deny'].includes(row.decision ?? ''),
      );
      const auditVerified =
        requested.length === 1 &&
        completed.length === 1 &&
        decided.length > 0 &&
        audit.every(row => row.tool === call.name) &&
        requested[0]!.position < decided[0]!.position &&
        decided.at(-1)!.position < completed[0]!.position &&
        completed[0]!.outcome === call.status &&
        (completed[0]!.code ?? undefined) === call.code;
      const scope = result?.type === 'tool.result' ? result.result.authorizationScopeHash : undefined;
      const authorizationScopeMatched = scope ? decided.some(row => row.scope_hash === scope) : null;
      return {
        callId: call.callId,
        tool: call.name,
        journalVerified,
        auditVerified,
        authorizationScopeMatched,
        decision: decided.at(-1)?.decision ?? null,
        verified: journalVerified && auditVerified && authorizationScopeMatched !== false,
      };
    });
    const accepted = turn.events.filter(event => event.data.type === 'user.accepted');
    const finished = turn.events.filter(event => event.data.type === 'turn.finished');
    const modelRequests = turn.events.filter(event => event.data.type === 'model.requested').length;
    return {
      ...empty,
      modelRequests,
      truncated,
      calls: evidence,
      journalVerified:
        accepted.length === 1 &&
        modelRequests > 0 &&
        finished.length === 1 &&
        finished[0]!.data.type === 'turn.finished' &&
        finished[0]!.data.state === turn.state &&
        accepted[0]!.seq < finished[0]!.seq,
      dispatcherVerified: !truncated && evidence.length > 0 && evidence.every(call => call.verified),
    };
  } catch {
    return {...empty, unavailable: true};
  }
}
