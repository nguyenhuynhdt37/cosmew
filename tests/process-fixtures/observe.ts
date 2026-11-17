/** Independent test-only observation. Never used by production signalling. */
import {spawnSync} from 'node:child_process';
export interface Observation {
  pid: number;
  ppid: number;
  group: number;
  state: string;
  started: string;
  command: string;
}
type PsResult = {status: number | null; stdout: string; stderr: string; error?: Error; signal?: string | null};
const FORMAT = 'pid=,ppid=,pgid=,stat=,lstart=,command=';
function probe(args: string[], missingPidIsAbsent = false): Observation[] {
  const result = spawnSync('/bin/ps', args, {encoding: 'utf8', timeout: 2000, maxBuffer: 4 * 1024 * 1024});
  return parseObservationResult(result, missingPidIsAbsent);
}
/** Global inventory is retained for independent family discovery. */
export function observe(): Observation[] {
  return probe(['-A', '-o', FORMAT]);
}
/** Failures are never proof that a process disappeared; only ps's clean no-PID status is absent. */
export function parseObservationResult(result: PsResult, missingPidIsAbsent = false): Observation[] {
  if (result.error || result.signal || result.stderr.trim()) throw new Error('Independent ps observation failed');
  if (missingPidIsAbsent && result.status === 1 && !result.stdout.trim()) return [];
  if (result.status !== 0) throw new Error('Independent ps observation failed');
  return result.stdout.split('\n').flatMap(line => {
    if (!line.trim()) return [];
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.{24})\s+(.*)$/.exec(line);
    if (!match) throw new Error('Independent ps observation failed');
    return [
      {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        group: Number(match[3]),
        state: match[4]!,
        started: match[5]!,
        command: match[6]!,
      },
    ];
  });
}
export const live = (p: Observation) => !p.state.startsWith('Z');
export const same = (a: Observation, b: Observation) =>
  a.pid === b.pid && a.started === b.started && a.command === b.command;
export function current(original: Observation): Observation | undefined {
  if (!Number.isSafeInteger(original.pid) || original.pid <= 0) throw new Error('Invalid observed PID');
  // Rechecking one identity must not repeatedly scan every process on the host.
  return probe(['-p', String(original.pid), '-o', FORMAT], true).find(p => same(original, p) && live(p));
}
export async function waitFor<T>(check: () => T | undefined, ms = 2500): Promise<T> {
  const until = Date.now() + ms;
  do {
    const result = check();
    if (result !== undefined) return result;
    await Bun.sleep(15);
  } while (Date.now() < until);
  throw new Error('Bounded process observation timed out');
}
/** Disposable fixtures sleep only a few seconds; check identity again before scoped cleanup. */
export async function dispose(records: Observation[]): Promise<void> {
  for (const record of records) {
    if (current(record))
      try {
        process.kill(record.pid, 'SIGKILL');
      } catch {
        /* exited */
      }
  }
  await waitFor(() => (records.every(record => !current(record)) ? true : undefined));
}
