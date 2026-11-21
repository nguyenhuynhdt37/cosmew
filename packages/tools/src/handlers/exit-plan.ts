import {z} from 'zod';
import type {ToolDispatcherOptions} from '../context';
import type {ToolHandler} from './types';

const input = z.strictObject({plan: z.string().trim().min(1).max(32000)});
/** Review is session state, never a filesystem or shell grant (ADR 0071). */
export function exitPlanHandler(options: ToolDispatcherOptions): ToolHandler {
  const available = () => !!options.agentState?.proposePlan && options.agentState.canProposePlan?.() === true;
  return {
    descriptor: {
      name: 'exit_plan_mode',
      capability: 'agent.state',
      parallel: false,
      description:
        'Submit the completed plan for explicit user approval. Only available in plan mode. Wait for approval or feedback before implementation.',
      inputSchema: {
        type: 'object',
        properties: {plan: {type: 'string'}},
        required: ['plan'],
        additionalProperties: false,
      },
    },
    available,
    prepare(args) {
      const parsed = input.safeParse(args);
      if (!parsed.success)
        return {status: 'error', code: 'INVALID_INPUT', content: 'Expected a nonempty plan, at most 32000 characters.'};
      const plan = options.redact(parsed.data.plan);
      return {
        kind: 'state',
        execute: async signal => {
          signal?.throwIfAborted();
          if (!available())
            return {
              status: 'denied',
              code: 'MODE_RESTRICTED',
              content: 'Plan approval is available only in plan mode.',
            };
          const outcome = await options.agentState!.proposePlan!(plan, signal);
          signal?.throwIfAborted();
          return {status: 'ok', content: JSON.stringify(outcome)};
        },
      };
    },
  };
}
