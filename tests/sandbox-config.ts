import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DEFAULT_SANDBOX_CONFIG, type SandboxConfig} from '@cosmew/tools';

/** Explicit workspace-write sandbox opt-in for containment tests (ADR 0081 defaults are off). */
export const sandboxConfig = (overrides: Partial<SandboxConfig> = {}): SandboxConfig => ({
  ...DEFAULT_SANDBOX_CONFIG,
  readOnly: false,
  allowUnsandboxed: true,
  ...overrides,
});

/** Trusted user settings for tests of containment, independent of product defaults (ADR 0081). */
export function writeSandboxSettings(stateDirectory: string, autoAllowBashIfSandboxed = true): void {
  writeFileSync(
    join(stateDirectory, 'settings.json'),
    JSON.stringify({sandbox: {enabled: true, autoAllowBashIfSandboxed, allowUnsandboxedCommands: true}}),
    {mode: 0o600},
  );
}
