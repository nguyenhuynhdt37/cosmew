import {parseArgs} from 'node:util';
import {FutrynError, type InstalledPluginView, type PluginSnapshot} from '@cosmew/contracts';
import {terminalText} from '@cosmew/security';
import {defaultStateDirectory} from './bootstrap/paths';
import {PluginManager} from './bootstrap/plugin-manager';

export const PLUGIN_HELP = `  plugin [list] [--json]
  plugin install PATH [--json]
  plugin uninstall ID [--json]
  plugin enable ID [--json]
  plugin disable ID [--json]
  plugin trust ID [--hash SHA256] [--json]
  plugin revoke ID [--json]
  plugin reload [--json]
    User-scoped plugins live under ~/.cosmew/plugins/.
    Hooks and MCP servers declared by a plugin remain disabled until you approve its exact SHA-256 hash.
    Repository directories are never automatically loaded as plugins.
`;

function invalid(message?: string): never {
  const err = new FutrynError('INVALID_INPUT');
  if (message) err.message = message;
  throw err;
}

function formatPluginLine(plugin: InstalledPluginView): string {
  const state = plugin.enabled ? 'enabled' : 'disabled';
  const trust =
    plugin.trustState === 'no-exec'
      ? 'text-only'
      : plugin.trustState === 'trusted'
        ? 'trusted'
        : plugin.trustState === 'trust-changed'
          ? 'TRUST-CHANGED'
          : 'UNTRUSTED';
  const assets = [
    plugin.counts.skills ? `${plugin.counts.skills} skills` : '',
    plugin.counts.commands ? `${plugin.counts.commands} cmds` : '',
    plugin.counts.agents ? `${plugin.counts.agents} agents` : '',
    plugin.counts.hooks ? `${plugin.counts.hooks} hooks` : '',
    plugin.counts.mcpServers ? `${plugin.counts.mcpServers} mcp` : '',
  ]
    .filter(Boolean)
    .join(', ');
  const hash = plugin.contentHash ? plugin.contentHash.slice(0, 12) : 'invalid';
  const lines = [
    `${terminalText(plugin.id)}@${terminalText(plugin.version)} [${state} · ${trust}] (${assets || 'empty'}) sha256:${hash}`,
  ];
  if (plugin.description) lines.push(`  ${terminalText(plugin.description)}`);
  for (const grant of plugin.grants) {
    lines.push(`  grant [${grant.kind}]: ${terminalText(grant.summary)}`);
  }
  for (const diag of plugin.diagnostics) {
    lines.push(`  ! ${terminalText(diag)}`);
  }
  return lines.join('\n');
}

function printSnapshot(snapshot: PluginSnapshot, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Plugins directory: ${terminalText(snapshot.directory)}\n`);
  if (snapshot.plugins.length === 0) {
    process.stdout.write('No plugins installed. Use `cosmew plugin install <path>` to install a local plugin.\n');
  } else {
    for (const plugin of snapshot.plugins) {
      process.stdout.write(`${formatPluginLine(plugin)}\n`);
    }
  }
  for (const diag of snapshot.diagnostics) {
    process.stdout.write(`Warning: ${terminalText(diag)}\n`);
  }
}

export async function pluginCli(argv: string[], stateDirectory?: string): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        json: {type: 'boolean'},
        help: {type: 'boolean', short: 'h'},
        hash: {type: 'string'},
      },
    });
  } catch {
    invalid();
  }
  const {values, positionals} = parsed;
  const command = positionals[0] ?? 'list';
  if (values.help || command === 'help') {
    process.stdout.write(`Usage: cosmew plugin <command>\n\n${PLUGIN_HELP}`);
    return;
  }

  const manager = new PluginManager({directory: stateDirectory ?? defaultStateDirectory()});
  const asJson = Boolean(values.json);

  if (command === 'list') {
    if (positionals.length > 1) invalid();
    printSnapshot(manager.snapshot(), asJson);
    return;
  }
  if (command === 'reload') {
    if (positionals.length > 1) invalid();
    const res = manager.manage({type: 'reload'});
    if (asJson) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    else {
      process.stdout.write(`${terminalText(res.message)}\n`);
      printSnapshot(res.snapshot, false);
    }
    return;
  }

  const target = positionals[1];
  if (!target || positionals.length !== 2) invalid();

  if (command === 'install') {
    const res = manager.install(target);
    if (asJson) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    else {
      process.stdout.write(`${terminalText(res.message)}\n`);
      if (res.plugin?.grants.length) {
        for (const grant of res.plugin.grants) {
          process.stdout.write(`  grant [${grant.kind}]: ${terminalText(grant.summary)}\n`);
        }
        process.stdout.write(
          `Run \`cosmew plugin trust ${terminalText(res.plugin.id)} --hash ${res.plugin.contentHash}\` to approve.\n`,
        );
      }
    }
    return;
  }
  if (command === 'uninstall' || command === 'remove') {
    const res = manager.uninstall(target);
    process.stdout.write(asJson ? `${JSON.stringify(res, null, 2)}\n` : `${terminalText(res.message)}\n`);
    return;
  }
  if (command === 'enable') {
    const res = manager.setEnabled(target, true);
    process.stdout.write(asJson ? `${JSON.stringify(res, null, 2)}\n` : `${terminalText(res.message)}\n`);
    return;
  }
  if (command === 'disable') {
    const res = manager.setEnabled(target, false);
    process.stdout.write(asJson ? `${JSON.stringify(res, null, 2)}\n` : `${terminalText(res.message)}\n`);
    return;
  }
  if (command === 'revoke') {
    const res = manager.revokeTrust(target);
    process.stdout.write(asJson ? `${JSON.stringify(res, null, 2)}\n` : `${terminalText(res.message)}\n`);
    return;
  }
  if (command === 'trust') {
    const snapshot = manager.snapshot();
    const plugin = snapshot.plugins.find(p => p.id === target);
    if (!plugin) {
      const err = new FutrynError('NOT_FOUND');
      err.message = `Plugin "${target}" is not installed.`;
      throw err;
    }
    const hash = values.hash?.trim() || plugin.contentHash;
    const res = manager.trust(target, hash);
    if (asJson) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    else {
      process.stdout.write(`${terminalText(res.message)}\n`);
      for (const grant of res.plugin?.grants ?? []) {
        process.stdout.write(`  approved [${grant.kind}]: ${terminalText(grant.summary)}\n`);
      }
    }
    return;
  }

  invalid(`Unknown plugin subcommand "${command}".`);
}
