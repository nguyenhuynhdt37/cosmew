import {z} from 'zod';
import {normalizeRulePath, type ToolDescriptor} from '@futryn/contracts';
import type {ToolDispatcherOptions, ToolOutput} from '../context';
import type {ToolHandler} from './types';

/**
 * Codex `request_permissions` (core/src/tools/handlers/shell_spec.rs:141-176, pinned 090be4df):
 * the model asks for more than the sandbox allows; the user grants it for the rest of the turn
 * ("once") or the session. Futryn grants only what its sandbox can enforce: network for later
 * `exec_command` calls, and extra writable paths *inside* the workspace (used when the session
 * sandbox is read-only). Reads and anything outside the workspace are refused, not prompted.
 * The request always asks; `never` refuses it (ADR 0040).
 */
export const requestPermissionsInput = z.strictObject({
  reason: z.string().min(1).max(500).optional(),
  permissions: z.strictObject({
    network: z.strictObject({enabled: z.boolean()}).optional(),
    file_system: z
      .strictObject({
        read: z.array(z.string().max(1024)).max(32).optional(),
        write: z.array(z.string().min(1).max(1024)).max(32).optional(),
      })
      .optional(),
  }),
});

export const requestPermissionsDescriptor: ToolDescriptor = {
  name: 'request_permissions',
  capability: 'process.execute',
  description:
    'Request additional permissions from the user and wait for the answer. permissions.network {"enabled":true} lets later exec_command calls that set sandbox_permissions "with_additional_permissions" use the network without asking again; permissions.file_system.write lists project-relative paths that may be written when the sandbox is read-only. Granted permissions apply to later calls in the current turn, or for the rest of the session if the user approves them at session scope. Paths outside the project cannot be granted. Give a short reason.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: {type: 'string', description: 'Short explanation for why additional permissions are needed.'},
      permissions: {
        type: 'object',
        description: 'Filesystem or network access request.',
        properties: {
          network: {
            type: 'object',
            description: 'Network access request.',
            properties: {enabled: {type: 'boolean', description: 'True requests network access.'}},
            additionalProperties: false,
          },
          file_system: {
            type: 'object',
            properties: {
              write: {
                type: 'array',
                items: {type: 'string'},
                description: 'Project-relative paths to make writable; omit when none are needed.',
              },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
    required: ['permissions'],
    additionalProperties: false,
  },
};

const refuse = (code: string, content: string): ToolOutput => ({status: 'error', code, content});

export function requestPermissionsHandler(options: ToolDispatcherOptions): ToolHandler {
  return {
    descriptor: requestPermissionsDescriptor,
    // Grants only matter to the sandboxed command runtime (as Codex ties it to shell tools).
    available: () => options.commands?.availability().ok === true,
    prepare(args) {
      const parsed = requestPermissionsInput.safeParse(args);
      if (!parsed.success)
        return refuse(
          'INVALID_INPUT',
          'Expected {permissions: {network?: {enabled: boolean}, file_system?: {write?: string[]}}, reason?}.',
        );
      const {permissions, reason} = parsed.data;
      if (permissions.file_system?.read?.length)
        return refuse(
          'UNSUPPORTED',
          'Read access cannot be requested: every project file is already readable through the tools, and nothing outside the project is. Nothing was granted.',
        );
      const network = permissions.network?.enabled === true;
      const writable: string[] = [];
      for (const raw of permissions.file_system?.write ?? []) {
        const path = normalizeRulePath(
          raw.startsWith(options.workspace.root + '/') ? options.workspace.relativeOf(raw) : raw,
        );
        if (path === null)
          return refuse(
            'DENIED',
            `${raw} is outside the project. Futryn never grants access outside the approved workspace. Nothing was granted.`,
          );
        writable.push(path);
      }
      if (!network && !writable.length)
        return refuse('INVALID_INPUT', 'Request network {"enabled": true} or at least one writable path.');
      return {
        kind: 'permissions',
        network,
        writable: [...new Set(writable)].sort(),
        ...(reason ? {justification: reason} : {}),
        execute: () => ({status: 'ok', content: ''}),
      };
    },
  };
}
