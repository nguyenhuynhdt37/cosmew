import {expect, test} from 'bun:test';
import {appendProvider, loadHostConfig, removeProvider, renderProviderToml} from '@futryn/models';

const load = (toml: string, reserved: string[] = ['chatgpt']) =>
  loadHostConfig(Bun.TOML.parse(toml), new Set(reserved));

const NINE_ROUTER = `
# my gateway
[model_providers.router9]
name = "9Router"
base_url = "https://router.example.com/api/openai/v1"
wire_api = "chat"
env_key = "ROUTER9_API_KEY"
env_key_instructions = "Create a key in the 9Router dashboard."
request_max_retries = 7
stream_max_retries = 500
stream_idle_timeout_ms = 900000
models = ["anthropic/claude-sonnet-4", "openai/gpt-5"]

[model_providers.router9.query_params]
api-version = "2025-01-01"

[model_providers.router9.http_headers]
X-Title = "Futryn"
HTTP-Referer = "https://futryn.dev"

[model_providers.router9.env_http_headers]
X-Org = "ROUTER9_ORG"
`;

test('a 9Router-style gateway parses: path prefix, headers, query, env header, vendor/model ids, Codex caps', () => {
  const {providers, diagnostics} = load(NINE_ROUTER);
  expect(diagnostics).toEqual([]);
  expect(providers).toHaveLength(1);
  expect(providers[0]!.provider).toMatchObject({
    id: 'router9',
    name: '9Router',
    baseURL: 'https://router.example.com/api/openai/v1',
    protocol: 'chat',
    auth: 'api-key',
    source: 'config',
    envKey: 'ROUTER9_API_KEY',
    queryParams: {'api-version': '2025-01-01'},
    httpHeaders: {'X-Title': 'Futryn', 'HTTP-Referer': 'https://futryn.dev'},
    envHttpHeaders: {'X-Org': 'ROUTER9_ORG'},
    requestMaxRetries: 7,
    streamMaxRetries: 100, // Codex hard cap
    streamIdleTimeoutMs: 900000,
    models: ['anthropic/claude-sonnet-4', 'openai/gpt-5'],
    catalog: 'manual',
  });
});

test('no models list means the gateway is asked for /models; http is allowed only for loopback', () => {
  const dynamic = load(`[model_providers.gw]\nbase_url = "https://h.example/v1"\n`);
  expect(dynamic.providers[0]!.provider.catalog).toBe('openai');
  expect(
    load(`[model_providers.local]\nbase_url = "http://127.0.0.1:20128/v1"\nrequires_auth = false\n`).providers[0]!
      .provider,
  ).toMatchObject({
    auth: 'none',
  });
  const remote = load(`[model_providers.bad]\nbase_url = "http://gateway.example.com/v1"\n`);
  expect(remote.providers).toEqual([]);
  expect(remote.diagnostics[0]).toMatchObject({providerId: 'bad'});
  expect(remote.diagnostics[0]!.message).toContain('https');
});

test('config files cannot carry credentials or unknown fields', () => {
  const cases: [string, string][] = [
    [`experimental_bearer_token = "sk-live-abcdefghijklmnop"`, 'plaintext tokens'],
    [`mystery = 1`, 'not a supported field'],
    [`gateway_oauth = {}`, 'not supported'],
    [`[model_providers.x.http_headers]\nAuthorization = "Bearer abc"`, 'credential headers'],
    [`[model_providers.x.http_headers]\nX-Api-Key = "abc"`, 'credential headers'],
    [`[model_providers.x.http_headers]\nX-Custom = "sk-abcdefghijklmnopqrstuvwxyz"`, 'looks like a credential'],
    [`[model_providers.x.http_headers]\nX-Custom = "eyJhbGciOiJIUzI1NiJ9.payload.sig"`, 'looks like a credential'],
    [`[model_providers.x.query_params]\nkey = "abc"`, 'credentials do not belong in the URL'],
    [`[model_providers.x.query_params]\napi_key = "abc"`, 'credentials do not belong in the URL'],
    [`env_key = "sk-this-is-a-key-not-a-name"`, 'NAME'],
  ];
  for (const [fragment, message] of cases) {
    const toml = `[model_providers.x]\nbase_url = "https://h.example/v1"\n${fragment}\n`;
    const result = load(toml);
    expect({fragment, providers: result.providers.length}).toEqual({fragment, providers: 0});
    expect(result.diagnostics.map(d => d.message).join(' ')).toContain(message);
  }
  // Ordinary descriptive headers are fine.
  expect(
    load(
      `[model_providers.x]\nbase_url = "https://h.example/v1"\n[model_providers.x.http_headers]\nX-Title = "My Agent 1.0"\n`,
    ).providers,
  ).toHaveLength(1);
});

test('the token command is an executable, never a shell line', () => {
  const base = `[model_providers.x]\nbase_url = "https://h.example/v1"\n[model_providers.x.auth]\n`;
  for (const command of ['./relative/tool', 'sh -c "echo hi"', 'a;b', '']) {
    expect(load(base + `command = ${JSON.stringify(command)}\n`).providers).toEqual([]);
  }
  const ok = load(base + `command = "/usr/bin/print-token"\nargs = ["--json"]\ntimeout_ms = 999999\n`).providers[0]!;
  expect(ok.provider.auth).toBe('command');
  expect(ok.tokenCommand).toEqual({
    command: '/usr/bin/print-token',
    args: ['--json'],
    timeoutMs: 60000,
    refreshIntervalMs: 300000,
  });
  // The command is not part of the persisted provider (it stays in memory only).
  expect(JSON.stringify(ok.provider)).not.toContain('print-token');
  expect(
    load(
      `[model_providers.x]\nbase_url = "https://h.example/v1"\nrequires_auth = false\n[model_providers.x.auth]\ncommand = "tok"\n`,
    ).providers,
  ).toEqual([]);
});

test('model_catalog_url must stay on the gateway origin and below base_url; subscription ids are reserved', () => {
  const head = `[model_providers.x]\nbase_url = "https://h.example/api/v1"\n`;
  expect(load(head + `model_catalog_url = "https://evil.example/api/v1/models"\n`).providers).toEqual([]);
  expect(load(head + `model_catalog_url = "https://h.example/other/models"\n`).providers).toEqual([]);
  expect(
    load(head + `model_catalog_url = "https://h.example/api/v1/catalog"\n`).providers[0]!.provider.modelCatalogURL,
  ).toBe('https://h.example/api/v1/catalog');
  expect(load(`[model_providers.chatgpt]\nbase_url = "https://h.example/v1"\n`).diagnostics[0]!.message).toContain(
    'built-in',
  );
});

test('one bad provider is reported and skipped without hiding the good ones', () => {
  const result = load(
    `[model_providers.good]\nbase_url = "https://h.example/v1"\n[model_providers.bad]\nbase_url = "ftp://h"\n[model_providers."bad id"]\nbase_url = "https://h.example"\n`,
  );
  expect(result.providers.map(p => p.provider.id)).toEqual(['good']);
  expect(result.diagnostics.map(d => d.providerId).sort()).toEqual(['bad', 'bad id']);
});

test('render, append and remove keep the rest of the user file and round-trip through the validator', () => {
  const original = load(NINE_ROUTER).providers[0]!;
  const rendered = renderProviderToml(original);
  const back = load(rendered).providers[0]!;
  expect(back.provider).toEqual(original.provider);
  const gateway = load(`[model_providers.gw]\nbase_url = "https://h.example/v1"\nname = "GW"\n`).providers[0]!;
  const text = `# keep me\nmodel = "x"\n\n` + NINE_ROUTER;
  const added = appendProvider(text, gateway);
  expect(added).toContain('# keep me');
  expect(() => appendProvider(added, gateway)).toThrow();
  expect(load(added).providers.map(p => p.provider.id)).toEqual(['router9', 'gw']);
  const removed = removeProvider(added, 'router9');
  expect(removed).toContain('# keep me');
  expect(removed).not.toContain('router9');
  expect(load(removed).providers.map(p => p.provider.id)).toEqual(['gw']);
  expect(removeProvider(removed, 'router9')).toBe(removed);
});
