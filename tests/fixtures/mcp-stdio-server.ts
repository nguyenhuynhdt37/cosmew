/**
 * Newline JSON-RPC MCP fixture. Writes FIXTURE_PROBE before reading stdin so a test can see
 * whether the parent environment leaked. Nothing secret is written to stdout.
 */
import {writeFileSync} from 'node:fs';

const probe = process.env.FIXTURE_PROBE;
if (probe) {
  writeFileSync(
    probe,
    JSON.stringify({
      pid: process.pid,
      hasParentSecret: process.env.PARENT_SECRET !== undefined,
      token: process.env.TOKEN ?? '',
    }),
  );
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(line);
    newline = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => process.exit(0));

function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function handle(line: string): void {
  let message: {
    id?: number | string;
    method?: string;
    params?: {protocolVersion?: string; name?: string; arguments?: {text?: string}};
  };
  try {
    message = JSON.parse(line) as typeof message;
  } catch {
    return;
  }
  if (message.id === undefined) return;
  const id = message.id;
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-11-25',
        capabilities: {tools: {}},
        serverInfo: {name: 'fixture', version: '0.0.0'},
      },
    });
    return;
  }
  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echo text',
            inputSchema: {type: 'object', properties: {text: {type: 'string'}}, additionalProperties: false},
          },
          {name: 'bad name!', description: 'skipped', inputSchema: {type: 'object'}},
        ],
      },
    });
    return;
  }
  if (message.method === 'tools/call' && message.params?.name === 'echo') {
    send({
      jsonrpc: '2.0',
      id,
      result: {content: [{type: 'text', text: `echo:${message.params.arguments?.text ?? ''}`}]},
    });
    return;
  }
  if (message.method === 'ping') {
    send({jsonrpc: '2.0', id, result: {}});
    return;
  }
  send({jsonrpc: '2.0', id, error: {code: -32601, message: 'Method not found'}});
}
