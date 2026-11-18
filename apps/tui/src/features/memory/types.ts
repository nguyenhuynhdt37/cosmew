import type {MemoryInfo} from '@futryn/contracts';
export interface MemoryState {
  entries: MemoryInfo[];
  index: number;
  detail: string;
  offset: number;
  message: string;
}
