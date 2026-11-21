import type {CommandSandbox} from '@cosmew/contracts';

/** An OS sandbox that can wrap one shell command (ADR 0035). */
export interface NativeSandbox {
  readonly name: 'macos-seatbelt' | 'linux-bubblewrap';

  /**
   * Whether the sandbox itself guarantees that every descendant dies with the command.
   * True for bubblewrap (PID namespace); false for Seatbelt, where `setsid` can escape.
   */
  readonly containsDescendants: boolean;

  /** Returns the argv that runs `argv` inside the sandbox with the given policy. */
  wrap(argv: string[], sandbox: CommandSandbox, cwd: string): string[];
}
