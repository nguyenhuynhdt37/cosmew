/** @jsxImportSource react */
import {useEffect, useRef, useState} from 'react';
import {
  FutrynError,
  isCodingModel,
  providerSchema,
  modelIdSchema,
  type Provider,
  type ProviderAuthChallenge,
} from '@cosmew/contracts';
import type {QuickConnectProviderInput} from '@cosmew/sdk';
import {useFutrynClient, useTextInput} from '../../hooks';
import {useOverlay} from '../../core';
import {TextLine} from '../../ui';
import {Dialog, PickerDialog, TextEntry, useDialogRefresh, useDialogTask, type DialogProps} from '../picker';
import {ModelsDialog, modelLimitsLabel} from '../models';
import {
  connectionChoices,
  describeProviderError,
  ENV_NAME,
  PROVIDER_ID,
  isValidCustomBaseURL,
  maskQuickProviderDraft,
  parseHeaderDraft,
} from './logic';
import {createInitialConnectProviderState, type ConnectProviderState, type ConnectStep} from './types';
export {connectionChoices, describeProviderError, maskQuickProviderDraft, parseHeaderDraft} from './logic';
export interface ConnectDialogProps extends DialogProps {
  initialStep?: 'provider' | 'accounts';
  accountId?: string;
  action?: 'switch' | 'logout';
  initialQuery?: string;
  onChanged?: () => void;
  onOnboardingDone?: () => void;
  isStreaming?: boolean;
}
export function ConnectDialog({
  initialStep = 'provider',
  accountId,
  action,
  initialQuery = '',
  onChanged,
  onOnboardingDone,
  isStreaming = false,
  ...props
}: ConnectDialogProps) {
  const client = useFutrynClient();
  const router = useOverlay();
  useDialogRefresh();
  const task = useDialogTask();
  const [state, setState] = useState<ConnectProviderState>(() => ({
    ...createInitialConnectProviderState(),
    providerId: client.listAccounts().find(a => a.id === accountId)?.providerId,
    providerLabel: client.listAccounts().find(a => a.id === accountId)?.alias,
    step: accountId && action ? 'confirm' : initialStep,
    accountId,
    pendingAction: action,
    switchOnly: action === 'switch',
    logoutOnly: action === 'logout',
    query: initialQuery,
  }));
  const challengeRef = useRef<ProviderAuthChallenge | null>(null);
  const chooseQuickModel = useRef<((id: string) => void) | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      const challenge = challengeRef.current;
      if (challenge) void client.cancelProviderAuth(challenge.id).catch(() => {});
      challengeRef.current = null;
    };
  }, [client]);
  const next = (step: ConnectStep, patch: Partial<ConnectProviderState> = {}) =>
    setState(s => ({...s, step, draft: '', secretDraft: '', query: '', ...patch}));
  const models = (id?: string) => {
    onChanged?.();
    router.open('models', <ModelsDialog {...props} accountId={id} onChanged={onChanged} />);
  };
  const aliasFor = (providerId: string) => {
    const accounts = client.listAccounts();
    let alias = providerId.slice(0, 90);
    let suffix = 2;
    while (accounts.some(a => a.alias === alias)) alias = `${providerId.slice(0, 90)}-${suffix++}`;
    return alias;
  };
  const authenticate = async (
    s: ConnectProviderState,
    secret: string,
    signal: AbortSignal,
    challenge = s.authChallenge,
  ) => {
    next('busy', {statusMessage: 'Validating connectivity. Esc cancels.', authChallenge: challenge});
    try {
      const account = await client.connectAccount(
        {
          providerId: s.providerId!,
          alias: s.aliasDraft || aliasFor(s.providerId!),
          credential:
            s.method === 'none'
              ? {kind: 'none'}
              : s.method === 'env'
                ? {kind: 'env', name: secret}
                : {kind: 'keyring', key: crypto.randomUUID()},
          secret: s.method === 'api-key' ? secret : undefined,
          reauthenticateAccountId: s.accountId,
          manualModelId: s.customModelId,
          authChallengeId: challenge?.id,
          authorizationCode: s.method === 'openrouter-oauth' ? secret : undefined,
        },
        signal,
      );
      challengeRef.current = null;
      if (signal.aborted || !live.current) return;
      if (onOnboardingDone) onOnboardingDone();
      else if (s.pendingAction === 'switch') {
        await client.switchAccount(account.id, true, undefined, signal);
        if (signal.aborted) return;
        onChanged?.();
        router.close();
      } else models();
    } catch (error) {
      if (challenge) await client.cancelProviderAuth(challenge.id).catch(() => {});
      challengeRef.current = null;
      if (signal.aborted || !live.current) return;
      next(s.method === 'api-key' ? 'secret' : s.method === 'env' ? 'env' : 'method', {
        authChallenge: undefined,
        statusMessage: describeProviderError(client, error, s.providerId),
      });
    }
  };
  useEffect(() => {
    if (!state.authChallenge?.autoComplete || state.step !== 'busy') return;
    const id = state.authChallenge.id;
    const timer = setInterval(() => {
      try {
        const progress = client.providerAuthProgress(id);
        setState(s => {
          if (s.step !== 'busy' || s.authChallenge?.id !== id) return s;
          const authorizationURL = progress.authorizationURL ?? s.authChallenge.authorizationURL;
          const message = progress.message ?? s.statusMessage;
          if (
            message === s.statusMessage &&
            authorizationURL === s.authChallenge.authorizationURL &&
            progress.userCode === s.authChallenge.userCode
          )
            return s;
          return {
            ...s,
            statusMessage: message,
            authChallenge: {
              ...s.authChallenge,
              authorizationURL,
              userCode: progress.userCode,
            },
          };
        });
      } catch {
        /* Challenge may have been consumed. */
      }
    }, 250);
    return () => clearInterval(timer);
  }, [client, state.authChallenge?.id, state.authChallenge?.autoComplete, state.step]);
  const execute = (work: (signal: AbortSignal) => Promise<void> | void) =>
    void task.run(async signal => {
      if (isStreaming) {
        task.setMessage('Cancel the active response before changing accounts.');
        return;
      }
      try {
        await work(signal);
      } catch (error) {
        if (!signal.aborted && live.current) {
          task.setMessage(describeProviderError(client, error, state.providerId));
          setState(s => (s.step === 'busy' ? {...s, step: s.pendingAction === 'switch' ? 'confirm' : 'method'} : s));
        }
      }
    });
  const runQuickConnect = async (input: QuickConnectProviderInput, signal: AbortSignal) => {
    const savedUrl = input.baseURL ?? input.raw?.split('|')[0]?.trim();
    next('busy', {
      statusMessage: 'Loading models… Esc cancels.',
      quickUrl: savedUrl,
    });
    try {
      await client.quickConnectProvider(
        {
          ...input,
          chooseModel: discovered =>
            new Promise<string>((resolve, reject) => {
              if (signal.aborted) return reject(new FutrynError('CANCELLED'));
              const abort = () => {
                chooseQuickModel.current = null;
                reject(new FutrynError('CANCELLED'));
              };
              signal.addEventListener('abort', abort, {once: true});
              chooseQuickModel.current = id => {
                signal.removeEventListener('abort', abort);
                chooseQuickModel.current = null;
                next('busy', {statusMessage: `Testing ${id}… Esc cancels.`, quickModels: undefined});
                resolve(id);
              };
              const entries = discovered.filter(model => isCodingModel(model));
              next(entries.length ? 'custom-models' : 'custom-model', {
                quickModels: entries,
                statusMessage: entries.length ? undefined : 'Enter the model ID from your gateway.',
              });
            }),
        },
        signal,
      );
      if (signal.aborted || !live.current) return;
      if (onOnboardingDone) onOnboardingDone();
      else {
        onChanged?.();
        router.close();
      }
    } catch (error) {
      if (signal.aborted || !live.current) return;
      const retryKey = error instanceof FutrynError && ['AUTH', 'FORBIDDEN'].includes(error.code);
      next(retryKey && savedUrl ? 'custom-key' : 'custom-quick', {
        quickUrl: savedUrl,
        quickModels: undefined,
        statusMessage: describeProviderError(client, error, undefined),
      });
    }
  };
  useTextInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.ctrl && input === 'a' && !task.busy && (state.step === 'provider' || state.step === 'accounts'))
      next(state.step === 'provider' ? 'accounts' : 'provider', {accountId: undefined, providerId: undefined});
    if (key.tab && !task.busy && state.step === 'custom-quick')
      next('custom-id', {custom: {}, accountId: undefined, quickUrl: undefined});
  });
  const activate = (id: string) =>
    execute(async signal => {
      const st = state;
      if (st.step === 'provider') {
        if (id === '__skip-onboarding' && onOnboardingDone) onOnboardingDone();
        else if (id === '__custom') next('custom-quick', {custom: {}, accountId: undefined, quickUrl: undefined});
        else
          next('method', {
            providerId: id,
            providerLabel: client.listIntegrations().find(i => i.provider.id === id)?.provider.name,
            accountId: undefined,
          });
      } else if (st.step === 'method') {
        if (id === '__advanced') {
          setState(s => ({...s, showAdvanced: !s.showAdvanced}));
          return;
        }
        const method = client
          .listIntegrations()
          .find(i => (i.providerIds ?? [i.provider.id]).includes(st.providerId!))
          ?.methods.find(m => m.id === id);
        if (!method) return;
        if (method.available === false) {
          task.setMessage(method.diagnostic ?? 'Authentication unavailable.');
          return;
        }
        const providerId = method.providerId ?? st.providerId!;
        const s = {
          ...st,
          providerId,
          method: method.id,
          aliasDraft: st.accountId
            ? client.listAccounts().find(a => a.id === st.accountId)!.alias
            : aliasFor(providerId),
        };
        setState(s);
        if (method.id === 'oauth-browser' || method.id === 'openrouter-oauth') {
          next('busy', {statusMessage: 'Opening sign-in…'});
          const challenge = await client.beginProviderAuth(providerId, method.id, signal);
          if (signal.aborted || !live.current) {
            await client.cancelProviderAuth(challenge.id);
            return;
          }
          challengeRef.current = challenge;
          setState({...s, step: 'oauth', authChallenge: challenge});
          if (challenge.autoComplete) await authenticate(s, '', signal, challenge);
        } else if (method.id === 'none') await authenticate(s, '', signal);
        else
          next(method.id === 'env' ? 'env' : 'secret', {
            draft: method.id === 'env' ? (client.listProviders().find(p => p.id === providerId)?.envKey ?? '') : '',
          });
      } else if (st.step === 'protocol') next('auth', {custom: {...st.custom, protocol: id as Provider['protocol']}});
      else if (st.step === 'auth') next('catalog', {custom: {...st.custom, auth: id as Provider['auth']}});
      else if (st.step === 'catalog')
        next(id === 'manual' ? 'manual' : 'headers', {custom: {...st.custom, catalog: id as Provider['catalog']}});
      else if (st.step === 'accounts') {
        const account = client.listAccounts().find(a => a.id === id);
        if (!account) return;
        next(st.switchOnly || st.logoutOnly ? 'confirm' : 'actions', {
          accountId: id,
          providerId: account.providerId,
          providerLabel: account.alias,
          pendingAction: st.switchOnly ? 'switch' : st.logoutOnly ? 'logout' : undefined,
        });
      } else if (st.step === 'actions') {
        if (id === 'switch' || id === 'logout' || id === 'remove') next('confirm', {pendingAction: id});
        else if (id === 'rename') next('rename');
        else next('method', {accountId: id === 'add' ? undefined : st.accountId});
      } else if (st.step === 'confirm') {
        if (id === 'cancel') {
          next('accounts');
          return;
        }
        if (st.pendingAction === 'switch') {
          next('busy', {statusMessage: 'Switching account…'});
          try {
            await client.switchAccount(st.accountId!, true, undefined, signal);
            if (!signal.aborted && live.current) {
              onChanged?.();
              router.close();
            }
          } catch (error) {
            if (signal.aborted) return;
            if (client.cachedModels(st.accountId).length) models(st.accountId);
            else {
              next('method', {statusMessage: describeProviderError(client, error, st.providerId)});
            }
          }
        } else {
          const wasActive = client.status().activeAccount?.id === st.accountId;
          await client.logoutAccount(st.accountId!, st.pendingAction === 'remove');
          if (signal.aborted || !live.current) return;
          onChanged?.();
          const fallback = wasActive
            ? client
                .listAccounts()
                .find(a => a.id !== st.accountId && a.status !== 'logged-out' && a.status !== 'invalid')
            : undefined;
          if (fallback) {
            next('busy', {statusMessage: 'Selecting another connected account…'});
            try {
              await client.switchAccount(fallback.id, true, undefined, signal);
              if (!signal.aborted && live.current) {
                onChanged?.();
                router.close();
              }
            } catch (error) {
              if (signal.aborted || !live.current) return;
              if (client.cachedModels(fallback.id).length) models(fallback.id);
              else
                next('accounts', {
                  accountId: undefined,
                  providerId: undefined,
                  statusMessage: describeProviderError(client, error, fallback.providerId),
                });
            }
            return;
          }
          next('accounts', {
            accountId: undefined,
            providerId: undefined,
            statusMessage:
              'Local credential removed. Revoke remote API keys in the provider console; shell environment values remain in your shell.',
          });
        }
      }
    });
  const submit = (value: string) =>
    execute(async signal => {
      const st = state;
      if (st.step === 'secret' || st.step === 'env' || st.step === 'oauth') {
        if (st.step === 'env' && !ENV_NAME.test(value)) {
          task.setMessage('Enter the environment variable NAME, not its value.');
          return;
        }
        await authenticate(st, value, signal);
      } else if (st.step === 'custom-quick') {
        const trimmed = value.trim();
        if (trimmed.includes('|')) {
          const parts = trimmed.split('|');
          if (parts.length > 3 || !isValidCustomBaseURL(parts[0] ?? '')) {
            task.setMessage('Expected "https://host/v1 | api-key | model (optional)".');
            return;
          }
          const modelPart = parts[2]?.trim();
          if (modelPart && !modelIdSchema.safeParse(modelPart).success) {
            task.setMessage('Invalid model ID in third segment.');
            return;
          }
          await runQuickConnect({raw: trimmed}, signal);
        } else {
          if (!isValidCustomBaseURL(trimmed)) {
            task.setMessage('Use an HTTPS (or localhost HTTP) base URL without credentials, query or fragment.');
            return;
          }
          next('custom-key', {quickUrl: trimmed.replace(/\/$/, '')});
        }
      } else if (st.step === 'custom-key') {
        await runQuickConnect({baseURL: st.quickUrl!, apiKey: value.trim() || undefined}, signal);
      } else if (st.step === 'custom-id') {
        if (!PROVIDER_ID.test(value)) {
          task.setMessage('Use letters, numbers, dots or dashes.');
          return;
        }
        next('url', {custom: {id: value, name: value}});
      } else if (st.step === 'url') {
        const url = new URL(value);
        if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) {
          task.setMessage('Use a base URL without credentials, query or fragment.');
          return;
        }
        next('protocol', {custom: {...st.custom, baseURL: value}});
      } else if (st.step === 'manual') {
        modelIdSchema.parse(value);
        next('headers', {customModelId: value});
      } else if (st.step === 'headers') {
        const headers = parseHeaderDraft(value);
        if (typeof headers === 'string') {
          task.setMessage(headers);
          return;
        }
        const provider = providerSchema.parse({
          ...st.custom,
          ...headers,
          source: 'config',
          metadataVersion: 1,
          timeoutMs: 60000,
          ...(st.customModelId ? {models: [st.customModelId]} : {}),
        });
        const problem = client.validateCustomProvider(provider);
        if (problem) {
          task.setMessage('Provider configuration rejected. Review endpoint and headers.');
          return;
        }
        client.addProvider(provider);
        next('method', {
          providerId: provider.id,
          providerLabel: provider.name,
          statusMessage: 'Saved to user host config. Choose authentication.',
        });
      } else if (st.step === 'rename') {
        client.renameAccount(st.accountId!, value.trim());
        next('accounts');
        onChanged?.();
      }
    });
  const choices = connectionChoices(
    state,
    client.listIntegrations(),
    client.listAccounts(),
    client.status().activeAccount?.id,
  );
  if (onOnboardingDone && state.step === 'provider') choices.unshift({id: '__skip-onboarding', label: 'Skip for now'});
  const labels: Partial<Record<ConnectStep, string>> = {
    'custom-quick': 'Base URL',
    'custom-key': 'API key (hidden)',
    'custom-model': 'Model ID',
    'custom-id': 'Custom provider ID',
    url: 'Base URL',
    secret: 'API key · hidden · OS keyring',
    env: 'Environment variable NAME',
    oauth: 'OAuth code · hidden',
    manual: 'Manual model ID',
    headers: 'Headers · Name=Value; Name=$ENV_VAR (empty to skip)',
    rename: 'Account alias',
  };
  const stepTitles: Partial<Record<ConnectStep, string>> = {
    'custom-quick': 'Connect a gateway',
    'custom-key': 'Connect a gateway',
    'custom-model': 'Enter a model ID',
  };
  const message = task.message || state.statusMessage;
  const challenge = state.authChallenge;
  const info = (
    <>
      {challenge ? (
        <>
          <TextLine>{challenge.authorizationURL}</TextLine>
          {challenge.userCode ? <TextLine>{`Code: ${challenge.userCode}`}</TextLine> : null}
        </>
      ) : null}
      {state.step === 'custom-quick' ? (
        <TextLine>Example https://gateway.example/v1 · Tab for advanced · Esc cancels</TextLine>
      ) : state.step === 'custom-key' ? (
        <TextLine>Enter without a key for public or local gateways · Esc cancels</TextLine>
      ) : state.step === 'custom-model' || state.step === 'busy' ? null : (
        <TextLine>Ctrl+A providers / accounts · Esc cancels sign-in</TextLine>
      )}
      {state.step === 'confirm' ? (
        <TextLine>
          {state.pendingAction === 'switch'
            ? 'Your chat history will be sent with this account.'
            : 'You will need to sign in again.'}
        </TextLine>
      ) : null}
    </>
  );
  if (state.step === 'custom-models')
    return (
      <PickerDialog
        title="Choose a model"
        {...props}
        filterable
        showSearch
        placeholder="Search model name or ID"
        items={[
          ...(state.quickModels ?? []).map(model => ({
            id: model.id,
            label: [model.id, modelLimitsLabel(model, true)].filter(Boolean).join(' · '),
            keywords: `${model.id} ${model.name}`,
          })),
          {id: '!manual', label: 'Enter a model ID'},
        ]}
        onSelect={item => {
          if (item.id === '!manual') next('custom-model');
          else chooseQuickModel.current?.(item.id);
        }}
      />
    );
  if (state.step === 'busy')
    return (
      <Dialog title="Connecting" {...props} message={message}>
        {info}
      </Dialog>
    );
  if (choices.length || state.step === 'accounts')
    return (
      <PickerDialog
        key={`${state.step}:${state.providerId ?? ''}`}
        title={state.providerLabel ? `${state.step} · ${state.providerLabel}` : `Connect · ${state.step}`}
        {...props}
        message={message}
        items={choices}
        onSelect={item => {
          if (!task.busy) activate(item.id);
        }}
      >
        {info}
      </PickerDialog>
    );
  return (
    <Dialog title={stepTitles[state.step] ?? `Connect · ${state.step}`} {...props} message={message}>
      {info}
      <TextEntry
        key={state.step}
        label={labels[state.step] ?? state.step}
        initialValue={state.step === 'custom-quick' ? (state.quickUrl ?? '') : state.step === 'env' ? state.draft : ''}
        hidden={['secret', 'oauth', 'headers', 'custom-key'].includes(state.step)}
        mask={state.step === 'custom-quick' ? maskQuickProviderDraft : undefined}
        maxLength={['secret', 'custom-quick', 'custom-key'].includes(state.step) ? 8192 : 2048}
        allowEmpty={['headers', 'custom-key'].includes(state.step)}
        onSubmit={
          state.step === 'custom-model'
            ? value => {
                const model = modelIdSchema.safeParse(value.trim());
                if (model.success) chooseQuickModel.current?.(model.data);
                else task.setMessage('Enter a valid model ID.');
              }
            : submit
        }
      />
    </Dialog>
  );
}
