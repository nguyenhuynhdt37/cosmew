import type { Message, Selection } from './models';
export interface ConversationStore {
  create(selection: Selection): string;
  append(id: string, message: Message, state: 'pending' | 'committed'): number;
  complete(id: string, revision: number, message: Message): void;
  interrupt(id: string, revision: number): void;
}
