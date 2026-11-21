import {
  accountSchema,
  modelSchema,
  providerSchema,
  type SessionSummary,
  type SubagentSummaryView,
} from '@cosmew/contracts';
import type {FutrynBackendPorts} from '@cosmew/sdk';
import {createClientFixture} from '../../testing';
export const provider = providerSchema.parse({
  id: 'sample',
  name: 'Sample API',
  baseURL: 'https://api.example.test/v1',
  protocol: 'chat',
  auth: 'api-key',
  catalog: 'openai',
  metadataVersion: 1,
});
export const account = accountSchema.parse({
  id: '11111111-1111-4111-8111-111111111111',
  providerId: provider.id,
  alias: 'Personal',
  credential: {kind: 'none'},
  status: 'valid',
  validatedAt: null,
});
export const model = modelSchema.parse({
  id: 'sample-model',
  name: 'Sample Model',
  capabilities: {tools: 'supported', text: 'supported'},
  reasoningEfforts: ['low', 'high'],
  contextLimit: 100000,
  outputLimit: null,
  pricing: null,
  source: 'provider',
  fetchedAt: new Date().toISOString(),
  metadataSource: null,
  metadataFetchedAt: null,
});
export const selection = {accountId: account.id, modelId: model.id};
export const session: SessionSummary = {
  id: '22222222-2222-4222-8222-222222222222',
  title: 'Fix rendering',
  selection,
  revision: 1,
  messageCount: 1,
  lastState: 'committed',
  preview: 'Resize correctly',
};
export const child: SubagentSummaryView = {
  id: 'child-1',
  parentConversationId: session.id,
  parentTurnId: null,
  callId: 'call-1',
  depth: 1,
  agentType: 'explore',
  description: 'Inspect rendering',
  selection,
  forkContext: false,
  background: true,
  status: 'running',
  toolCount: 1,
  usage: null,
  createdAt: new Date().toISOString(),
  finishedAt: null,
  steps: [{kind: 'text', text: 'Found layout issue'}],
  summary: '',
};
export function dialogFixture(overrides: Partial<FutrynBackendPorts> = {}) {
  const fixture = createClientFixture({
    listProviders: () => [provider],
    listProviderPresets: () => [provider],
    listAccounts: () => [account],
    getAccount: () => account,
    resolveSelection: () => selection,
    cachedModels: () => [model],
    listIntegrations: () => [
      {provider, notice: '', methods: [{id: 'api-key', name: 'API key', description: 'Secure key'}]},
    ],
    ...overrides,
  });
  fixture.settings.providers = [provider];
  fixture.settings.accounts = [account];
  fixture.settings.activeAccountId = account.id;
  fixture.client.setToolsEnabled(true);
  return fixture;
}
