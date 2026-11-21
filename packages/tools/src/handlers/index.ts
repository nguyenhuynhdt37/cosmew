import type {ToolDispatcherOptions} from '../context';
import {FileSystemRuntime} from '../runtimes/filesystem';
import {toolOutputHandler} from './tool-output';
import {memoryHandler} from './memory';
import {skillHandler} from './skill';
import {fileHandlers} from './filesystem';
import {restoreCheckpointHandler} from './restore-checkpoint';
import {ApplyPatchHandler} from './apply-patch';
import {stdinHandler} from './stdin';
import {commandHandler} from './command';
import {EditHandler, WriteHandler} from './file-edit';
import {planHandler} from './plan';
import {exitPlanHandler} from './exit-plan';
import {questionHandler} from './question';
import {webFetchHandler} from './web-fetch';
import {webSearchHandler} from './web-search';
import {lspHandler, lspRenameHandler} from './lsp';
import {agentControlHandlers, agentHandler} from './agent';
export function createHandlers(options: ToolDispatcherOptions, filesystem = new FileSystemRuntime(options)) {
  return [
    ...fileHandlers(options, filesystem),
    restoreCheckpointHandler(options),
    skillHandler(options),
    memoryHandler(options),
    ...(options.outputArchive ? [toolOutputHandler(options)] : []),
    commandHandler(options),
    stdinHandler(options),
    new ApplyPatchHandler(options, filesystem.ledger),
    new EditHandler(options, filesystem.ledger),
    new WriteHandler(options, filesystem.ledger),
    planHandler(options),
    exitPlanHandler(options),
    questionHandler(options),
    webSearchHandler(options),
    webFetchHandler(options),
    lspHandler(options),
    lspRenameHandler(options),
    agentHandler(options),
    ...agentControlHandlers(options),
  ];
}
