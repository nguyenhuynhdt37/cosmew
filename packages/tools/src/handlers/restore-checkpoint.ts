import {z} from 'zod';
import type {ToolHandler} from './types';
import type {ToolDispatcherOptions, ToolOutput} from '../context';
import {ApplyPatchRuntime} from '../runtimes/apply-patch';

/** Host-only discovery; invoking still uses the complete normal fs.write dispatcher lifecycle. */
export function restoreCheckpointHandler(options: ToolDispatcherOptions): ToolHandler {
  const runtime = new ApplyPatchRuntime(options);
  return {
    descriptor: {
      name: 'restore_checkpoint',
      capability: 'fs.write',
      description: 'Restore saved checkpoint files after poststate conflict checks.',
      inputSchema: {type: 'object', properties: {id: {type: 'string'}}, required: ['id'], additionalProperties: false},
    },
    available: () => !!options.checkpoints && runtime.available(),
    prepare(input) {
      const parsed = z.strictObject({id: z.string().uuid()}).safeParse(input);
      if (!parsed.success) return {status: 'error', code: 'INVALID_INPUT', content: 'A checkpoint id is required.'};
      try {
        const changes = options.checkpoints!.restore(parsed.data.id);
        const plan = runtime.verifyRestore(changes);
        return {kind: 'patch', runtime, plan, execute: signal => runtime.apply(plan, signal)};
      } catch (error) {
        return {
          status: 'error',
          code: 'CHECKPOINT_CONFLICT',
          content: 'Checkpoint unavailable or a file changed. No files were restored.',
        } satisfies ToolOutput;
      }
    },
  };
}
