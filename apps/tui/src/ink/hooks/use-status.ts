import {useCallback, useMemo, useSyncExternalStore} from 'react';
import {useFutrynClient} from './use-futryn-client';

/** The SDK event object is a stable revision; status() itself returns a fresh object. */
export function useStatus(projectScoped = false) {
  const client = useFutrynClient();
  const subscribe = useCallback((notify: () => void) => client.onReactiveEvent(notify), [client]);
  const snapshot = useCallback(() => client.currentReactiveEvent(), [client]);
  const revision = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(() => client.status(projectScoped), [client, projectScoped, revision]);
}
