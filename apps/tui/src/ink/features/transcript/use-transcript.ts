import {useCallback, useReducer} from 'react';
import type {Message, ModelEvent} from '@cosmew/contracts';
import {useFutrynClient} from '../../hooks';
import type {ContextBlock} from '../usage/logic';
import {messagesToTranscript, reduceTranscript} from './logic';
export function useTranscript() {
  const client = useFutrynClient();
  const build = useCallback(
    (messages?: readonly Message[], sessionId?: string) => {
      const session = messages === undefined ? client.activeSession() : undefined;
      const id = sessionId ?? session?.id ?? client.status().activeSessionId ?? undefined;
      let record: ReturnType<typeof client.getSession>;
      try {
        record = id ? client.getSession(id) : undefined;
      } catch {
        record = undefined;
      }
      return messagesToTranscript(messages ?? session?.messages ?? [], id, record);
    },
    [client],
  );
  const [state, dispatch] = useReducer(reduceTranscript, undefined, () => ({items: build()}));
  return {
    items: state.items,
    begin: useCallback((prompt: string, id: string = crypto.randomUUID(), model?: string) => {
      dispatch({type: 'begin', prompt, id, now: Date.now(), ...(model ? {model} : {})});
      return id;
    }, []),
    applyEvent: useCallback((event: ModelEvent) => dispatch({type: 'event', event, now: Date.now()}), []),
    finish: useCallback(
      (options: {error?: string; cancelled?: boolean} = {}) => dispatch({type: 'finish', ...options, now: Date.now()}),
      [],
    ),
    addCommand: useCallback(
      (command: string, ...lines: string[]) =>
        dispatch({type: 'command', id: crypto.randomUUID(), command, lines: lines.length ? lines : ['']}),
      [],
    ),
    beginCommand: useCallback((command: string) => {
      const id = crypto.randomUUID();
      dispatch({type: 'command', id, command, lines: ['Running… · Esc to cancel'], pending: true});
      return id;
    }, []),
    finishCommand: useCallback((id: string, lines: string[]) => dispatch({type: 'commandResult', id, lines}), []),
    addContext: useCallback(
      (command: string, context: ContextBlock) =>
        dispatch({type: 'command', id: crypto.randomUUID(), command, lines: [], context}),
      [],
    ),
    addNotice: useCallback((text: string) => dispatch({type: 'notice', text}), []),
    addNotification: useCallback((id: string, text: string) => dispatch({type: 'notification', id, text}), []),
    reset: useCallback(
      (messages?: readonly Message[], sessionId?: string) => {
        dispatch({type: 'reset', items: build(messages, sessionId)});
      },
      [build],
    ),
  };
}
