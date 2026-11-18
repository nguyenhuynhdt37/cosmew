/**
 * Startup sequence: folder consent → account/model verification → chat.
 *  - trust:    ask before any request is made or the workspace is read
 *  - checking: a small (possibly billed) verification request is in flight
 *  - choose:   verification failed or was abandoned; pick an account or sign in
 *  - login:    the sign-in / model overlays are open on top of the gate
 */
export type StartupPhase = 'off' | 'trust' | 'checking' | 'choose' | 'login';

export interface StartupGateState {
  phase: StartupPhase;
  /** Highlighted row in the trust or account list. */
  index: number;
  /** Why the gate is showing the account chooser. */
  message: string;
  /** When the current verification request started (ms), for the elapsed counter. */
  startedAt?: number;
}

export interface GateRow {
  text: string;
  fg: string;
  bold?: boolean;
}
