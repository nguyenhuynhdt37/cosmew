import {constants, closeSync, existsSync, fstatSync, openSync, readSync} from 'node:fs';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {FutrynError, type McpManagementAction} from '@cosmew/contracts';
import {terminalText} from '@cosmew/security';
import {writeMcpNotices} from './bootstrap/mcp';
import {readSecretStdin, secretInput} from './input';

export const MCP_HELP = `  mcp [list] [--managed] [--json]
  mcp get NAME | search QUERY [--cursor CURSOR] | recommended
  mcp add|edit NAME --url URL
  mcp add NAME --command EXE [--args '["arg"]']
  mcp add NAME -- EXE [ARG...]
  mcp install NAME --package PACKAGE --version EXACT [--integrity SHA512] [--lockfile FILE] [--bin NAME]
  mcp update NAME --version EXACT [--integrity SHA512] [--lockfile FILE] [--bin NAME]
  mcp rollback NAME
  mcp login|logout|enable|disable|reconnect|doctor|remove NAME
  mcp credentials NAME [--bearer-stdin | --clear]
    GitHub MCP login prompts for a personal access token.
    Credentials are read hidden on a terminal, or from stdin; never pass a token in argv.
    Only user MCP configuration is managed. Project MCP files are not started.
`;

function invalid(): never {
  throw new FutrynError('INVALID_INPUT');
}

/** Read one bounded regular file without following a final-component symlink. */
export function readMcpLockfile(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 512 * 1024) invalid();
    const buffer = Buffer.alloc(512 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (!read) break;
      length += read;
    }
    if (length > 512 * 1024) invalid();
    return JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } finally {
    closeSync(fd);
  }
}

export function parseMcpCli(argv: string[]) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      tokens: true,
      options: {
        json: {type: 'boolean'},
        help: {type: 'boolean'},
        managed: {type: 'boolean'},
        'bearer-stdin': {type: 'boolean'},
        clear: {type: 'boolean'},
        url: {type: 'string'},
        command: {type: 'string'},
        args: {type: 'string'},
        package: {type: 'string'},
        version: {type: 'string'},
        integrity: {type: 'string'},
        lockfile: {type: 'string'},
        bin: {type: 'string'},
        cursor: {type: 'string'},
      },
    });
  } catch {
    invalid();
  }
  const {values, positionals, tokens} = parsed;
  // Repeated flags are often a typo and must not silently replace an install identity.
  const flags = tokens.filter(token => token.kind === 'option').map(token => token.name);
  if (new Set(flags).size !== flags.length) invalid();
  const command = positionals[0] ?? 'list';
  const name = positionals[1];
  const allowed = new Set(['json', 'help']);
  const permit = (...keys: string[]) => keys.forEach(key => allowed.add(key));
  let action: McpManagementAction | undefined;
  if (command === 'list') {
    permit('managed');
    if (positionals.length > 1) invalid();
  } else if (command === 'get') {
    if (!name || positionals.length !== 2) invalid();
  } else if (command === 'search') {
    permit('cursor');
    if (!name || positionals.length !== 2) invalid();
    action = {type: 'search', query: name, ...(values.cursor ? {cursor: values.cursor} : {})};
  } else if (command === 'recommended') {
    if (positionals.length !== 1) invalid();
    action = {type: 'recommended'};
  } else if (command === 'add' || command === 'edit') {
    permit('url', 'command', 'args');
    if (!name) invalid();
    const terminator = tokens.find(token => token.kind === 'option-terminator');
    const trailing = terminator ? argv.slice(terminator.index + 1) : [];
    if (positionals.length !== 2 + trailing.length) invalid();
    if (values.url) {
      if (values.command || values.args || trailing.length) invalid();
      action = {type: command === 'edit' ? 'edit' : 'add', name, config: {transport: 'http', url: values.url}};
    } else {
      if ((trailing.length && (values.command || values.args)) || (!trailing.length && !values.command)) invalid();
      let args: unknown;
      try {
        args = values.args ? JSON.parse(values.args) : trailing.slice(1);
      } catch {
        invalid();
      }
      if (!Array.isArray(args) || args.length > 256 || args.some(arg => typeof arg !== 'string' || arg.length > 8192))
        invalid();
      action = {
        type: command === 'edit' ? 'edit' : 'add',
        name,
        config: {transport: 'stdio', command: trailing[0] ?? values.command!, args},
      };
    }
  } else if (command === 'install') {
    permit('package', 'version', 'integrity', 'lockfile', 'bin');
    if (!name || positionals.length !== 2 || !values.package || !values.version) invalid();
    action = {
      type: 'install',
      name,
      packageName: values.package,
      version: values.version,
      ...(values.integrity ? {integrity: values.integrity} : {}),
      ...(values.bin ? {bin: values.bin} : {}),
      ...(values.lockfile ? {lockfile: readMcpLockfile(values.lockfile)} : {}),
    };
  } else if (command === 'update') {
    permit('version', 'integrity', 'lockfile', 'bin');
    if (!name || positionals.length !== 2 || !values.version) invalid();
    action = {
      type: 'update',
      name,
      version: values.version,
      ...(values.integrity ? {integrity: values.integrity} : {}),
      ...(values.bin ? {bin: values.bin} : {}),
      ...(values.lockfile ? {lockfile: readMcpLockfile(values.lockfile)} : {}),
    };
  } else if (command === 'credentials') {
    permit('bearer-stdin', 'clear');
    if (!name || positionals.length !== 2 || (values.clear && values['bearer-stdin'])) invalid();
    // Secret acquisition happens only after all arguments have passed validation.
  } else if (['login', 'logout', 'enable', 'disable', 'reconnect', 'doctor', 'remove', 'rollback'].includes(command)) {
    if (!name || positionals.length !== 2) invalid();
    action = {
      type: command as 'login' | 'logout' | 'enable' | 'disable' | 'reconnect' | 'doctor' | 'remove' | 'rollback',
      name,
    };
  } else invalid();
  if (Object.keys(values).some(key => !allowed.has(key))) invalid();
  return {command, name, values, action};
}

/** Redact strings before serialization so quotes/backslashes in credentials cannot corrupt JSON. */
export function safeMcpOutput(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === 'string') return terminalText(redact(value));
  if (Array.isArray(value)) return value.map(item => safeMcpOutput(item, redact));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [terminalText(redact(key)), safeMcpOutput(entry, redact)]),
    );
  return value;
}

export async function mcpCli(argv: string[]): Promise<void> {
  if (argv.slice(0, argv.indexOf('--') < 0 ? argv.length : argv.indexOf('--')).includes('--help')) {
    process.stdout.write(MCP_HELP);
    return;
  }
  const parsed = parseMcpCli(argv);
  const {startup} = await import('./bootstrap/startup');
  const app = startup();
  const controller = new AbortController();
  const interrupt = () => {
    controller.abort();
    process.stdin.destroy();
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    for (const notice of app.takeStartupNotices()) process.stderr.write(`Notice: ${notice}\n`);
    await app.migrationCleanup;
    let value: unknown;
    if (parsed.command === 'list' && !parsed.values.managed) {
      const report = await app.connectMcp(controller.signal);
      writeMcpNotices(report);
      value = {
        ...report,
        ignoredProjectFiles: [
          join(process.cwd(), '.cosmew', 'mcp.json'),
          join(process.cwd(), '.futryn', 'mcp.json'),
          join(process.cwd(), '.mcp.json'),
        ].filter(path => existsSync(path)),
        note: 'Project MCP files are not started.',
      };
    } else if (parsed.command === 'list' || parsed.command === 'get') {
      const snapshot = await app.mcpManager.snapshot();
      value = parsed.command === 'get' ? snapshot.servers.find(server => server.name === parsed.name) : snapshot;
      if (!value) throw new FutrynError('NOT_FOUND');
    } else {
      let action = parsed.action;
      const server =
        (action?.type === 'login' && process.stdin.isTTY) || parsed.command === 'credentials'
          ? (await app.mcpManager.snapshot()).servers.find(item => item.name === parsed.name)
          : undefined;
      if (action?.type === 'login' && server?.auth.method === 'github-pat') {
        const bearer = await secretInput('GitHub personal access token');
        controller.signal.throwIfAborted();
        if (!bearer || bearer.length > 8192 || /[\x00-\x20\x7f]/.test(bearer)) invalid();
        app.redactor.register(bearer);
        action = {...action, bearer};
      } else if (parsed.command === 'credentials') {
        if (!server) throw new FutrynError('NOT_FOUND');
        if (server.transport !== 'http') throw new FutrynError('UNSUPPORTED');
        const bearer = parsed.values.clear
          ? null
          : parsed.values['bearer-stdin']
            ? await readSecretStdin()
            : await secretInput();
        controller.signal.throwIfAborted();
        if (bearer !== null) {
          if (!bearer || bearer.length > 8192 || /[\x00-\x20\x7f]/.test(bearer)) invalid();
          app.redactor.register(bearer);
        }
        action = {
          type: 'credentials',
          name: parsed.name!,
          bearer,
          ...(server.endpoint ? {expectedEndpoint: server.endpoint} : {}),
        };
      }
      value = await app.mcpManager.perform(action!, controller.signal);
    }
    process.stdout.write(
      JSON.stringify(
        safeMcpOutput(value, text => app.redactor.text(text)),
        null,
        parsed.values.json ? 0 : 2,
      ) + '\n',
    );
  } catch (error) {
    if (controller.signal.aborted) throw new FutrynError('CANCELLED');
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    try {
      await app.shutdownCommands();
    } finally {
      app.db.close();
    }
  }
}
