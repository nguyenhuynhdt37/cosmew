import {useCallback, useSyncExternalStore} from 'react';
import {useStdout} from 'ink';

// Transcript rows and rules may mount in large numbers. Share one native listener
// per stream, and detach it when the final consumer leaves.
const streams = new WeakMap<NodeJS.WritableStream, {listeners: Set<() => void>; resize(): void}>();
function subscribe(stdout: NodeJS.WritableStream, listener: () => void) {
  let shared = streams.get(stdout);
  if (!shared) {
    const listeners = new Set<() => void>();
    shared = {
      listeners,
      resize: () => {
        for (const notify of listeners) notify();
      },
    };
    streams.set(stdout, shared);
    stdout.on('resize', shared.resize);
  }
  shared.listeners.add(listener);
  return () => {
    shared.listeners.delete(listener);
    if (!shared.listeners.size) {
      stdout.off('resize', shared.resize);
      streams.delete(stdout);
    }
  };
}
export function useTerminalSize() {
  const {stdout} = useStdout();
  const listen = useCallback((notify: () => void) => subscribe(stdout, notify), [stdout]);
  const sized = stdout as NodeJS.WritableStream & {columns?: number; rows?: number};
  const snapshot = () => `${sized.columns || 80};${sized.rows || 0}`;
  const [columns, rows] = useSyncExternalStore(listen, snapshot, snapshot).split(';').map(Number);
  return {columns: columns!, rows: rows!};
}
