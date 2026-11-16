import type {ToolDispatcherOptions, ToolOutput} from '../context';
import {readDescriptor, readInput} from '../builtin/read';
import {globDescriptor, globInput, grepDescriptor, grepInput} from '../builtin/search';
import {FileSystemRuntime} from '../runtimes/filesystem';
import type {ToolHandler} from './types';
const invalid = (name: string): ToolOutput => ({
  status: 'error',
  code: 'INVALID_INPUT',
  content: `Invalid arguments for ${name}.`,
});

export function fileHandlers(options: ToolDispatcherOptions, runtime: FileSystemRuntime): ToolHandler[] {
  return [
    {
      descriptor: readDescriptor,
      available: () => true,
      prepare(args) {
        const parsed = readInput.safeParse(args);
        if (!parsed.success) return invalid('read');
        const file = options.workspace.resolve(parsed.data.path);
        return {
          kind: 'read',
          file,
          execute: () => {
            const outcome = runtime.read(file, parsed.data);
            if (!outcome.ok)
              return {
                status: 'error',
                code: outcome.code,
                target: file.relative,
                content:
                  outcome.code === 'IS_DIRECTORY'
                    ? `${file.relative} is a directory; use glob to list it.`
                    : outcome.code === 'BINARY_FILE'
                      ? `${file.relative} looks like a binary file and was not read.`
                      : `${file.relative} is larger than 8 MiB and was not read.`,
              };
            return {
              status: 'ok',
              content: outcome.content,
              target: file.relative,
              truncated: outcome.truncated || undefined,
            };
          },
        };
      },
    },
    {
      descriptor: globDescriptor,
      available: () => true,
      prepare(args) {
        const parsed = globInput.safeParse(args);
        if (!parsed.success) return invalid('glob');
        const file = options.workspace.resolve(parsed.data.path ?? '.');
        if (file.kind !== 'directory')
          return {
            status: 'error',
            code: 'NOT_A_DIRECTORY',
            content: `${file.relative} is not a directory.`,
            target: file.relative,
          };
        return {
          kind: 'search',
          file,
          reason: 'listing',
          execute: () => {
            const outcome = runtime.glob(file, parsed.data);
            return {
              status: 'ok',
              content: outcome.content,
              target: file.relative,
              truncated: outcome.truncated || undefined,
            };
          },
        };
      },
    },
    {
      descriptor: grepDescriptor,
      available: () => true,
      prepare(args) {
        const parsed = grepInput.safeParse(args);
        if (!parsed.success) return invalid('grep');
        const file = options.workspace.resolve(parsed.data.path ?? '.');
        if (file.kind !== 'directory')
          return {
            status: 'error',
            code: 'NOT_A_DIRECTORY',
            content: `${file.relative} is not a directory.`,
            target: file.relative,
          };
        return {
          kind: 'search',
          file,
          reason: 'search-skips-secrets',
          execute: signal => runtime.grep(file, parsed.data, signal),
        };
      },
    },
  ];
}
