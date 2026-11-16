import type {CommandOutcome, CommandSandbox} from '@futryn/contracts';
import type {Mount} from './container-mounts';

/**
 * Host side of the supervisor protocol (ADR 0032/0034). The trusted PID1 writes one JSON frame per
 * line: `data` frames carry base64 output, one final `result` frame is the receipt. Command output
 * is always inside a data frame, so a command cannot forge a receipt.
 */

/** Longest accepted frame line; anything longer breaks the protocol and stops the session. */
const MAX_FRAME_LINE = 262_144;
const MAX_DATA_FIELD = 131_072;

export interface Receipt {
  kind: CommandOutcome['kind'];
  exitCode: number | null;
  signal: string | null;
  outputClosed: boolean;
  wrapperExitCode: number;
}

export interface FrameHandlers {
  onData(stream: 'stdout' | 'stderr', bytes: Buffer): void;
  onReceipt(receipt: Receipt): void;
  /**
   * Malformed or duplicate frames make the outcome unconfirmed; `fatal` (an oversized line) also
   * means the stream cannot be trusted any more, so the session must be stopped.
   */
  onProtocolError(fatal: boolean): void;
}

/** Splits the supervisor's stdout into frames and validates each one. */
export class FrameReader {
  private pending = '';
  private receiptSeen = false;

  constructor(private readonly handlers: FrameHandlers) {}

  push(bytes: Buffer): void {
    this.pending += bytes.toString('utf8');
    for (;;) {
      const end = this.pending.indexOf('\n');
      if (end < 0) {
        if (this.pending.length > MAX_FRAME_LINE) this.fail();
        return;
      }
      if (end > MAX_FRAME_LINE) {
        this.fail();
        return;
      }
      const line = this.pending.slice(0, end);
      this.pending = this.pending.slice(end + 1);
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let frame: unknown;
    try { frame = JSON.parse(line); } catch { this.handlers.onProtocolError(false); return; }

    if (isDataFrame(frame)) {
      this.handlers.onData(frame.stream, Buffer.from(frame.data, 'base64'));
    } else if (isReceipt(frame) && !this.receiptSeen) {
      this.receiptSeen = true;
      this.handlers.onReceipt(frame);
    } else {
      this.handlers.onProtocolError(false);
    }
  }

  private fail(): void {
    this.pending = '';
    this.handlers.onProtocolError(true);
  }
}

function isDataFrame(frame: unknown): frame is {type: 'data'; stream: 'stdout' | 'stderr'; data: string} {
  const f = frame as Record<string, unknown>;
  return f?.type === 'data'
    && (f.stream === 'stdout' || f.stream === 'stderr')
    && typeof f.data === 'string'
    && f.data.length <= MAX_DATA_FIELD
    && /^[A-Za-z0-9+/]*={0,2}$/.test(f.data);
}

function isReceipt(frame: unknown): frame is Receipt & {type: 'result'} {
  const f = frame as Record<string, unknown>;
  return f?.type === 'result'
    && ['exited', 'timeout', 'cancelled', 'spawn-failed'].includes(f.kind as string)
    && (f.exitCode === null || Number.isInteger(f.exitCode))
    && (f.signal === null || (typeof f.signal === 'string' && /^SIG[A-Z0-9]{1,12}$/.test(f.signal)))
    && typeof f.outputClosed === 'boolean'
    && Number.isInteger(f.wrapperExitCode);
}

/** Capabilities the trusted supervisor may keep; the command itself drops all of them. */
const ALLOWED_CAPABILITIES = ['SETUID', 'SETGID', 'SETPCAP', 'KILL'];

interface HostConfig {
  PidMode?: string;
  NetworkMode?: string;
  Privileged?: boolean;
  ReadonlyRootfs?: boolean;
  SecurityOpt?: string[];
  PidsLimit?: number;
  Memory?: number;
  NanoCpus?: number;
  CgroupnsMode?: string;
  CapDrop?: string[];
  CapAdd?: string[] | null;
  Binds?: string[] | null;
  Mounts?: {Type: string; Source: string; Target: string; ReadOnly?: boolean}[];
}

/**
 * The created container, not the request, is the authority: its actual `HostConfig` must match
 * the fixed policy and exactly the planned mount set before it is started.
 */
export function hostConfigMatches(host: HostConfig | null, sandbox: CommandSandbox, expected: Mount[]): boolean {
  if (!host) return false;

  const policyOk = host.PidMode === ''
    && host.NetworkMode === (sandbox.network ? 'bridge' : 'none')
    && !host.Privileged
    && host.ReadonlyRootfs === true
    && (host.SecurityOpt ?? []).includes('no-new-privileges')
    && host.PidsLimit === 128
    && host.Memory === 536_870_912
    && host.NanoCpus === 1_000_000_000
    && host.CgroupnsMode === 'private'
    && (host.CapDrop ?? []).includes('ALL')
    && !(host.CapAdd ?? []).some(cap => !ALLOWED_CAPABILITIES.includes(cap.replace(/^CAP_/, '')))
    && !host.Binds?.length;
  if (!policyOk) return false;

  const key = (mount: Mount) => JSON.stringify([mount.Source, mount.Target, mount.ReadOnly]);
  const wanted = new Set(expected.map(key));
  const actual = (host.Mounts ?? []).map(m => m.Type === 'bind' ? {Source: m.Source, Target: m.Target, ReadOnly: m.ReadOnly === true} : {Source: '', Target: '', ReadOnly: false});
  return actual.length === expected.length && actual.every(mount => wanted.has(key(mount)));
}
