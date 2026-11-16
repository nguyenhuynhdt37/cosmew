import type {ToolDispatcherOptions} from '../context';
import {FileSystemRuntime} from '../runtimes/filesystem';
import {fileHandlers} from './filesystem';
import {ApplyPatchHandler} from './apply-patch';
import {stdinHandler} from './stdin';
import {commandHandler} from './command';
export function createHandlers(options: ToolDispatcherOptions, filesystem = new FileSystemRuntime(options)) {
  return [
    ...fileHandlers(options, filesystem),
    commandHandler(options),
    stdinHandler(options),
    new ApplyPatchHandler(options),
  ];
}
