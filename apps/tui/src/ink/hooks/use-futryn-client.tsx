/** @jsxImportSource react */
import {createContext, useContext, type ReactNode} from 'react';
import type {FutrynClient} from '@futryn/sdk';

const ClientContext = createContext<FutrynClient | null>(null);
export function FutrynClientProvider({client, children}: {client: FutrynClient; children: ReactNode}) {
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}
export function useFutrynClient(): FutrynClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error('useFutrynClient requires FutrynClientProvider');
  return client;
}
