import {
  AGENT_WAIT_MAX_MS,
  AGENT_WAIT_MIN_MS,
  agentCloseInputSchema,
  agentMessageInputSchema,
  agentToolInputSchema,
  agentWaitInputSchema,
  type SubagentToolOutcome,
} from '@cosmew/contracts';
import type {ToolDispatcherOptions} from '../context';
import type {ToolHandler} from './types';

const DEFAULT_AGENT_DESCRIPTION = [
  'Spawn a specialized subagent with its own isolated context window to handle a focused task.',
  'Built-in agent_type values: "explore" (fast read-only codebase search), "worker" (focused implementation on assigned files), "general" (multi-step research and execution), "plan" (read-only architecture and step-by-step plan).',
  'Multiple independent agent calls in one response run in parallel (up to max_threads).',
].join(' ');

const agentTarget = (value: unknown, key: string): string => {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  return typeof raw === 'string' ? raw.slice(0, 120) : '';
};

/** Shared shape of `agent_message`, `agent_wait` and `agent_close` (Codex send_input / wait / close_agent). */
function agentControlHandler(
  options: ToolDispatcherOptions,
  spec: {
    name: 'agent_message' | 'agent_wait' | 'agent_close';
    description: string;
    inputSchema: Record<string, unknown>;
    parse(input: unknown): {ok: boolean; target: string};
    method: 'message' | 'wait' | 'close';
  },
): ToolHandler {
  return {
    descriptor: {
      name: spec.name,
      capability: 'agent.spawn',
      parallel: true,
      description: spec.description,
      inputSchema: spec.inputSchema,
    },
    available: () =>
      !!options.subagents?.[spec.method] &&
      options.subagents.available?.() !== false &&
      options.subagents.hasChildren?.() !== false,
    unavailable: {
      status: 'error',
      code: 'AGENT_UNAVAILABLE',
      content: 'No subagent exists in this session (or subagents are unavailable); start one with agent first.',
    },
    prepare(input) {
      const checked = spec.parse(input);
      if (!checked.ok) {
        return {status: 'error', code: 'INVALID_INPUT', content: `Invalid arguments for ${spec.name}.`};
      }
      return {
        kind: 'agent',
        target: `${spec.name}: ${checked.target}`.slice(0, 240),
        agentType: spec.name,
        async execute(signal): Promise<SubagentToolOutcome> {
          return options.subagents![spec.method]!(input, signal);
        },
      };
    },
  };
}

export function agentControlHandlers(options: ToolDispatcherOptions): ToolHandler[] {
  return [
    agentControlHandler(options, {
      name: 'agent_message',
      method: 'message',
      description:
        'Send a follow-up to a subagent by id: a running child gets it at its next step; an idle child starts a new turn with its earlier context. Closed children cannot be messaged.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {type: 'string', description: 'Subagent id returned by agent.'},
          message: {type: 'string', description: 'The follow-up instruction or question for the subagent.'},
        },
        required: ['id', 'message'],
        additionalProperties: false,
      },
      parse: input => {
        const parsed = agentMessageInputSchema.safeParse(input);
        return {ok: parsed.success, target: parsed.success ? parsed.data.id : ''};
      },
    }),
    agentControlHandler(options, {
      name: 'agent_wait',
      method: 'wait',
      description: `Wait until any listed background subagent (default: all) is final; returns statuses and summaries or {timed_out: true}. timeout_ms default 30000, clamped to ${AGENT_WAIT_MIN_MS}..${AGENT_WAIT_MAX_MS}.`,
      inputSchema: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            items: {type: 'string'},
            description: 'Subagent ids to wait for (default: all background children).',
          },
          timeout_ms: {type: 'integer', description: 'Maximum time to wait in milliseconds.'},
        },
        additionalProperties: false,
      },
      parse: input => {
        const parsed = agentWaitInputSchema.safeParse(input);
        return {ok: parsed.success, target: parsed.success ? (parsed.data.ids?.join(',') ?? 'all') : ''};
      },
    }),
    agentControlHandler(options, {
      name: 'agent_close',
      method: 'close',
      description: 'Stop a subagent and release it for good. Returns its previous status.',
      inputSchema: {
        type: 'object',
        properties: {id: {type: 'string', description: 'Subagent id returned by agent.'}},
        required: ['id'],
        additionalProperties: false,
      },
      parse: input => {
        const parsed = agentCloseInputSchema.safeParse(input);
        return {ok: parsed.success, target: parsed.success ? parsed.data.id : agentTarget(input, 'id')};
      },
    }),
  ];
}

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
            description:
              'Subagent type to spawn: "explore" (read-only codebase search), "worker" (implementation on assigned files), "general" (multi-step research and execution), "plan" (read-only step-by-step plan), or the name of a custom agent listed in the project context.',
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
            description:
              'When false (default), wait for the subagent and return its final summary. When true, return {id} immediately and keep working; the result arrives later as a <subagent id=... status=...> message (or use agent_wait).',
          },
          fork_context: {
            type: 'boolean',
            description: 'When true, fork the current conversation history into the subagent before its prompt.',
          },
          isolation: {
            type: 'string',
            enum: ['worktree'],
            description: 'Run in an isolated Git worktree (Git repos only).',
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
      const target =
        `${parsed.data.agent_type}${parsed.data.isolation ? ' [worktree]' : ''}: ${parsed.data.description}`.slice(
          0,
          240,
        );
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
