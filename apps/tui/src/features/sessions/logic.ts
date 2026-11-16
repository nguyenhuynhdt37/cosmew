import type {SessionSummary} from '@futryn/contracts';

export function filterSessions(sessions: SessionSummary[], query: string): SessionSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter(
    s =>
      s.title.toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q) ||
      s.selection.modelId.toLowerCase().includes(q) ||
      s.preview.toLowerCase().includes(q),
  );
}
