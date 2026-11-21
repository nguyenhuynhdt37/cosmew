export {
  ToolDispatcher,
  commandGrantTarget,
  type ApprovalDecision,
  type ApprovalRequest,
  type ToolAuditRecord,
  type ToolDispatcherOptions,
} from './dispatcher';
export {editDescriptor, globDescriptor, grepDescriptor, readDescriptor, writeDescriptor} from './registry';
export {LIMITS} from './limits';
export {execDescriptor, EXEC_LIMITS} from './exec/command';
export {HeadTailBuffer, plainTerminalText} from './exec/output';
export {
  SeatbeltRuntime,
  UnsupportedRuntime,
  platformCommandRuntime,
  commandBackendFromEnv,
  secretPathRegexes,
  type SeatbeltOptions,
} from './exec/runtime';
export type {CommandOutcome, CommandRequest, CommandRuntime, RuntimeAvailability} from '@cosmew/contracts';
export {likelySandboxDenied} from './exec/sandbox-denial';
export {NativeCommandRuntime, NATIVE_LIMITS, type NativeRuntimeOptions} from './exec/native';
export {DEFAULT_SANDBOX_CONFIG, type SandboxConfig} from './context';
export {
  SandboxProxy,
  proxyEnvironment,
  isPrivateAddress,
  parseConnectTarget,
  type ProxyEvent,
  type ProxyTarget,
  type SandboxProxyOptions,
} from './exec/proxy';

export {validateImageAttachment} from './builtin/read-media';
