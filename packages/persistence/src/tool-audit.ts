import type { Database } from 'bun:sqlite';
import { HannesError } from '@hannes/contracts';

/** One audit line from the tool dispatcher. Targets are workspace-relative; no file contents. */
export interface ToolAuditEntry {
  at: string;
  callId: string;
  tool: string;
  target: string | null;
  phase: string;
  decision?: string;
  reason?: string;
  outcome?: string;
  code?: string;
}

/** Append-only tool audit trail (ADR 0017). Writes are synchronous so intent is durable before a prompt. */
export class ToolAuditStore {
  constructor(private readonly db: Database) {}

  append(entry: ToolAuditEntry): void {
    try {
      this.db.query('INSERT INTO tool_audit (at, call_id, tool, target, phase, decision, reason, outcome, code) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(entry.at, entry.callId, entry.tool.slice(0, 100), entry.target?.slice(0, 1024) ?? null, entry.phase, entry.decision ?? null, entry.reason?.slice(0, 100) ?? null, entry.outcome ?? null, entry.code?.slice(0, 64) ?? null);
    } catch { throw new HannesError('STORAGE'); }
  }

  recent(limit = 100): ToolAuditEntry[] {
    const rows = this.db.query('SELECT at, call_id, tool, target, phase, decision, reason, outcome, code FROM tool_audit ORDER BY rowid DESC LIMIT ?').all(limit) as Record<string, string | null>[];
    return rows.map(row => ({ at: row.at!, callId: row.call_id!, tool: row.tool!, target: row.target ?? null, phase: row.phase!, decision: row.decision ?? undefined, reason: row.reason ?? undefined, outcome: row.outcome ?? undefined, code: row.code ?? undefined }));
  }
}
