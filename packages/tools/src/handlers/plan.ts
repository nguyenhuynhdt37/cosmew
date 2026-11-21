import {z} from 'zod';
import {planItemSchema, type PlanState, type ToolDescriptor} from '@cosmew/contracts';
import type {ToolDispatcherOptions, ToolOutput} from '../context';
import type {ToolHandler} from './types';

/**
 * `update_plan` (ADR 0042). Schema and "Plan updated" result after Codex
 * `core/src/tools/handlers/plan_spec.rs` + `plan.rs` (openai/codex 090be4df, read 2026-11-17):
 * `{explanation?, plan: [{step, status}]}`, at most one `in_progress`. Additions: `cancelled`
 * (OpenCode `tool/plugin/todo.ts`), `activeForm` (Claude Code TodoWrite) and a count summary
 * (OpenCode). The plan is the agent's own session state: no workspace effect, no approval.
 */
export const planInput = z.strictObject({
  explanation: z.string().max(2000).optional(),
  plan: z.array(planItemSchema).max(50),
});

export const planDescriptor: ToolDescriptor = {
  name: 'update_plan',
  capability: 'agent.state',
  description:
    'Updates the task plan shown to the user. Provide an optional explanation and a list of plan items, each with a step and status (pending, in_progress, completed, cancelled). At most one step can be in_progress at a time. Use it for multi-step work: create the plan early, mark a step in_progress before starting it and completed as soon as it is done. activeForm is the present-continuous label shown while a step runs (e.g. "Running tests"). Skip it for simple one-step tasks.',
  inputSchema: {
    type: 'object',
    properties: {
      explanation: {type: 'string'},
      plan: {
        type: 'array',
        description: 'The list of steps',
        items: {
          type: 'object',
          properties: {
            step: {type: 'string'},
            status: {type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled']},
            activeForm: {type: 'string', description: 'Present-continuous label shown while the step runs.'},
          },
          required: ['step', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['plan'],
    additionalProperties: false,
  },
  // A plan is ordered session state: updates never run concurrently.
  parallel: false,
};

/** "Plan updated: 2/5 completed, 1 in progress, 2 pending." */
export function planSummary(plan: PlanState): string {
  const count = (status: string) => plan.items.filter(item => item.status === status).length;
  const parts = [`${count('completed')}/${plan.items.length} completed`];
  if (count('in_progress')) parts.push(`${count('in_progress')} in progress`);
  if (count('pending')) parts.push(`${count('pending')} pending`);
  if (count('cancelled')) parts.push(`${count('cancelled')} cancelled`);
  return `Plan updated: ${parts.join(', ')}.`;
}

const refuse = (content: string): ToolOutput => ({status: 'error', code: 'INVALID_INPUT', content});

export function planHandler(options: ToolDispatcherOptions): ToolHandler {
  return {
    descriptor: planDescriptor,
    available: () => !!options.agentState?.updatePlan,
    prepare(args) {
      const parsed = planInput.safeParse(args);
      if (!parsed.success)
        return refuse(
          'Expected {explanation?, plan: [{step, status: pending|in_progress|completed|cancelled, activeForm?}]} with at most 50 steps.',
        );
      if (parsed.data.plan.filter(item => item.status === 'in_progress').length > 1)
        return refuse('At most one step can be in_progress at a time. The plan was not changed.');
      const plan: PlanState = {
        ...(parsed.data.explanation ? {explanation: options.redact(parsed.data.explanation)} : {}),
        items: parsed.data.plan.map(item => ({
          ...item,
          step: options.redact(item.step),
          ...(item.activeForm ? {activeForm: options.redact(item.activeForm)} : {}),
        })),
        updatedAt: new Date().toISOString(),
      };
      return {
        kind: 'state',
        execute: () => {
          options.agentState!.updatePlan!(plan);
          return {status: 'ok', content: planSummary(plan)};
        },
      };
    },
  };
}
