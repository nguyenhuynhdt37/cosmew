import {useEffect, useLayoutEffect, useRef} from 'react';
import type {FutrynClient} from '@futryn/sdk';
import {useFutrynClient} from './use-futryn-client';

export interface ClientEventHandlers {
  reactive?: Parameters<FutrynClient['onReactiveEvent']>[0];
  interaction?: Parameters<FutrynClient['onInteractionEvent']>[0];
  subagent?: Parameters<FutrynClient['onSubagentNotice']>[0];
}
/** Subscribe before commands are sent; observers never answer permissions/questions. */
export function useClientEvents(handlers: ClientEventHandlers): void {
  const client = useFutrynClient();
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });
  useEffect(() => {
    const stops = [
      client.onReactiveEvent(event => latest.current.reactive?.(event)),
      client.onInteractionEvent(event => latest.current.interaction?.(event)),
      client.onSubagentNotice(event => latest.current.subagent?.(event)),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, [client]);
}
/** Alias used in the migration plan. */
export const useEvents = useClientEvents;
