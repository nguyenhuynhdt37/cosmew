import {DEFAULT_SANDBOX_CONFIG, type SandboxConfig} from '@cosmew/tools';

/** A workspace-write sandbox config like the product default (ADR 0061), with overrides. */
export const sandboxConfig = (overrides: Partial<SandboxConfig> = {}): SandboxConfig => ({
  ...DEFAULT_SANDBOX_CONFIG,
  readOnly: false,
  allowUnsandboxed: true,
  ...overrides,
});
