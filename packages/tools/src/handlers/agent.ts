import {BUILTIN_SUBAGENT_TYPES, agentToolInputSchema} from '@futryn/contracts';
import type {ToolDispatcherOptions} from '../context';
import type {ToolHandler} from './types';

const DEFAULT_AGENT_DESCRIPTION = [
  'Spawn a specialized subagent with its own isolated context window to handle a focused task.',
  'Built-in agent_type values: "explore" (fast read-only codebase search), "worker" (focused implementation on assigned files), "general" (multi-step research and execution), "plan" (read-only architecture and step-by-step plan).',
  'Multiple independent agent calls in one response run in parallel (up to max_threads).',
].join(' ');

export function agentHandler(options: ToolDispatcherOptions): ToolHandler {
  return {
    descriptor: {
      name: 'agent',
      capability: 'agent.spawn',
      parallel: true,
      description: options.subagents?.description?.() ?? DEFAULT_AGENT_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          agent_type: {
            type: 'string',
            enum: [...BUILTIN_SUBAGENT_TYPES],
            description:
              'Subagent role to spawn: "explore" (read-only codebase search), "worker" (implementation on assigned files), "general" (multi-step research and execution), or "plan" (read-only step-by-step plan).',
          },
          description: {
            type: 'string',
            description: 'Short (3-5 words) summary of the delegated task shown in the UI.',
          },
          prompt: {
            type: 'string',
            description: 'Detailed, self-contained instructions and context for the subagent.',
          },
          model: {
            type: 'string',
            description: 'Optional model ID override for this subagent.',
          },
          reasoning_effort: {
            type: 'string',
            enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
            description: 'Optional reasoning effort override for this subagent.',
          },
          background: {
            type: 'boolean',
            description: 'When false (default in S5a), wait for the subagent to finish and return its final summary.',
          },
          fork_context: {
            type: 'boolean',
            description: 'When true, fork the current conversation history into the subagent before its prompt.',
          },
        },
        required: ['agent_type', 'description', 'prompt'],
        additionalProperties: false,
      },
    },
    available: () => !!options.subagents && options.subagents.available?.() !== false,
    unavailable: {
      status: 'error',
      code: 'AGENT_UNAVAILABLE',
      content: 'Subagents are disabled or unavailable at the current nesting depth.',
    },
    prepare(input) {
      const parsed = agentToolInputSchema.safeParse(input);
      if (!parsed.success) {
        return {
          status: 'error',
          code: 'INVALID_INPUT',
          content: 'Expected {agent_type, description, prompt} for agent.',
        };
      }
      const target = `${parsed.data.agent_type}: ${parsed.data.description}`.slice(0, 240);
      return {
        kind: 'agent',
        target,
        agentType: parsed.data.agent_type,
        execute(signal, _onOutput, onEvent, callId) {
          return options.subagents!.run(callId ?? 'agent', parsed.data, signal, onEvent);
        },
      };
    },
  };
}
