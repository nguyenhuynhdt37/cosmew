import {useCallback, useReducer} from 'react';
import type {Message, ModelEvent} from '@cosmew/contracts';
import {useFutrynClient} from '../../hooks';
import type {ContextBlock} from '../usage/logic';
import {messagesToTranscript, reduceTranscript} from './logic';
export function useTranscript() {
  const client = useFutrynClient();
  const [state, dispatch] = useReducer(reduceTranscript, undefined, () => {
    const session = client.activeSession();
    return {items: messagesToTranscript(session?.messages ?? [], session?.id)};
  });
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
    addContext: useCallback(
      (command: string, context: ContextBlock) =>
        dispatch({type: 'command', id: crypto.randomUUID(), command, lines: [], context}),
      [],
    ),
    addNotice: useCallback((text: string) => dispatch({type: 'notice', text}), []),
    addNotification: useCallback((id: string, text: string) => dispatch({type: 'notification', id, text}), []),
    reset: useCallback(
      (messages?: readonly Message[], sessionId?: string) => {
        const session = messages === undefined ? client.activeSession() : undefined;
        dispatch({
          type: 'reset',
          items: messagesToTranscript(
            messages ?? session?.messages ?? [],
            sessionId ?? session?.id ?? client.status().activeSessionId ?? undefined,
          ),
        });
      },
      [client],
    ),
  };
}
