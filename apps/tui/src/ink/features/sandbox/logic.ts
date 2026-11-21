import type {PermissionSettingsSnapshot, SandboxSettingsPatch} from '@cosmew/contracts';
export const SANDBOX_TABS = ['Mode', 'Dependencies', 'Overrides', 'Config'] as const;
export const SANDBOX_MODES: readonly {label: string; patch: SandboxSettingsPatch}[] = [
  {label: 'Sandbox commands, with auto-allow', patch: {enabled: true, autoAllowBashIfSandboxed: true}},
  {label: 'Sandbox commands, with regular permissions', patch: {enabled: true, autoAllowBashIfSandboxed: false}},
  {label: 'No sandbox', patch: {enabled: false, autoAllowBashIfSandboxed: false}},
];
export function activeSandboxMode(sandbox: PermissionSettingsSnapshot['sandbox']): number {
  return !sandbox.enabled ? 2 : sandbox.autoAllowBashIfSandboxed ? 0 : 1;
}

export function dependencyRows(report: import('@cosmew/contracts').SandboxDependenciesReport): string[] {
  const missing = report.items.filter(item => !item.ok).map(item => item.name);
  return [
    ...report.items.map(item => `${item.name}: ${item.ok ? 'ok' : 'missing'}${item.detail ? ` · ${item.detail}` : ''}`),
    ...(missing.length
      ? [`Sandbox dependencies not available: ${missing.join(', ')}`]
      : report.items.length
        ? ['All sandbox dependencies available.']
        : [`Sandbox dependencies unavailable on ${report.platform}.`]),
  ];
}
