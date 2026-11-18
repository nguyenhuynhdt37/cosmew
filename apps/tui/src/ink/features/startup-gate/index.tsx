/** @jsxImportSource react */
import {useCallback, useEffect, useRef, useState} from 'react';
import {FutrynError} from '@futryn/contracts';
import {useFutrynClient, useKeymap, useStatus} from '../../hooks';
import {Panel, TextLine, Spinner} from '../../ui';
import {
  CHECK_TIMEOUT_SECONDS,
  failureMessage,
  selectableAccounts,
  suggestedAlternative,
  TIMEOUT_MESSAGE,
} from './logic';
export interface StartupGateOptions {
  onReady(): void;
  onExit(): void;
  /** Host routes to the shared dialogs; gate never installs its own auth UI. */
  openOverlay(route: 'connect' | 'models'): void;
  overlayOpen: boolean;
}
export function useStartupGate(options: StartupGateOptions) {
  const client = useFutrynClient();
  const status = useStatus();
  const [phase, setPhase] = useState<'trust' | 'checking' | 'choose' | 'login' | 'off'>('trust');
  const [index, setIndex] = useState(1);
  const [message, setMessage] = useState('');
  const request = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Promise<void>>(Promise.resolve());
  const finishPending = useRef<(() => void) | null>(null);
  const callbacks = useRef(options);
  callbacks.current = options;
  useEffect(() => {
    alive.current = true;
    client.setToolsEnabled(false);
    return () => {
      alive.current = false;
      request.current?.abort();
      if (timer.current) clearTimeout(timer.current);
      client.setToolsEnabled(false);
    };
  }, [client]);
  const choose = useCallback(
    (text: string, failed = '') => {
      setMessage(text);
      setIndex(suggestedAlternative(selectableAccounts(client.listAccounts()), failed));
      setPhase('choose');
    },
    [client],
  );
  const verify = useCallback(async () => {
    if (request.current) return;
    const before = client.status();
    const account = before.activeAccount;
    if (!account || account.status === 'logged-out') {
      choose('Choose an account or sign in.');
      return;
    }
    const abort = new AbortController();
    request.current = abort;
    pending.current = new Promise<void>(resolve => {
      finishPending.current = resolve;
    });
    setPhase('checking');
    setMessage('');
    let timeout = false;
    const deadline = setTimeout(() => {
      timeout = true;
      abort.abort();
      if (alive.current) choose(TIMEOUT_MESSAGE, account.id);
    }, CHECK_TIMEOUT_SECONDS * 1000);
    timer.current = deadline;
    try {
      if (!before.selection) {
        await client.discoverModels({accountId: account.id, signal: abort.signal});
        if (!alive.current || abort.signal.aborted) return;
        setPhase('login');
        callbacks.current.openOverlay('models');
        return;
      }
      await client.diagnose(abort.signal, true);
      if (!alive.current || abort.signal.aborted) return;
      const after = client.status();
      if (
        after.activeAccount?.id !== account.id ||
        after.activeAccount.authGeneration !== account.authGeneration ||
        after.selection?.accountId !== before.selection.accountId ||
        after.selection?.modelId !== before.selection.modelId
      ) {
        choose('Account or model changed during verification. Check again.');
        return;
      }
      setPhase('off');
      callbacks.current.onReady();
    } catch (error) {
      if (alive.current && !abort.signal.aborted)
        choose(failureMessage(error instanceof FutrynError ? error.code : 'PROTOCOL'), account.id);
    } finally {
      clearTimeout(deadline);
      request.current = null;
      timer.current = null;
      finishPending.current?.();
      finishPending.current = null;
      if (timeout && alive.current) setMessage(TIMEOUT_MESSAGE);
    }
  }, [client, choose]);
  useEffect(() => {
    if (phase === 'login' && !options.overlayOpen) {
      if (!client.status().selection) choose('Choose a model or another account.');
      else void verify();
    }
  }, [phase, options.overlayOpen, client, choose, verify]);
  const accounts = selectableAccounts(status.accounts);
  const count = phase === 'trust' ? 2 : accounts.length + 1;
  const selected = Math.max(0, Math.min(index, count - 1));
  const exit = () => {
    request.current?.abort();
    if (timer.current) clearTimeout(timer.current);
    setPhase('off');
    client.setToolsEnabled(false);
    callbacks.current.onExit();
  };
  useKeymap(
    {
      previous: () => setIndex((selected + count - 1) % count),
      next: () => setIndex((selected + 1) % count),
      submit: () => {
        if (phase === 'trust') {
          if (selected !== 0) {
            exit();
            return;
          }
          client.setToolsEnabled(true);
          void verify();
        } else if (phase === 'choose') {
          const account = accounts[selected];
          if (account) {
            try {
              client.useAccount(account.id);
              void verify();
            } catch {
              choose('Account unavailable. Sign in again.');
            }
          } else {
            setPhase('login');
            callbacks.current.openOverlay('connect');
          }
        }
      },
    },
    {isActive: !options.overlayOpen && (phase === 'trust' || phase === 'choose')},
  );
  return {
    phase,
    index: selected,
    message,
    accounts,
    status,
    exit,
    shutdown: async () => {
      request.current?.abort();
      if (timer.current) clearTimeout(timer.current);
      await pending.current;
    },
  };
}
export interface StartupGateProps {
  state: ReturnType<typeof useStartupGate>;
  width?: number;
}
export function StartupGate({state, width}: StartupGateProps) {
  if (state.phase === 'off' || state.phase === 'login') return null;
  return (
    <Panel width={width} title={state.phase === 'trust' ? 'Trust this folder?' : 'Checking account'}>
      <TextLine>{state.status.workspace}</TextLine>
      {state.phase === 'trust' ? (
        <>
          <TextLine>
            Futryn may read files here and send them to the model. Consent lasts this session and does not grant tool
            permissions.
          </TextLine>
          <TextLine>Account check sends a small, potentially billed request.</TextLine>
          {['Allow for this session', 'Exit'].map((label, i) => (
            <TextLine key={label}>{`${state.index === i ? '›' : ' '} ${label}`}</TextLine>
          ))}
        </>
      ) : state.phase === 'checking' ? (
        <>
          <Spinner verb="Checking account" />
          <TextLine>{`${state.status.activeAccount?.alias ?? ''} · ${state.status.selection?.modelId ?? 'Discovering models'} · timeout ${CHECK_TIMEOUT_SECONDS}s`}</TextLine>
        </>
      ) : (
        <>
          <TextLine>{state.message}</TextLine>
          {[...state.accounts.map(a => `${a.alias} (${a.status})`), 'Sign in'].map((label, i) => (
            <TextLine key={i}>{`${state.index === i ? '›' : ' '} ${label}`}</TextLine>
          ))}
        </>
      )}
      <TextLine>↑↓ Select · Enter Confirm · Esc Exit</TextLine>
    </Panel>
  );
}
