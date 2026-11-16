import {FutrynError, modelIdSchema, providerSchema, type Provider} from '@futryn/contracts';
import type {AccountWorkflow, OverlayFeature, OverlayLayout, ThemeFrame, TuiHost} from '../../core/feature';
import {wideLayout} from '../../core/layout';
import {stepIndex} from '../../ui';
import {CONTROL_CHARS, ENV_NAME, PROVIDER_ID, connectionChoices, describeProviderError} from './logic';
import {createInitialConnectProviderState, type ConnectProviderState} from './types';
import {renderConnectProviderOverlay} from './view';

/**
 * Sign-in, account management, account switching and sign-out. Owns the long-running
 * authentication and switch tasks so shutdown can cancel and drain them.
 */
export class ConnectFeature implements OverlayFeature, AccountWorkflow {
  readonly overlays = ['connect'] as const;
  private state: ConnectProviderState = createInitialConnectProviderState();
  private authAbort: AbortController | null = null;
  private authTask: Promise<void> | null = null;
  private switchAbort: AbortController | null = null;
  private switchTask: Promise<boolean> | null = null;

  constructor(private readonly host: TuiHost) {}

  get switching(): boolean {
    return this.switchAbort !== null;
  }

  open(): void {
    this.state = createInitialConnectProviderState();
  }

  /** Leaving the dialog abandons any in-flight sign-in and wipes the typed secret. */
  close(): void {
    this.authAbort?.abort();
    if (this.state.authChallenge) void this.host.client.cancelProviderAuth(this.state.authChallenge.id);
    this.state.secretDraft = '';
  }

  layout(_overlay: 'connect', cols: number, rows: number): OverlayLayout {
    return {...wideLayout(cols, rows, true), width: Math.min(cols - 2, 68)};
  }

  render(_overlay: 'connect', size: {width: number; height: number}, theme: ThemeFrame) {
    const {client} = this.host;
    return renderConnectProviderOverlay({
      ...size,
      integrations: client.listIntegrations(),
      accounts: client.listAccounts(),
      activeAccountId: client.status().activeAccount?.id ?? null,
      state: this.state,
      tokens: theme.tokens,
      borderStyle: theme.borderStyle,
    });
  }

  /** Ctrl+C: cancel the switch or sign-in and close. */
  interrupt(): boolean {
    if (this.switchAbort) {
      this.switchAbort.abort();
      this.state.statusMessage = 'Cancelling account switch…';
      return true;
    }
    this.authAbort?.abort();
    this.state.secretDraft = '';
    this.host.openOverlay('none');
    this.host.setBanner('Authentication cancelled.');
    return true;
  }

  async shutdown(): Promise<void> {
    this.switchAbort?.abort();
    this.authAbort?.abort();
    if (this.state.authChallenge) await this.host.client.cancelProviderAuth(this.state.authChallenge.id);
    this.state.secretDraft = '';
    await Promise.allSettled([this.authTask, this.switchTask]);
  }

  private describe(error: unknown, providerId?: string): string {
    return describeProviderError(this.host.client, error, providerId ?? this.state.providerId);
  }

  // ---- entry points used by slash commands ---------------------------------------------

  /** `/switch [account]` */
  beginSwitch(args: string): void {
    const {host} = this;
    const accounts = host.client.listAccounts();
    if (!accounts.length) {
      host.setBanner('No connected accounts. Use /login.');
      return;
    }
    const target = args
      ? /^\d+$/.test(args)
        ? accounts[Number(args) - 1]
        : accounts.find(a => a.id === args || a.alias === args)
      : null;
    if (args && !target) {
      host.setBanner('Account not found. Use /login to manage accounts.');
      return;
    }
    const activeId = host.client.status().activeAccount?.id;
    if (target?.id === activeId) {
      host.setBanner(`Already using ${target!.alias}.`);
      return;
    }
    if (!target && accounts.every(account => account.id === activeId)) {
      host.setBanner('Only the current account is connected. Use /login to add another.');
      return;
    }
    host.openOverlay('connect');
    this.state = {
      ...createInitialConnectProviderState(),
      step: target ? 'confirm' : 'accounts',
      switchOnly: true,
      accountId: target?.id,
      providerLabel: target?.alias,
      pendingAction: 'switch',
      selectedIndex: target
        ? 0
        : Math.max(
            0,
            accounts.findIndex(a => a.id !== activeId),
          ),
    };
  }

  /** `/logout [account]` */
  beginLogout(args: string): void {
    const {host} = this;
    const accounts = host.client.listAccounts().filter(a => !args || a.id === args || a.alias === args);
    if (!accounts.length) {
      host.setBanner('No accounts to sign out.');
      return;
    }
    host.openOverlay('connect');
    this.state = {
      ...createInitialConnectProviderState(),
      step: 'accounts',
      logoutOnly: true,
      selectedIndex: Math.max(
        0,
        accounts.findIndex(a => a.id === host.client.status().activeAccount?.id),
      ),
    };
    if (accounts.length === 1) {
      this.state = {
        ...this.state,
        step: 'confirm',
        accountId: accounts[0]!.id,
        providerLabel: accounts[0]!.alias,
        pendingAction: 'logout',
        selectedIndex: 0,
      };
    }
  }

  /** `/accounts [filter]` */
  beginAccounts(query: string): void {
    this.host.openOverlay('connect');
    this.state.step = 'accounts';
    this.state.query = query;
  }

  // ---- account switching ---------------------------------------------------------------

  async continueWithAccount(id: string, modelId?: string): Promise<boolean> {
    const {host} = this;
    if (host.client.status().activeAccount?.id === id) {
      host.openOverlay('none');
      host.setBanner('This account is already active.');
      return false;
    }
    const task = this.runAccountSwitch(id, modelId);
    this.switchTask = task;
    try {
      return await task;
    } finally {
      if (this.switchTask === task) this.switchTask = null;
    }
  }

  private async runAccountSwitch(id: string, modelId?: string): Promise<boolean> {
    const {host} = this;
    const abort = new AbortController();
    this.switchAbort = abort;
    const alias = host.client.listAccounts().find(a => a.id === id)?.alias ?? 'account';
    const alreadyUsing = host.client.activeSession()?.selection.accountId === id;
    host.openOverlay('connect');
    this.state = {
      ...createInitialConnectProviderState(),
      step: 'busy',
      switchOnly: true,
      pendingAction: 'switch',
      accountId: id,
      providerLabel: alias,
      statusMessage: 'Loading models for the selected account…',
    };
    try {
      const account = await host.client.switchAccount(id, true, modelId, abort.signal);
      host.syncTranscript();
      host.openOverlay('none');
      host.setBanner(
        alreadyUsing
          ? `Already using ${account.alias}.`
          : host.client.activeSession()?.messages.length
            ? `Using ${account.alias}. Continued in a new account-bound session; original history retained.`
            : `Using ${account.alias}. Ready to chat.`,
      );
      return true;
    } catch (error) {
      if (abort.signal.aborted) {
        host.openOverlay('none');
        host.setBanner('Account switch cancelled; current account and history preserved.');
      } else if (error instanceof FutrynError && error.code === 'NOT_FOUND' && host.client.cachedModels(id).length) {
        host.openOverlay('models');
        host.features.models.awaitModelForAccount(
          id,
          'Choose a model for the new account. Current account stays active until you confirm.',
        );
      } else if (error instanceof FutrynError && error.code === 'AUTH') {
        const account = host.client.listAccounts().find(a => a.id === id);
        this.state = {
          ...createInitialConnectProviderState(),
          step: 'method',
          pendingAction: 'switch',
          accountId: id,
          providerId: account?.providerId,
          providerLabel: alias,
          statusMessage:
            'This account needs sign-in. Sign in again to reconnect this profile, then choose it to continue your chat.',
        };
      } else {
        this.state = {
          ...createInitialConnectProviderState(),
          step: 'confirm',
          switchOnly: true,
          pendingAction: 'switch',
          accountId: id,
          providerLabel: alias,
          statusMessage: this.describe(error, host.client.listAccounts().find(a => a.id === id)?.providerId),
        };
      }
      return false;
    } finally {
      if (this.switchAbort === abort) this.switchAbort = null;
    }
  }

  private async signOutAccount(id: string): Promise<void> {
    const {host} = this;
    const alias = host.client.listAccounts().find(account => account.id === id)?.alias ?? 'account';
    const wasActive = host.client.status().activeAccount?.id === id;
    await host.client.logoutAccount(id);
    host.syncTranscript();
    host.openOverlay('none');
    host.setBanner(`Signed out of ${alias}.`);
    if (wasActive) {
      const next = host.client.listAccounts().find(a => a.status !== 'logged-out' && a.status !== 'invalid');
      if (next) {
        const switched = await this.continueWithAccount(next.id);
        if (switched)
          host.setBanner(
            `Signed out of ${alias}. Using ${next.alias} with ${host.client.status().selection!.modelId}. New chat ready.`,
          );
      }
    }
  }

  // ---- keys ----------------------------------------------------------------------------

  async handleKey(_overlay: 'connect', key: string): Promise<void> {
    const {host} = this;
    const {client} = host;
    const st = this.state;
    if (st.authChallenge && (key === 'PageDown' || key === 'PageUp')) {
      st.scrollOffset = Math.max(0, Math.min(40, (st.scrollOffset ?? 0) + (key === 'PageDown' ? 1 : -1)));
      return;
    }
    if (st.step === 'busy' && this.switchAbort) {
      if (key === 'Escape' || key === 'Ctrl+C') {
        this.switchAbort?.abort();
        st.statusMessage = 'Cancelling account switch…';
      }
      return;
    }
    if (st.step === 'busy') {
      if (key === 'Escape' || key === 'Ctrl+C') {
        this.authAbort?.abort();
        host.openOverlay('none');
        host.setBanner('Authentication cancelled. Current account and history preserved.');
      }
      return;
    }
    if (key === 'Escape') {
      this.state.secretDraft = '';
      if (st.authChallenge) await client.cancelProviderAuth(st.authChallenge.id);
      if (
        st.pendingAction === 'switch' ||
        st.step === 'provider' ||
        st.step === 'accounts' ||
        ((st.logoutOnly || st.switchOnly) && st.step === 'confirm')
      )
        host.openOverlay('none');
      else if (st.step === 'actions' || st.step === 'confirm' || st.step === 'rename')
        this.state = {...st, step: 'accounts', query: '', selectedIndex: 0, secretDraft: ''};
      else this.state = createInitialConnectProviderState();
      return;
    }
    if (key === 'Ctrl+A' && !st.logoutOnly && !st.switchOnly && (st.step === 'provider' || st.step === 'accounts')) {
      this.state = {...createInitialConnectProviderState(), step: st.step === 'provider' ? 'accounts' : 'provider'};
      return;
    }
    const choices = connectionChoices(
      st,
      client.listIntegrations(),
      client.listAccounts(),
      client.status().activeAccount?.id,
    );
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      for (let count = 0; count < choices.length; count++) {
        st.selectedIndex = stepIndex(st.selectedIndex, key, choices.length);
        if (!choices[st.selectedIndex]?.disabled) break;
      }
      return;
    }
    if (key === 'Enter') {
      await this.activate(st, choices);
      return;
    }

    const field =
      st.step === 'provider' || st.step === 'accounts'
        ? 'query'
        : st.step === 'secret' || st.step === 'oauth'
          ? 'secretDraft'
          : 'draft';
    if (choices.length && st.step !== 'provider' && st.step !== 'accounts') return;
    if (key === 'Backspace') st[field] = st[field].slice(0, -1);
    else if (key.length === 1 && !CONTROL_CHARS.test(key))
      st[field] = (st[field] + key).slice(0, field === 'secretDraft' ? 8192 : 2048);
    if (field === 'query') st.selectedIndex = 0;
  }

  /** Enter: advance the wizard one step. */
  private async activate(st: ConnectProviderState, choices: ReturnType<typeof connectionChoices>): Promise<void> {
    const {host} = this;
    const {client} = host;
    const chosen = choices[st.selectedIndex];
    if (chosen?.disabled) {
      st.statusMessage = 'This account is already active.';
      return;
    }
    const next = (step: ConnectProviderState['step'], draft = '') => {
      this.state = {...st, step, draft, selectedIndex: 0, statusMessage: undefined};
    };
    try {
      if (st.step === 'provider' && chosen) {
        if (chosen.id === '__custom') {
          next('custom-id');
          this.state.custom = {};
        } else {
          st.providerId = chosen.id;
          st.providerLabel = client.listIntegrations().find(i => i.provider.id === chosen.id)?.provider.name;
          st.accountId = undefined;
          next('method');
        }
      } else if (st.step === 'method' && chosen) {
        if (chosen.id === '__advanced') {
          st.showAdvanced = !st.showAdvanced;
          st.selectedIndex = 0;
          return;
        }
        const method = client
          .listIntegrations()
          .find(i => (i.providerIds ?? [i.provider.id]).includes(st.providerId!))
          ?.methods.find(m => m.id === chosen.id);
        if (method?.available === false) {
          st.statusMessage = method.diagnostic ?? 'Install the official runtime and retry.';
          return;
        }
        st.method = chosen.id as ConnectProviderState['method'];
        st.providerId = method?.providerId ?? st.providerId;
        st.authChallenge = undefined;
        const baseAlias = st.providerId!.slice(0, 90);
        const accounts = client.listAccounts();
        let alias = baseAlias;
        let suffix = 2;
        while (accounts.some(account => account.alias === alias)) alias = `${baseAlias}-${suffix++}`;
        st.aliasDraft = st.accountId ? accounts.find(account => account.id === st.accountId)!.alias : alias;
        if (st.method === 'subscription-browser' || st.method === 'subscription-device') {
          this.startProviderSignIn(st);
        } else if (st.method === 'openrouter-oauth') {
          this.startProviderSignIn(st);
        } else if (st.method === 'none') this.startConnectionAuthentication(st);
        else next(st.method === 'env' ? 'env' : 'secret');
      } else if (st.step === 'secret' || st.step === 'env' || st.step === 'oauth') {
        if (!(st.step === 'secret' || st.step === 'oauth' ? st.secretDraft : st.draft).trim()) {
          st.statusMessage = 'A credential or variable name is required.';
          return;
        }
        if (st.step === 'env' && !ENV_NAME.test(st.draft)) {
          st.statusMessage = 'Enter the environment variable NAME, not its value.';
          return;
        }
        this.startConnectionAuthentication(st);
      } else if (st.step === 'custom-id') {
        if (!PROVIDER_ID.test(st.draft)) {
          st.statusMessage = 'Use a provider ID with letters, numbers, dots or dashes.';
          return;
        }
        st.custom = {id: st.draft, name: st.draft};
        next('url');
      } else if (st.step === 'url') {
        // The backend validates scheme, host, URL credentials, query and hash before saving.
        const u = new URL(st.draft);
        if (u.username || u.password || u.search || u.hash || !['http:', 'https:'].includes(u.protocol)) {
          st.statusMessage = 'Use a base URL without credentials, query or fragment.';
          return;
        }
        st.custom = {...st.custom, baseURL: st.draft};
        next('protocol');
      } else if (st.step === 'protocol' && chosen) {
        st.custom = {...st.custom, protocol: chosen.id as Provider['protocol']};
        next('auth');
      } else if (st.step === 'auth' && chosen) {
        st.custom = {...st.custom, auth: chosen.id as Provider['auth']};
        next('catalog');
      } else if (st.step === 'catalog' && chosen) {
        st.custom = {...st.custom, catalog: chosen.id as Provider['catalog']};
        if (chosen.id === 'manual') next('manual');
        else this.saveCustomProvider(st);
      } else if (st.step === 'manual') {
        modelIdSchema.parse(st.draft);
        st.customModelId = st.draft;
        this.saveCustomProvider(st);
      } else if (st.step === 'accounts' && chosen) {
        if (st.logoutOnly || st.switchOnly) {
          st.accountId = chosen.id;
          st.providerLabel = client.listAccounts().find(a => a.id === chosen.id)?.alias;
          st.pendingAction = st.switchOnly ? 'switch' : 'logout';
          next('confirm');
          return;
        }
        st.accountId = chosen.id;
        st.providerId = client.listAccounts().find(a => a.id === chosen.id)!.providerId;
        next('actions');
      } else if (st.step === 'actions' && chosen) {
        if (chosen.id === 'switch') {
          if (client.activeSession()?.messages.length) {
            st.providerLabel = client.listAccounts().find(account => account.id === st.accountId)?.alias;
            st.pendingAction = 'switch';
            st.switchOnly = true;
            next('confirm');
          } else {
            client.useAccount(st.accountId!);
            host.syncTranscript();
            host.openOverlay('models');
          }
        } else if (chosen.id === 'add') {
          st.accountId = undefined;
          next('method');
        } else if (chosen.id === 'rename') next('rename');
        else if (chosen.id === 'reconnect') next('method');
        else {
          st.pendingAction = chosen.id as 'logout' | 'remove';
          next('confirm');
        }
      } else if (st.step === 'rename') {
        client.renameAccount(st.accountId!, st.draft.trim());
        next('accounts');
        this.state.query = '';
        this.state.statusMessage = 'Account renamed.';
      } else if (st.step === 'confirm' && chosen) {
        if (chosen.id === 'confirm' && st.switchOnly) {
          await this.continueWithAccount(st.accountId!);
          return;
        }
        if (chosen.id === 'confirm' && (st.logoutOnly || st.pendingAction === 'logout')) {
          await this.signOutAccount(st.accountId!);
          return;
        }
        if (chosen.id === 'cancel' && (st.logoutOnly || st.switchOnly)) {
          host.openOverlay('none');
          return;
        }
        if (chosen.id === 'confirm') {
          await client.logoutAccount(st.accountId!, true);
          host.syncTranscript();
        }
        this.state = {
          ...createInitialConnectProviderState(),
          step: 'accounts',
          statusMessage:
            chosen.id === 'confirm'
              ? 'Local credential removed. Revoke remote API keys in the provider console; shell environment values remain in your shell.'
              : 'Cancelled.',
        };
      }
    } catch (error) {
      st.secretDraft = '';
      st.statusMessage = this.describe(error);
    }
  }

  private saveCustomProvider(st: ConnectProviderState): void {
    const provider = providerSchema.parse({...st.custom, metadataVersion: 1, timeoutMs: 60000});
    this.host.client.addProvider(provider);
    this.state = {
      ...st,
      providerId: provider.id,
      providerLabel: provider.name,
      step: 'method',
      selectedIndex: 0,
      draft: '',
      statusMessage: 'Endpoint saved. Choose authentication.',
    };
  }

  // ---- background authentication -------------------------------------------------------

  private startProviderSignIn(st: ConnectProviderState): void {
    if (this.authAbort) {
      st.statusMessage = 'Previous authentication is still cancelling. Please wait.';
      return;
    }
    const {host} = this;
    const controller = new AbortController();
    this.authAbort = controller;
    const starting = (this.state = {...st, step: 'busy', statusMessage: 'Opening sign-in…'});
    this.authTask = (async () => {
      try {
        const challenge = await host.client.beginProviderAuth(st.providerId!, st.method, controller.signal);
        if (controller.signal.aborted || host.overlay !== 'connect' || this.state !== starting) {
          await host.client.cancelProviderAuth(challenge.id);
          return;
        }
        this.authAbort = null;
        this.state = {...st, step: 'oauth', authChallenge: challenge};
        if (challenge.autoComplete) await this.authenticate(this.state);
      } catch (error) {
        if (host.overlay === 'connect' && this.state === starting)
          this.state = {...st, step: 'method', statusMessage: this.describe(error, st.providerId)};
      } finally {
        if (this.authAbort === controller) this.authAbort = null;
      }
    })();
  }

  private startConnectionAuthentication(st: ConnectProviderState): void {
    if (this.authAbort) {
      st.statusMessage = 'Previous authentication is still cancelling. Please wait.';
      return;
    }
    this.authTask = this.authenticate(st);
  }

  private async authenticate(st: ConnectProviderState): Promise<void> {
    if (this.authAbort) {
      st.statusMessage = 'Previous authentication is still cancelling. Please wait.';
      return;
    }
    const {host} = this;
    const {client} = host;
    const controller = new AbortController();
    this.authAbort = controller;
    const secret = st.secretDraft;
    st.secretDraft = '';
    this.state = {...st, step: 'busy', secretDraft: '', statusMessage: 'Validating connectivity. Esc cancels.'};
    const busyState = this.state;
    const progressTimer = st.authChallenge?.autoComplete
      ? setInterval(() => {
          try {
            const progress = client.providerAuthProgress(st.authChallenge!.id);
            if (this.state === busyState && busyState.authChallenge) {
              if (progress.authorizationURL) busyState.authChallenge.authorizationURL = progress.authorizationURL;
              busyState.authChallenge.userCode = progress.userCode;
              busyState.statusMessage = progress.message ?? 'Waiting for provider sign-in. Esc cancels.';
            }
          } catch {
            /* Completion may consume the challenge before the final UI update. */
          }
        }, 150)
      : null;
    try {
      const account = await client.connectAccount(
        {
          providerId: st.providerId!,
          alias: st.aliasDraft.trim(),
          credential:
            st.method === 'none'
              ? {kind: 'none'}
              : st.method === 'env'
                ? {kind: 'env', name: st.draft}
                : {kind: 'keyring', key: crypto.randomUUID()},
          secret: st.method === 'api-key' ? secret : undefined,
          reauthenticateAccountId: st.accountId,
          manualModelId: st.customModelId,
          authChallengeId: st.authChallenge?.id,
          authorizationCode: st.method === 'openrouter-oauth' ? secret : undefined,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (st.pendingAction === 'switch') {
        await this.continueWithAccount(account.id);
        return;
      }
      host.syncTranscript();
      host.openOverlay('models');
      host.setBanner(`Connected ${account.alias}. Choose a model to chat.`);
    } catch (error) {
      if (host.overlay === 'connect' && this.state === busyState)
        this.state = {
          ...st,
          authChallenge: undefined,
          step: st.method === 'api-key' ? 'secret' : st.method === 'env' ? 'env' : 'method',
          secretDraft: '',
          selectedIndex: 0,
          statusMessage: this.describe(error, st.providerId),
        };
    } finally {
      if (progressTimer) clearInterval(progressTimer);
      this.authAbort = null;
    }
  }
}
