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
export {
  sandboxDependencies,
  NativeCommandRuntime,
  NATIVE_LIMITS,
  findExecutable,
  shellArgvForPlatform,
  type NativeRuntimeOptions,
} from './exec/native';
export {
  BubblewrapSandbox,
  BWRAP_PROXY_PORT,
  BWRAP_PROXY_PORT_HEX,
  BWRAP_PROXY_URL,
  BWRAP_PROXY_SOCKET_GUEST,
  type BubblewrapOptions,
} from './exec/bubblewrap';
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
export {HookExecutor, type HookExecutorOptions} from './hooks';
