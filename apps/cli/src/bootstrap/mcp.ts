import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {McpHub, parseMcpConfig, type McpSnapshot} from '@cosmew/mcp';
import {registerConfigSecrets} from '@cosmew/security';

/**
 * User MCP file only (`<state>/mcp.json`, normally `~/.cosmew/mcp.json`; legacy roots are reused). Project files are not
 * read and not started: a repository must not launch a process (ADR 0068).
 */
export function openUserMcp(
  directory: string,
  redact: (text: string) => string,
  register: (secret: string) => void,
): McpHub {
  const configPath = join(directory, 'mcp.json');
  const problems: string[] = [];
  let text = '';
  if (existsSync(configPath)) {
    try {
      text = readFileSync(configPath, 'utf8');
    } catch {
      problems.push('mcp.json could not be read.');
    }
  }
  const parsed = text ? parseMcpConfig(text) : {servers: [], problems: []};
  for (const server of parsed.servers)
    registerConfigSecrets(server.transport === 'stdio' ? server.env : server.headers, register);
  return new McpHub(parsed.servers, {redact, configPath, problems: [...problems, ...parsed.problems]});
}

/** stderr only, and only when a server failed or the file had a problem. Never prints secrets. */
export function writeMcpNotices(report: McpSnapshot): void {
  for (const problem of report.problems) process.stderr.write(`Notice: ${problem}\n`);
  for (const server of report.servers) {
    if (server.state === 'failed')
      process.stderr.write(`Notice: MCP server ${server.name} ${server.error ?? 'failed'}.\n`);
  }
}
