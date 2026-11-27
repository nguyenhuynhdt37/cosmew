import type {ToolDescriptor} from '@cosmew/contracts';
import type {ToolHandler} from './handlers/types';
export {globDescriptor, grepDescriptor} from './builtin/search';
export {readDescriptor} from './builtin/read';
export {editDescriptor, writeDescriptor} from './handlers/file-edit';

/** Composition-owned registrations. Exposure is discovery metadata, never permission. */
export class ToolRegistry {
  private readonly entries = new Map<string, {handler: ToolHandler; exposed: boolean}>();
  register(handler: ToolHandler, exposed = true): void {
    const {name} = handler.descriptor;
    if (!/^[a-z][a-z0-9_]{0,99}$/.test(name) || this.entries.has(name))
      throw new Error('Invalid or duplicate tool identity');
    this.entries.set(name, {handler, exposed});
  }
  get(name: string) {
    return this.entries.get(name);
  }
  descriptors(): ToolDescriptor[] {
    return [...this.entries.values()]
      .filter(e => e.exposed && e.handler.available())
      .map(e => structuredClone(e.handler.descriptor));
  }
}
