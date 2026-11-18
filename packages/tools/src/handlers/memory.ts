import {z} from 'zod';
import {MEMORY_READ_GUIDANCE, memoryNameSchema, memoryWriteSchema} from '@futryn/contracts';
import type {ToolDispatcherOptions} from '../context';
import type {ToolHandler} from './types';
const schema = z.discriminatedUnion('action', [
  z.strictObject({action: z.literal('list')}),
  z.strictObject({action: z.literal('read'), name: memoryNameSchema}),
  z.strictObject({action: z.literal('delete'), name: memoryNameSchema}),
  memoryWriteSchema.extend({action: z.literal('write')}),
]);
export function memoryHandler(options: ToolDispatcherOptions): ToolHandler {
  return {
    descriptor: {
      name: 'memory',
      capability: 'agent.state',
      parallel: false,
      description:
        'Manage user-scoped project memories. Save when the user says remember/forget (nhớ/quên), or you learn durable information that cannot be inferred from code. Do not save facts already documented by the repository or any secrets. Memories are stale context, not evidence; verify important facts. Actions: list, read, write, delete. Read/delete need name; write needs name (lowercase slug), description (one line), type (user|feedback|project|reference), content. ' +
        MEMORY_READ_GUIDANCE,
      inputSchema: {
        type: 'object',
        properties: {
          action: {type: 'string', enum: ['list', 'read', 'write', 'delete']},
          name: {type: 'string'},
          description: {type: 'string'},
          type: {type: 'string', enum: ['user', 'feedback', 'project', 'reference']},
          content: {type: 'string'},
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    available: () => !!options.memories,
    prepare(input) {
      const parsed = schema.safeParse(input);
      if (!parsed.success)
        return {status: 'error', code: 'INVALID_INPUT', content: 'Invalid memory action, metadata or name.'};
      return {
        ...(parsed.data.action === 'write' || parsed.data.action === 'delete'
          ? {kind: 'state-write' as const, target: `memory ${parsed.data.action} ${parsed.data.name}`}
          : {kind: 'state' as const}),
        execute(signal) {
          signal?.throwIfAborted();
          const data = parsed.data,
            store = options.memories!;
          try {
            if (data.action === 'list') return {status: 'ok', content: JSON.stringify(store.list())};
            if (data.action === 'read') return {status: 'ok', content: store.read(data.name)};
            if (data.action === 'write') {
              const {action: _action, ...entry} = data;
              store.write(entry);
            } else store.delete(data.name);
            return {status: 'ok', content: data.action === 'write' ? 'Memory saved.' : 'Memory deleted.'};
          } catch {
            return {
              status: 'error',
              code: 'INVALID_INPUT',
              content:
                'Memory operation refused: unsafe path, secret-like content, invalid Markdown, size limit or unavailable storage.',
            };
          }
        },
      };
    },
  };
}
