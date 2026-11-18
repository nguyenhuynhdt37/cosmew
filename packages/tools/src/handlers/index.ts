import type {ToolDispatcherOptions} from '../context';
import {FileSystemRuntime} from '../runtimes/filesystem';
import {memoryHandler} from './memory';
import {skillHandler} from './skill';
import {fileHandlers} from './filesystem';
import {ApplyPatchHandler} from './apply-patch';
import {stdinHandler} from './stdin';
import {commandHandler} from './command';
import {EditHandler, WriteHandler} from './file-edit';
import {requestPermissionsHandler} from './request-permissions';
import {planHandler} from './plan';
import {questionHandler} from './question';
import {webFetchHandler} from './web-fetch';
import {webSearchHandler} from './web-search';
import {lspHandler, lspRenameHandler} from './lsp';
import {agentHandler} from './agent';
export function createHandlers(options: ToolDispatcherOptions, filesystem = new FileSystemRuntime(options)) {
  return [
    ...fileHandlers(options, filesystem),
    skillHandler(options),
    memoryHandler(options),
    commandHandler(options),
    stdinHandler(options),
    new ApplyPatchHandler(options, filesystem.ledger),
    new EditHandler(options, filesystem.ledger),
    new WriteHandler(options, filesystem.ledger),
    requestPermissionsHandler(options),
    planHandler(options),
    questionHandler(options),
    webSearchHandler(options),
    webFetchHandler(options),
    lspHandler(options),
    lspRenameHandler(options),
    agentHandler(options),
  ];
}
