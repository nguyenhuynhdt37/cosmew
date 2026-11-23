import type {AuthMethod, ModelInfo, Provider, ProviderAuthChallenge} from '@cosmew/contracts';

export type ConnectStep =
  | 'provider'
  | 'method'
  | 'secret'
  | 'env'
  | 'custom-quick'
  | 'custom-key'
  | 'custom-models'
  | 'custom-model'
  | 'custom-id'
  | 'url'
  | 'protocol'
  | 'auth'
  | 'catalog'
  | 'manual'
  | 'headers'
  | 'accounts'
  | 'actions'
  | 'rename'
  | 'confirm'
  | 'busy'
  | 'oauth';
export interface ConnectProviderState {
  selectedIndex: number;
  showAdvanced?: boolean;
  query: string;
  scrollOffset?: number;
  step: ConnectStep;
  aliasDraft: string;
  secretDraft: string;
  draft: string;
  providerId?: string;
  providerLabel?: string;
  accountId?: string;
  method?: AuthMethod['id'];
  custom?: Partial<Provider>;
  customModelId?: string;
  quickUrl?: string;
  quickModels?: readonly ModelInfo[];
  authChallenge?: ProviderAuthChallenge;
  pendingAction?: 'logout' | 'remove' | 'switch';
  switchOnly?: boolean;
  logoutOnly?: boolean;
  statusMessage?: string;
}
export function createInitialConnectProviderState(): ConnectProviderState {
  return {selectedIndex: 0, query: '', step: 'provider', aliasDraft: '', secretDraft: '', draft: ''};
}
