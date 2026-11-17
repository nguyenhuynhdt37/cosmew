import type {ToolDispatcherOptions} from '../context';
import {FileSystemRuntime} from '../runtimes/filesystem';
import {fileHandlers} from './filesystem';
import {ApplyPatchHandler} from './apply-patch';
import {stdinHandler} from './stdin';
import {commandHandler} from './command';
import {EditHandler, WriteHandler} from './file-edit';
import {requestPermissionsHandler} from './request-permissions';
import {planHandler} from './plan';
export function createHandlers(options: ToolDispatcherOptions, filesystem = new FileSystemRuntime(options)) {
  return [
    ...fileHandlers(options, filesystem),
    commandHandler(options),
    stdinHandler(options),
    new ApplyPatchHandler(options, filesystem.ledger),
    new EditHandler(options, filesystem.ledger),
    new WriteHandler(options, filesystem.ledger),
    requestPermissionsHandler(options),
    planHandler(options),
  ];
}
