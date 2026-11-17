import {z} from 'zod';
import {userQuestionSchema, type ToolDescriptor} from '@futryn/contracts';
import type {ToolDispatcherOptions, ToolOutput} from '../context';
import type {ToolHandler} from './types';

/**
 * `request_user_input` (ADR 0042) after Codex `request_user_input_spec.rs` (openai/codex
 * 090be4df, read 2026-11-17): one to three short questions with labelled options; the client adds
 * a free-form "Other"; the answer comes back as `{"answers": {id: {"answers": [...]}}}`. From
 * OpenCode `question.ts`: `multiple`, and a dismissed dialog is an answer ("The user dismissed this
 * question"), not an error. An answer is text for the model; it never grants a permission.
 */
export const questionInput = z.strictObject({
  questions: z.array(userQuestionSchema).min(1).max(3),
});

export const questionDescriptor: ToolDescriptor = {
  name: 'request_user_input',
  capability: 'user.input',
  description:
    'Request user input for one to three short questions and wait for the response. Use it only when a decision genuinely needs the user (ambiguous requirements, a choice between approaches with real trade-offs); do not ask for permission to run tools. Answers are plain text; they grant no permissions.',
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: 'Questions to show the user. Prefer 1 and do not exceed 3',
        items: {
          type: 'object',
          properties: {
            id: {type: 'string', description: 'Stable identifier for mapping answers (snake_case).'},
            header: {type: 'string', description: 'Short header label shown in the UI (12 or fewer chars).'},
            question: {type: 'string', description: 'Single-sentence prompt shown to the user.'},
            options: {
              type: 'array',
              description:
                'Provide 2-3 mutually exclusive choices. Put the recommended option first and suffix its label with "(Recommended)". Do not include an "Other" option in this list; the client will add a free-form "Other" option automatically.',
              items: {
                type: 'object',
                properties: {
                  label: {type: 'string', description: 'User-facing label (1-5 words).'},
                  description: {
                    type: 'string',
                    description: 'One short sentence explaining impact/tradeoff if selected.',
                  },
                },
                required: ['label', 'description'],
                additionalProperties: false,
              },
            },
            multiple: {type: 'boolean', description: 'Allow choosing several options (they are then not exclusive).'},
          },
          required: ['id', 'header', 'question', 'options'],
          additionalProperties: false,
        },
      },
    },
    required: ['questions'],
    additionalProperties: false,
  },
  parallel: false,
};

const refuse = (content: string): ToolOutput => ({status: 'error', code: 'INVALID_INPUT', content});

export function questionHandler(options: ToolDispatcherOptions): ToolHandler {
  return {
    descriptor: questionDescriptor,
    available: () => !!options.agentState?.askUser && options.agentState.canAskUser?.() !== false,
    prepare(args) {
      const parsed = questionInput.safeParse(args);
      if (!parsed.success)
        return refuse(
          'Expected {questions: [{id (snake_case), header (<= 12 chars), question, options: [{label, description}], multiple?}]} with 1-3 questions.',
        );
      const ids = parsed.data.questions.map(q => q.id);
      if (new Set(ids).size !== ids.length) return refuse('Question ids must be unique.');
      if (parsed.data.questions.some(q => q.options.some(o => /^other\b/i.test(o.label))))
        return refuse('Do not include an "Other" option; the client adds a free-form answer automatically.');
      return {
        kind: 'question',
        execute: async signal => {
          const outcome = await options.agentState!.askUser!(parsed.data.questions, signal);
          signal?.throwIfAborted();
          if (outcome.kind === 'unavailable')
            return {
              status: 'error',
              code: 'UNAVAILABLE',
              content: `request_user_input is unavailable: ${outcome.reason}`,
            };
          if (outcome.kind === 'dismissed')
            return {
              status: 'ok',
              content: 'The user dismissed this question. Continue with your best judgement and say what you assumed.',
            };
          return {status: 'ok', content: JSON.stringify({answers: outcome.answers})};
        },
      };
    },
  };
}
