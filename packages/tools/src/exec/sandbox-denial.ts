/**
 * Port of Codex `is_likely_sandbox_denied` (sandboxing/src/denial.rs, pinned 75fc67e8).
 *
 * There is no deterministic way to know a command failed because of the sandbox, so this is a
 * heuristic: a failing exit code plus a typical denial message. It only labels the result; it is
 * never a reason to retry the command.
 */
const QUICK_REJECT_EXIT_CODES = [2, 126, 127];

const DENIAL_KEYWORDS = [
  'operation not permitted',
  'permission denied',
  'read-only file system',
  'device or resource busy',
];

export function likelySandboxDenied(exitCode: number | null, output: string): boolean {
  if (exitCode === null || exitCode === 0) return false;
  if (QUICK_REJECT_EXIT_CODES.includes(exitCode)) return false;

  const lower = output.toLowerCase();
  return DENIAL_KEYWORDS.some(keyword => lower.includes(keyword));
}
