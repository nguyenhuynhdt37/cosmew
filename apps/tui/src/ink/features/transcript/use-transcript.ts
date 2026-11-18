import {useCallback, useReducer} from 'react';
import type {Message, ModelEvent} from '@futryn/contracts';
import {useFutrynClient} from '../../hooks';
import {messagesToTranscript, reduceTranscript} from './logic';
export function useTranscript() {
  const client = useFutrynClient();
  const [state, dispatch] = useReducer(reduceTranscript, undefined, () => ({
    items: messagesToTranscript(client.activeSession()?.messages ?? [], client.activeSession()?.id),
  }));
  return {
    items: state.items,
    begin: useCallback((prompt: string, id: string = crypto.randomUUID()) => {
      dispatch({type: 'begin', prompt, id, now: Date.now()});
      return id;
    }, []),
    applyEvent: useCallback((event: ModelEvent) => dispatch({type: 'event', event, now: Date.now()}), []),
    finish: useCallback(
      (options: {error?: string; cancelled?: boolean} = {}) => dispatch({type: 'finish', ...options, now: Date.now()}),
      [],
    ),
    addNotice: useCallback((text: string) => dispatch({type: 'notice', text}), []),
    reset: useCallback(
      (messages?: readonly Message[], sessionId?: string) =>
        dispatch({
          type: 'reset',
          items: messagesToTranscript(
            messages ?? client.activeSession()?.messages ?? [],
            sessionId ?? client.activeSession()?.id,
          ),
        }),
      [client],
    ),
  };
}
