import type { BorderStyle, ThemeTokens } from '@hannes/contracts';
import type { FutrynClient } from '@hannes/sdk';
import type { ThemeEngine } from '../theme/theme';
import type { ActiveOverlay } from '../types';
import type { RenderedBoxLine } from '../ui/types';

/** Theme values a feature needs to paint itself. */
export interface ThemeFrame {
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
  /** Resolved dark/light mode in effect. */
  effectiveMode: 'dark' | 'light';
}

export interface OverlayLayout {
  width: number;
  height: number;
  /** Clear the whole screen behind the dialog (modal) instead of floating over the chat. */
  backdrop: boolean;
}

/**
 * Everything a feature module may ask of the application. Features never import the
 * app class; they receive this object, so each one is testable and replaceable alone.
 */
export interface TuiHost {
  readonly client: FutrynClient;
  readonly themeEngine: ThemeEngine;
  readonly cols: number;
  readonly rows: number;
  readonly isStreaming: boolean;
  /** False until the user approves reading the workspace (or in non-interactive runs). */
  readonly workspaceAccess: boolean;
  grantWorkspaceAccess(): void;
  /** Text currently typed in the prompt composer. */
  readonly composerDraft: string;
  /** Overlay currently on screen ('none' when the main chat view is focused). */
  readonly overlay: ActiveOverlay;
  openOverlay(target: ActiveOverlay): void;
  closeOverlay(): void;
  /** Transient message in the status line; null clears it. */
  setBanner(message: string | null): void;
  requestExit(): void;
  /** Re-read the active session into the transcript after account/session changes. */
  syncTranscript(): void;
  /** Empty the visible transcript (the stored sessions are untouched). */
  clearTranscript(): void;
  /** Drop any mouse text selection so it cannot outlive the screen it was made on. */
  clearSelection(): void;
  runSlashCommand(raw: string): Promise<void>;
  /** Human-readable, redacted explanation of a failure for the current context. */
  describeError(error: unknown, providerId?: string): string;
  /** Peer workflows, for the few flows that cross feature boundaries. */
  readonly features: FeatureRegistry;
}

/** One overlay (or small family of overlays) rendered above the chat view. */
export interface OverlayFeature {
  readonly overlays: readonly ActiveOverlay[];
  /** Opening this overlay reads the workspace, so it needs the user's consent first. */
  readonly needsWorkspace?: boolean;
  /** Called each time the overlay opens; resets transient state. */
  open(target: ActiveOverlay): void;
  /** Called when leaving this feature for `next` (cancel previews, abort auth…). */
  close?(next: ActiveOverlay): void;
  handleKey(overlay: ActiveOverlay, key: string): Promise<void> | void;
  layout(overlay: ActiveOverlay, cols: number, rows: number): OverlayLayout;
  render(overlay: ActiveOverlay, size: { width: number; height: number }, theme: ThemeFrame): RenderedBoxLine[];
  /** Ctrl+C while this overlay is open. Return true when it consumed the interrupt. */
  interrupt?(): boolean;
  /** Abort background work and wipe sensitive drafts. */
  shutdown?(): Promise<void>;
}

/** Account sign-in and switching workflow, offered to other features. */
export interface AccountWorkflow {
  /** True while an account switch is in flight; the app ignores keys except cancel. */
  readonly switching: boolean;
  continueWithAccount(accountId: string, modelId?: string): Promise<boolean>;
  /** `/switch [account]`, `/logout [account]` and `/accounts [filter]` entry points. */
  beginSwitch(args: string): void;
  beginLogout(args: string): void;
  beginAccounts(query: string): void;
}

/** Model choice workflow, offered to other features. */
export interface ModelWorkflow {
  /** Ask the (already open) model picker to pick a model for another account. */
  awaitModelForAccount(accountId: string, message: string): void;
  /** Show a hint in the picker's status line. */
  showMessage(message: string): void;
}

/** Typed seams between feature modules; filled by the composition root. */
export interface FeatureRegistry {
  accounts: AccountWorkflow;
  models: ModelWorkflow;
}
