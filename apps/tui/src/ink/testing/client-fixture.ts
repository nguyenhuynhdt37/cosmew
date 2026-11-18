import {emptySettings, FutrynError} from '@futryn/contracts';
import {FutrynClient, type FutrynBackendPorts} from '@futryn/sdk';
/** Real SDK over hermetic ports. Unsupported operations throw; no provider/OS compatibility claims. */
export function createClientFixture(overrides: Partial<FutrynBackendPorts> = {}) {
  const state = emptySettings();
  const unavailable = (): never => {
    throw new FutrynError('UNSUPPORTED');
  };
  const ports: FutrynBackendPorts = {
    workspace: '/fixture',
    settings: {read: () => structuredClone(state), update: change => change(state)},
    listProviders: () => [],
    listProviderPresets: () => [],
    addProvider: unavailable,
    removeProvider: unavailable,
    listAccounts: () => [],
    getAccount: unavailable,
    addAccount: unavailable,
    reauthenticateAccount: unavailable,
    useAccount: unavailable,
    renameAccount: unavailable,
    logoutAccount: unavailable,
    validateAccount: unavailable,
    discoverModels: unavailable,
    cachedModels: () => [],
    addManualModel: unavailable,
    selectModel: unavailable,
    resolveSelection: () => null,
    listSessions: () => [],
    getSession: () => undefined,
    deleteSession: unavailable,
    startSession: unavailable,
    resumeSession: unavailable,
    async *sendTurn() {
      unavailable();
    },
    loadCustomThemes: () => ({themes: [], errors: []}),
    saveCustomTheme: unavailable,
    removeCustomTheme: unavailable,
    listWorkspaceFiles: unavailable,
    getWorkspaceDiff: unavailable,
    sanitizeText: text => text,
    ...overrides,
  };
  return {client: new FutrynClient(ports), ports, settings: state};
}
export type ClientFixture = ReturnType<typeof createClientFixture>;
