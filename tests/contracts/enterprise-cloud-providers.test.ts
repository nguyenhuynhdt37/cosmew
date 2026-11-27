import {afterEach, describe, expect, test} from 'bun:test';
import {createVerify, generateKeyPairSync} from 'node:crypto';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  type Account,
  type CredentialVault,
  type ModelRequest,
  type Provider,
  type Settings,
  type SettingsStore,
} from '@cosmew/contracts';
import {
  GoogleAdcTokenProvider,
  ModelCatalog,
  ProviderAdapter,
  ProviderTransport,
  canonicalAwsUri,
  loadHostConfig,
  renderProviderToml,
  resolveAwsCredentials,
  signAwsSigV4,
} from '@cosmew/models';
import {ConfiguredNetworkPolicy} from '@cosmew/security';

const tempDirs: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

function makeTempDir(prefix = 'cosmew-cloud-'): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  tempDirs.push(dir);
  return dir;
}

function startServer(fetchHandler: (req: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({port: 0, hostname: '127.0.0.1', fetch: fetchHandler});
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

function memoryVault(initial: Record<string, string> = {}): CredentialVault {
  const map = new Map(Object.entries(initial));
  const keyOf = (ref: Parameters<CredentialVault['get']>[0]) =>
    ref.kind === 'keyring' ? ref.key : ref.kind === 'env' ? ref.name : '';
  return {
    get: async ref => map.get(keyOf(ref)),
    set: async (key, secret) => {
      map.set(key, secret);
    },
    delete: async ref => {
      map.delete(keyOf(ref));
    },
  };
}

function memorySettings(): SettingsStore {
  let state: Settings = {
    schemaVersion: 1,
    providers: [],
    accounts: [],
    activeAccountId: null,
    selection: null,
    projects: {},
    catalogs: [],
  };
  return {
    read: () => state,
    update: fn => {
      const next = structuredClone(state);
      fn(next);
      state = next;
    },
  };
}

function makeAccount(provider: Provider, credential: Account['credential'] = {kind: 'none'}): Account {
  return {
    id: crypto.randomUUID(),
    providerId: provider.id,
    alias: provider.id,
    credential,
    status: 'valid',
    validatedAt: new Date().toISOString(),
    authGeneration: 1,
  };
}

function makeRequest(modelId: string, prompt = 'Say hello'): ModelRequest {
  return {
    requestId: crypto.randomUUID(),
    modelId,
    instructions: 'You are a helpful coding assistant.',
    messages: [{role: 'user', content: prompt}],
    tools: [
      {
        name: 'get_time',
        description: 'Return the current UTC time',
        inputSchema: {type: 'object', properties: {tz: {type: 'string'}}, additionalProperties: false},
      },
    ],
  };
}

/** Pure AWS EventStream binary frame encoder (CRC32 prelude + string headers + JSON body + message CRC32). */
function encodeBedrockEventStream(events: {eventType: string; payload: unknown}[]): Buffer {
  const encodeStringHeader = (name: string, value: string): Buffer => {
    const nameBuf = Buffer.from(name, 'utf8');
    const valBuf = Buffer.from(value, 'utf8');
    const out = Buffer.alloc(1 + nameBuf.length + 1 + 2 + valBuf.length);
    let o = 0;
    out.writeUInt8(nameBuf.length, o);
    o += 1;
    nameBuf.copy(out, o);
    o += nameBuf.length;
    out.writeUInt8(7, o); // Type 7 = UTF-8 string
    o += 1;
    out.writeUInt16BE(valBuf.length, o);
    o += 2;
    valBuf.copy(out, o);
    return out;
  };
  const frames = events.map(({eventType, payload}) => {
    const headersBuf = Buffer.concat([
      encodeStringHeader(':message-type', 'event'),
      encodeStringHeader(':event-type', eventType),
      encodeStringHeader(':content-type', 'application/json'),
    ]);
    const bodyBuf = Buffer.from(JSON.stringify(payload), 'utf8');
    const totalLen = 12 + headersBuf.length + bodyBuf.length + 4;
    const frame = Buffer.alloc(totalLen);
    frame.writeUInt32BE(totalLen, 0);
    frame.writeUInt32BE(headersBuf.length, 4);
    frame.writeUInt32BE(Number(Bun.hash.crc32(frame.subarray(0, 8))), 8);
    headersBuf.copy(frame, 12);
    bodyBuf.copy(frame, 12 + headersBuf.length);
    frame.writeUInt32BE(Number(Bun.hash.crc32(frame.subarray(0, totalLen - 4))), totalLen - 4);
    return frame;
  });
  return Buffer.concat(frames);
}

describe('AWS SigV4 signer & AWS credentials resolution', () => {
  test('produces byte-exact AWS SigV4 signatures (cross-verified with AwsV4Signer) and double-encodes Bedrock colons', () => {
    const getHeaders = new Headers();
    const getResult = signAwsSigV4({
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      headers: getHeaders,
      body: null,
      service: 'service',
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      },
      now: new Date('2015-08-30T12:36:00Z'),
    });
    expect(getResult.amzDate).toBe('20150830T123600Z');
    expect(getResult.payloadHash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(getResult.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=726c5c4879a6b4ccbbd3b24edbd6b8826d34f87450fbbf4e85546fc7ba9c1642',
    );

    // Cross-verified byte-for-byte against AwsV4Signer on a Bedrock Converse URL with %3A, query sorting, and session token
    const postHeaders = new Headers({'content-type': 'application/json'});
    const postResult = signAwsSigV4({
      method: 'POST',
      url: new URL(
        'https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/converse?b=2&a=1',
      ),
      headers: postHeaders,
      body: JSON.stringify({messages: [{role: 'user', content: [{text: 'hi'}]}]}),
      service: 'bedrock',
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
        sessionToken: 'SESSIONTOKENEXAMPLE',
      },
      now: new Date('2026-11-27T08:00:00Z'),
    });
    expect(postResult.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261127/us-east-1/bedrock/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=b364f71bb24f166bd9065859f1fd75d41100b46b3595cbf2a82f90599793d3e3',
    );

    expect(canonicalAwsUri('/model/us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/converse', 'bedrock')).toBe(
      '/model/us.anthropic.claude-sonnet-4-5-20250929-v1%253A0/converse',
    );
    expect(canonicalAwsUri('/model/us.anthropic.claude-sonnet-4-5-20250929-v1:0/converse', 'bedrock')).toBe(
      '/model/us.anthropic.claude-sonnet-4-5-20250929-v1%253A0/converse',
    );
  });

  test('resolves AWS env and profile credentials safely, registers secrets, and ignores credential_process or symlinks', () => {
    const secrets: string[] = [];
    const envCreds = resolveAwsCredentials({
      env: {
        AWS_ACCESS_KEY_ID: 'AKIAENVEXAMPLE',
        AWS_SECRET_ACCESS_KEY: 'env-secret-value-1234',
        AWS_SESSION_TOKEN: 'env-session-token-5678',
      },
      homeDir: makeTempDir(),
      onSecret: s => secrets.push(s),
    });
    expect(envCreds).toEqual({
      accessKeyId: 'AKIAENVEXAMPLE',
      secretAccessKey: 'env-secret-value-1234',
      sessionToken: 'env-session-token-5678',
    });
    expect(secrets).toEqual(['env-secret-value-1234', 'env-session-token-5678']);

    const home = makeTempDir();
    mkdirSync(join(home, '.aws'), {recursive: true});
    writeFileSync(
      join(home, '.aws', 'credentials'),
      `[prod]\naws_access_key_id = AKIAPRODEXAMPLE\naws_secret_access_key = prod-secret-key\naws_session_token = prod-sess\n`,
    );
    writeFileSync(join(home, '.aws', 'config'), `[profile evil]\ncredential_process = /bin/sh -c "touch pwned"\n`);

    const profileSecrets: string[] = [];
    const prod = resolveAwsCredentials({
      profile: 'prod',
      env: {AWS_ACCESS_KEY_ID: 'AKIAOTHER', AWS_SECRET_ACCESS_KEY: 'other-secret'},
      homeDir: home,
      onSecret: s => profileSecrets.push(s),
    });
    expect(prod.accessKeyId).toBe('AKIAPRODEXAMPLE');
    expect(profileSecrets).toEqual(['prod-secret-key', 'prod-sess']);

    expect(() =>
      resolveAwsCredentials({
        profile: 'nonexistent',
        env: {AWS_ACCESS_KEY_ID: 'AKIAOTHER', AWS_SECRET_ACCESS_KEY: 'other-secret'},
        homeDir: home,
      }),
    ).toThrow();

    expect(() => resolveAwsCredentials({profile: 'evil', env: {}, homeDir: home})).toThrow();

    const linkHome = makeTempDir();
    mkdirSync(join(linkHome, '.aws'), {recursive: true});
    symlinkSync(join(home, '.aws', 'credentials'), join(linkHome, '.aws', 'credentials'));
    expect(() => resolveAwsCredentials({profile: 'prod', env: {}, homeDir: linkHome})).toThrow();
  });
});

describe('Google Cloud ADC token exchange & security guards', () => {
  test('exchanges RS256 service_account JWT, verifies signature, caches token, and registers secrets', async () => {
    const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
    const privatePem = privateKey.export({type: 'pkcs8', format: 'pem'}).toString();
    const dir = makeTempDir();
    const saPath = join(dir, 'sa.json');
    writeFileSync(
      saPath,
      JSON.stringify({
        type: 'service_account',
        client_email: 'agent@my-proj.iam.gserviceaccount.com',
        private_key: privatePem,
        token_uri: 'https://oauth2.googleapis.com/token',
      }),
    );

    let hits = 0;
    const tokenEndpoint = startServer(async req => {
      hits++;
      const form = new URLSearchParams(await req.text());
      expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
      const assertion = form.get('assertion')!;
      const [h, p, s] = assertion.split('.');
      const verifier = createVerify('RSA-SHA256');
      verifier.update(`${h}.${p}`);
      verifier.end();
      const sigBuf = Buffer.from(s!.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      expect(verifier.verify(publicKey, sigBuf)).toBe(true);
      const claims = JSON.parse(Buffer.from(p!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      expect(claims.iss).toBe('agent@my-proj.iam.gserviceaccount.com');
      expect(claims.scope).toBe('https://www.googleapis.com/auth/cloud-platform');
      return Response.json({access_token: 'ya29.mock-gcp-sa-token', expires_in: 3600, token_type: 'Bearer'});
    });

    const provider = new GoogleAdcTokenProvider();
    const secrets: string[] = [];
    const token1 = await provider.getAccessToken({
      credentialFile: saPath,
      tokenEndpointOverride: `${tokenEndpoint}/token`,
      onSecret: s => secrets.push(s),
    });
    const token2 = await provider.getAccessToken({
      credentialFile: saPath,
      tokenEndpointOverride: `${tokenEndpoint}/token`,
      onSecret: s => secrets.push(s),
    });
    expect(token1).toBe('ya29.mock-gcp-sa-token');
    expect(token2).toBe('ya29.mock-gcp-sa-token');
    expect(hits).toBe(1);
    expect(secrets).toContain(privatePem);
    expect(secrets).toContain('ya29.mock-gcp-sa-token');
  });

  test('exchanges authorized_user refresh_token and refuses unsafe token_uri, relative paths, or symlinks', async () => {
    const dir = makeTempDir();
    const adcPath = join(dir, 'adc.json');
    writeFileSync(
      adcPath,
      JSON.stringify({
        type: 'authorized_user',
        client_id: 'cid-123',
        client_secret: 'csec-456',
        refresh_token: 'rtok-789',
      }),
    );

    const tokenEndpoint = startServer(async req => {
      const form = new URLSearchParams(await req.text());
      expect(form.get('grant_type')).toBe('refresh_token');
      expect(form.get('client_id')).toBe('cid-123');
      expect(form.get('client_secret')).toBe('csec-456');
      expect(form.get('refresh_token')).toBe('rtok-789');
      return Response.json({access_token: 'ya29.mock-user-token', expires_in: 1800});
    });

    const provider = new GoogleAdcTokenProvider();
    const secrets: string[] = [];
    const token = await provider.getAccessToken({
      credentialFile: adcPath,
      tokenEndpointOverride: `${tokenEndpoint}/token`,
      onSecret: s => secrets.push(s),
    });
    expect(token).toBe('ya29.mock-user-token');
    expect(secrets).toEqual(['csec-456', 'rtok-789', 'ya29.mock-user-token']);

    const evilSa = join(dir, 'evil-sa.json');
    const {privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
    writeFileSync(
      evilSa,
      JSON.stringify({
        type: 'service_account',
        client_email: 'x@y.iam.gserviceaccount.com',
        private_key: privateKey.export({type: 'pkcs8', format: 'pem'}).toString(),
        token_uri: 'https://evil.example/steal',
      }),
    );
    await expect(provider.getAccessToken({credentialFile: evilSa})).rejects.toMatchObject({code: 'POLICY'});

    await expect(provider.getAccessToken({credentialFile: './adc.json'})).rejects.toMatchObject({code: 'POLICY'});
    const linked = join(dir, 'linked.json');
    symlinkSync(adcPath, linked);
    await expect(provider.getAccessToken({credentialFile: linked})).rejects.toMatchObject({code: 'POLICY'});
  });
});

describe('host-config TOML parsing & round-trip for Bedrock, Vertex AI, and Azure OpenAI', () => {
  test('parses and round-trips all three enterprise cloud providers cleanly', () => {
    const toml = `
[model_providers.bedrock_iam]
name = "AWS Bedrock IAM"
wire_api = "bedrock"
models = ["us.anthropic.claude-sonnet-4-5-20250929-v1:0"]
[model_providers.bedrock_iam.aws]
region = "us-west-2"
profile = "prod"

[model_providers.bedrock_key]
name = "AWS Bedrock Key"
wire_api = "bedrock"
env_key = "AWS_BEARER_TOKEN_BEDROCK"
[model_providers.bedrock_key.aws]
region = "us-east-1"

[model_providers.vertex_gemini]
name = "Vertex Gemini"
wire_api = "vertex"
project_id = "my-gcp-project-1"
location = "us-central1"
credential_file = "/etc/cosmew/sa.json"
models = ["gemini-2.5-pro"]

[model_providers.vertex_claude]
name = "Vertex Claude"
wire_api = "vertex-anthropic"
project_id = "my-gcp-project-1"
location = "global"
models = ["claude-sonnet-4-5@20250929"]

[model_providers.azure_deploy]
name = "Azure Deployment"
base_url = "https://my-org.openai.azure.com"
wire_api = "azure"
env_key = "AZURE_OPENAI_API_KEY"
models = ["gpt-4o"]
[model_providers.azure_deploy.azure]
api_version = "2024-10-21"

[model_providers.azure_v1]
name = "Azure Foundry v1"
base_url = "https://my-org.openai.azure.com/openai/v1"
wire_api = "azure"
[model_providers.azure_v1.auth]
command = "az"
args = ["account", "get-access-token", "--resource", "https://cognitiveservices.azure.com", "--query", "accessToken", "-o", "tsv"]
`;
    const parsed = loadHostConfig(Bun.TOML.parse(toml));
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.providers).toHaveLength(6);

    const byId = Object.fromEntries(parsed.providers.map(entry => [entry.provider.id, entry]));
    expect(byId.bedrock_iam!.provider).toMatchObject({
      protocol: 'bedrock',
      baseURL: 'https://bedrock-runtime.us-west-2.amazonaws.com',
      auth: 'aws-sigv4',
      catalog: 'manual',
      aws: {region: 'us-west-2', profile: 'prod'},
    });
    expect(byId.bedrock_key!.provider).toMatchObject({
      protocol: 'bedrock',
      baseURL: 'https://bedrock-runtime.us-east-1.amazonaws.com',
      auth: 'api-key',
      catalog: 'bedrock',
      envKey: 'AWS_BEARER_TOKEN_BEDROCK',
    });
    expect(byId.vertex_gemini!.provider).toMatchObject({
      protocol: 'vertex',
      baseURL:
        'https://us-central1-aiplatform.googleapis.com/v1/projects/my-gcp-project-1/locations/us-central1/publishers/google',
      auth: 'google-adc',
      catalog: 'manual',
      vertex: {projectId: 'my-gcp-project-1', location: 'us-central1', credentialFile: '/etc/cosmew/sa.json'},
    });
    expect(byId.vertex_claude!.provider).toMatchObject({
      protocol: 'vertex-anthropic',
      baseURL: 'https://aiplatform.googleapis.com/v1/projects/my-gcp-project-1/locations/global/publishers/anthropic',
      auth: 'google-adc',
      catalog: 'manual',
    });
    expect(byId.azure_deploy!.provider).toMatchObject({
      protocol: 'azure',
      auth: 'api-key',
      azure: {apiVersion: '2024-10-21', apiMode: 'chat', useDeploymentBasedUrls: true},
    });
    expect(byId.azure_v1!.provider).toMatchObject({
      protocol: 'azure',
      auth: 'command',
      azure: {apiMode: 'responses', useDeploymentBasedUrls: false},
    });

    for (const entry of parsed.providers) {
      const rendered = renderProviderToml(entry);
      const back = loadHostConfig(Bun.TOML.parse(rendered));
      expect(back.diagnostics).toEqual([]);
      expect(back.providers[0]!.provider).toEqual(entry.provider);
      expect(back.providers[0]!.tokenCommand).toEqual(entry.tokenCommand);
    }
  });

  test('rejects invalid cloud fields and relative credential_file paths', () => {
    const badConfigs = [
      `[model_providers.a]\nwire_api = "bedrock"\n[model_providers.a.aws]\nregion = "not-a-region"\n`,
      `[model_providers.b]\nwire_api = "chat"\nbase_url = "https://h.example/v1"\n[model_providers.b.aws]\nregion = "us-east-1"\n`,
      `[model_providers.c]\nwire_api = "vertex"\nproject_id = "my-proj-1"\nlocation = "us-central1"\ncredential_file = "./relative.json"\n`,
      `[model_providers.d]\nwire_api = "vertex"\nproject_id = "my-proj-1"\nlocation = "us-central1"\ncredential_file = "/tmp/../etc/passwd"\n`,
      `[model_providers.e]\nwire_api = "azure"\nbase_url = "https://my-org.openai.azure.com"\n[model_providers.e.azure]\napi_version = "invalid"\n`,
    ];
    for (const toml of badConfigs) {
      const result = loadHostConfig(Bun.TOML.parse(toml));
      expect(result.providers).toHaveLength(0);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
  });
});

describe('Enterprise Cloud Providers end-to-end wire integration (local mock HTTP/EventStream)', () => {
  test('Azure OpenAI deployment Chat (api-key header) and v1 Responses (Entra Bearer token)', async () => {
    const seen: {
      deployUrl?: string;
      deployApiKey?: string | null;
      deployAuth?: string | null;
      v1Url?: string;
      v1Auth?: string | null;
      v1ApiKey?: string | null;
    } = {};

    const baseURL = startServer(async req => {
      const url = new URL(req.url);
      if (url.pathname === '/openai/deployments/gpt-4o/chat/completions') {
        seen.deployUrl = url.pathname + url.search;
        seen.deployApiKey = req.headers.get('api-key');
        seen.deployAuth = req.headers.get('authorization');
        const sse =
          `data: ${JSON.stringify({
            id: 'chatcmpl-1',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'gpt-4o',
            choices: [{index: 0, delta: {role: 'assistant', content: 'Hello from Azure'}, finish_reason: null}],
          })}\n\n` +
          `data: ${JSON.stringify({
            id: 'chatcmpl-1',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'gpt-4o',
            choices: [{index: 0, delta: {}, finish_reason: 'stop'}],
            usage: {prompt_tokens: 12, completion_tokens: 4, total_tokens: 16},
          })}\n\n` +
          `data: [DONE]\n\n`;
        return new Response(sse, {headers: {'content-type': 'text/event-stream'}});
      }
      if (url.pathname === '/openai/v1/responses') {
        seen.v1Url = url.pathname + url.search;
        seen.v1Auth = req.headers.get('authorization');
        seen.v1ApiKey = req.headers.get('api-key');
        return Response.json({
          id: 'resp_azure_1',
          object: 'response',
          created_at: 1,
          model: 'gpt-5',
          output: [
            {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{type: 'output_text', text: 'Hello from Foundry v1', annotations: []}],
            },
          ],
          usage: {input_tokens: 10, output_tokens: 5, total_tokens: 15},
        });
      }
      return new Response('not found', {status: 404});
    });

    const deployProvider: Provider = {
      id: 'azure-deploy',
      name: 'Azure Deploy',
      protocol: 'azure',
      baseURL,
      auth: 'api-key',
      catalog: 'manual',
      metadataVersion: 1,
      timeoutMs: 10000,
      streamUsage: true,
      azure: {apiVersion: '2024-10-21', apiMode: 'chat', useDeploymentBasedUrls: true},
    };
    const keyId = crypto.randomUUID();
    const deployAccount = makeAccount(deployProvider, {kind: 'keyring', key: keyId});
    const deployTransport = new ProviderTransport(
      deployProvider,
      deployAccount,
      memoryVault({[keyId]: 'azure-secret-key-xyz'}),
      new ConfiguredNetworkPolicy(),
    );
    const deployAdapter = new ProviderAdapter(deployTransport, 'gpt-4o');
    let streamed = '';
    for await (const event of deployAdapter.stream(makeRequest('gpt-4o'))) {
      if (event.type === 'textDelta') streamed += event.text;
    }
    expect(streamed).toBe('Hello from Azure');
    expect(seen.deployUrl).toBe('/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21');
    expect(seen.deployApiKey).toBe('azure-secret-key-xyz');
    expect(seen.deployAuth).toBeNull();

    const v1Provider: Provider = {
      id: 'azure-v1',
      name: 'Azure v1',
      protocol: 'azure',
      baseURL: `${baseURL}/openai/v1`,
      auth: 'command',
      catalog: 'manual',
      metadataVersion: 1,
      timeoutMs: 10000,
      azure: {apiMode: 'responses', useDeploymentBasedUrls: false},
    };
    const v1Account = makeAccount(v1Provider);
    const v1Transport = new ProviderTransport(
      v1Provider,
      v1Account,
      memoryVault(),
      new ConfiguredNetworkPolicy(),
      fetch,
      async () => 'entra-bearer-token-999',
    );
    const v1Adapter = new ProviderAdapter(v1Transport, 'gpt-5');
    const result = await v1Adapter.generate(makeRequest('gpt-5'));
    expect(result.text).toBe('Hello from Foundry v1');
    expect(seen.v1Url).toBe('/openai/v1/responses');
    expect(seen.v1Auth).toBe('Bearer entra-bearer-token-999');
    expect(seen.v1ApiKey).toBeNull();
  });

  test('Google Vertex AI Gemini (:streamGenerateContent) and Claude (:streamRawPredict) with ADC Bearer auth', async () => {
    const {privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
    const dir = makeTempDir();
    const saPath = join(dir, 'vertex-sa.json');
    writeFileSync(
      saPath,
      JSON.stringify({
        type: 'service_account',
        client_email: 'vertex@proj.iam.gserviceaccount.com',
        private_key: privateKey.export({type: 'pkcs8', format: 'pem'}).toString(),
        token_uri: 'https://oauth2.googleapis.com/token',
      }),
    );

    const seen: {
      geminiAuth?: string | null;
      geminiKey?: string | null;
      claudePath?: string;
      claudeAuth?: string | null;
      claudeApiKey?: string | null;
      claudeBody?: Record<string, unknown>;
    } = {};

    const base = startServer(async req => {
      const url = new URL(req.url);
      if (url.pathname === '/oauth2/token') {
        return Response.json({access_token: 'ya29.vertex-access-token', expires_in: 3600});
      }
      if (url.pathname.endsWith('/publishers/google/models/gemini-2.5-pro:streamGenerateContent')) {
        seen.geminiAuth = req.headers.get('authorization');
        seen.geminiKey = req.headers.get('x-goog-api-key');
        const sse = `data: ${JSON.stringify({
          candidates: [
            {
              content: {role: 'model', parts: [{text: 'Hello from Vertex Gemini'}]},
              finishReason: 'STOP',
              index: 0,
            },
          ],
          usageMetadata: {promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13},
        })}\n\n`;
        return new Response(sse, {headers: {'content-type': 'text/event-stream'}});
      }
      if (url.pathname.includes('/publishers/anthropic/models/') && url.pathname.endsWith(':streamRawPredict')) {
        seen.claudePath = url.pathname;
        seen.claudeAuth = req.headers.get('authorization');
        seen.claudeApiKey = req.headers.get('x-api-key');
        seen.claudeBody = (await req.json()) as Record<string, unknown>;
        const sse =
          [
            `event: message_start\ndata: ${JSON.stringify({
              type: 'message_start',
              message: {
                id: 'msg_vertex_1',
                type: 'message',
                role: 'assistant',
                model: 'claude-sonnet-4-5@20250929',
                content: [],
                stop_reason: null,
                usage: {input_tokens: 20, output_tokens: 0, cache_read_input_tokens: 15},
              },
            })}`,
            `event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start',
              index: 0,
              content_block: {type: 'text', text: ''},
            })}`,
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index: 0,
              delta: {type: 'text_delta', text: 'Hello from Vertex Claude'},
            })}`,
            `event: content_block_stop\ndata: ${JSON.stringify({type: 'content_block_stop', index: 0})}`,
            `event: message_delta\ndata: ${JSON.stringify({
              type: 'message_delta',
              delta: {stop_reason: 'end_turn'},
              usage: {output_tokens: 6},
            })}`,
            `event: message_stop\ndata: ${JSON.stringify({type: 'message_stop'})}`,
          ].join('\n\n') + '\n\n';
        return new Response(sse, {headers: {'content-type': 'text/event-stream'}});
      }
      return new Response(`unexpected ${url.pathname}`, {status: 404});
    });

    const adc = new GoogleAdcTokenProvider();

    const geminiProvider: Provider = {
      id: 'vertex-gem',
      name: 'Vertex Gemini',
      protocol: 'vertex',
      baseURL: `${base}/v1/projects/proj/locations/us-central1/publishers/google`,
      auth: 'google-adc',
      catalog: 'manual',
      metadataVersion: 1,
      timeoutMs: 10000,
      vertex: {projectId: 'proj', location: 'us-central1', credentialFile: saPath},
    };
    const geminiTransport = new ProviderTransport(
      geminiProvider,
      makeAccount(geminiProvider),
      memoryVault(),
      new ConfiguredNetworkPolicy(),
      fetch,
      undefined,
      undefined,
      {googleAdc: adc, googleTokenEndpointOverride: `${base}/oauth2/token`},
    );
    let geminiText = '';
    for await (const ev of new ProviderAdapter(geminiTransport, 'gemini-2.5-pro').stream(
      makeRequest('gemini-2.5-pro'),
    )) {
      if (ev.type === 'textDelta') geminiText += ev.text;
    }
    expect(geminiText).toBe('Hello from Vertex Gemini');
    expect(seen.geminiAuth).toBe('Bearer ya29.vertex-access-token');
    expect(seen.geminiKey).toBeNull();

    const claudeProvider: Provider = {
      id: 'vertex-claude',
      name: 'Vertex Claude',
      protocol: 'vertex-anthropic',
      baseURL: `${base}/v1/projects/proj/locations/global/publishers/anthropic`,
      auth: 'google-adc',
      catalog: 'manual',
      metadataVersion: 1,
      timeoutMs: 10000,
      vertex: {projectId: 'proj', location: 'global', credentialFile: saPath},
    };
    const claudeTransport = new ProviderTransport(
      claudeProvider,
      makeAccount(claudeProvider),
      memoryVault(),
      new ConfiguredNetworkPolicy(),
      fetch,
      undefined,
      undefined,
      {googleAdc: adc, googleTokenEndpointOverride: `${base}/oauth2/token`},
    );
    let claudeText = '';
    let claudeCacheRead: number | null | undefined;
    for await (const ev of new ProviderAdapter(claudeTransport, 'claude-sonnet-4-5@20250929').stream(
      makeRequest('claude-sonnet-4-5@20250929'),
    )) {
      if (ev.type === 'textDelta') claudeText += ev.text;
      if (ev.type === 'usage') claudeCacheRead = ev.usage.cacheReadTokens;
    }
    expect(claudeText).toBe('Hello from Vertex Claude');
    expect(claudeCacheRead).toBe(15);
    expect(seen.claudePath).toBe(
      '/v1/projects/proj/locations/global/publishers/anthropic/models/claude-sonnet-4-5%4020250929:streamRawPredict',
    );
    expect(seen.claudeAuth).toBe('Bearer ya29.vertex-access-token');
    expect(seen.claudeApiKey).toBeNull();
    expect(seen.claudeBody?.anthropic_version).toBe('vertex-2023-10-16');
    expect(seen.claudeBody?.model).toBeUndefined();
    expect(JSON.stringify(seen.claudeBody)).toContain('"cache_control":{"type":"ephemeral"}');
  });

  test('AWS Bedrock Converse (SigV4 + cachePoint fallback), ConverseStream EventStream (Bearer API key), and Catalog', async () => {
    const modelId = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
    const seen: {
      converseAttempts: number;
      sigV4Auth?: string | null;
      sigV4Date?: string | null;
      sigV4Session?: string | null;
      firstAttemptHadCachePoint?: boolean;
      secondAttemptHadCachePoint?: boolean;
      streamBearer?: string | null;
    } = {converseAttempts: 0};

    const base = startServer(async req => {
      const url = new URL(req.url);
      if (url.pathname === '/foundation-models') {
        expect(req.headers.get('authorization')).toStartWith('AWS4-HMAC-SHA256 ');
        return Response.json({
          modelSummaries: [
            {
              modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
              modelName: 'Claude Sonnet 4.5',
              inputModalities: ['TEXT', 'IMAGE'],
              outputModalities: ['TEXT'],
              responseStreamingSupported: true,
            },
            {
              modelId: 'amazon.titan-embed-text-v2:0',
              modelName: 'Titan Embed',
              inputModalities: ['TEXT'],
              outputModalities: ['EMBEDDING'],
              responseStreamingSupported: false,
            },
          ],
        });
      }
      if (url.pathname.endsWith('/converse')) {
        seen.converseAttempts++;
        seen.sigV4Auth = req.headers.get('authorization');
        seen.sigV4Date = req.headers.get('x-amz-date');
        seen.sigV4Session = req.headers.get('x-amz-security-token');
        const bodyText = await req.text();
        if (seen.converseAttempts === 1) {
          seen.firstAttemptHadCachePoint = bodyText.includes('"cachePoint"');
          return Response.json(
            {message: 'ValidationException: cachePoint is not supported for this model'},
            {status: 400},
          );
        }
        seen.secondAttemptHadCachePoint = bodyText.includes('"cachePoint"');
        return Response.json({
          output: {
            message: {
              role: 'assistant',
              content: [{text: 'Hello from Bedrock SigV4'}],
            },
          },
          stopReason: 'end_turn',
          usage: {inputTokens: 30, outputTokens: 7, totalTokens: 37},
        });
      }
      if (url.pathname.endsWith('/converse-stream')) {
        seen.streamBearer = req.headers.get('authorization');
        const bytes = encodeBedrockEventStream([
          {eventType: 'messageStart', payload: {role: 'assistant'}},
          {eventType: 'contentBlockStart', payload: {contentBlockIndex: 0, start: {}}},
          {
            eventType: 'contentBlockDelta',
            payload: {contentBlockIndex: 0, delta: {text: 'Streamed from Bedrock'}},
          },
          {eventType: 'contentBlockStop', payload: {contentBlockIndex: 0}},
          {eventType: 'messageStop', payload: {stopReason: 'end_turn'}},
          {
            eventType: 'metadata',
            payload: {
              usage: {
                inputTokens: 40,
                outputTokens: 8,
                totalTokens: 48,
                cacheReadInputTokens: 25,
                cacheWriteInputTokens: 10,
              },
            },
          },
        ]);
        return new Response(new Uint8Array(bytes), {headers: {'content-type': 'application/vnd.amazon.eventstream'}});
      }
      return new Response(`unexpected ${url.pathname}`, {status: 404});
    });

    const sigv4Provider: Provider = {
      id: 'bedrock-sigv4',
      name: 'Bedrock SigV4',
      protocol: 'bedrock',
      baseURL: base,
      auth: 'aws-sigv4',
      catalog: 'bedrock',
      metadataVersion: 1,
      timeoutMs: 10000,
      aws: {region: 'us-east-1'},
    };
    const sigv4Secrets: string[] = [];
    const sigv4Transport = new ProviderTransport(
      sigv4Provider,
      makeAccount(sigv4Provider),
      memoryVault(),
      new ConfiguredNetworkPolicy(),
      fetch,
      undefined,
      undefined,
      {
        env: {
          AWS_ACCESS_KEY_ID: 'AKIATESTBEDROCK',
          AWS_SECRET_ACCESS_KEY: 'bedrock-super-secret-key',
          AWS_SESSION_TOKEN: 'bedrock-session-token',
        },
        homeDir: makeTempDir(),
        onSecret: s => sigv4Secrets.push(s),
      },
    );

    const gen = await new ProviderAdapter(sigv4Transport, modelId).generate(makeRequest(modelId));
    expect(gen.text).toBe('Hello from Bedrock SigV4');
    expect(seen.converseAttempts).toBe(2);
    expect(seen.firstAttemptHadCachePoint).toBe(true);
    expect(seen.secondAttemptHadCachePoint).toBe(false);
    expect(seen.sigV4Auth).toStartWith('AWS4-HMAC-SHA256 Credential=AKIATESTBEDROCK/');
    expect(seen.sigV4Auth).toContain('/us-east-1/bedrock/aws4_request');
    expect(seen.sigV4Date).toMatch(/^\d{8}T\d{6}Z$/);
    expect(seen.sigV4Session).toBe('bedrock-session-token');
    expect(sigv4Secrets).toContain('bedrock-super-secret-key');
    expect(sigv4Secrets).toContain('bedrock-session-token');

    const catalog = new ModelCatalog(memorySettings(), sigv4Transport);
    const discovered = await catalog.discover();
    expect(discovered.models).toHaveLength(2);
    const claude = discovered.models.find(m => m.id === 'anthropic.claude-sonnet-4-5-20250929-v1:0');
    expect(claude?.capabilities).toMatchObject({text: 'supported', vision: 'supported', streaming: 'supported'});
    const embed = discovered.models.find(m => m.id === 'amazon.titan-embed-text-v2:0');
    expect(embed?.capabilities.text).toBe('unsupported');

    const bearerProvider: Provider = {
      id: 'bedrock-key',
      name: 'Bedrock Key',
      protocol: 'bedrock',
      baseURL: base,
      auth: 'api-key',
      catalog: 'manual',
      metadataVersion: 1,
      timeoutMs: 10000,
      aws: {region: 'us-east-1'},
    };
    const keyId = crypto.randomUUID();
    const bearerTransport = new ProviderTransport(
      bearerProvider,
      makeAccount(bearerProvider, {kind: 'keyring', key: keyId}),
      memoryVault({[keyId]: 'ABSK-bedrock-bearer-key-123'}),
      new ConfiguredNetworkPolicy(),
    );
    let streamText = '';
    let cacheRead: number | null | undefined;
    let cacheWrite: number | null | undefined;
    for await (const ev of new ProviderAdapter(bearerTransport, modelId).stream(makeRequest(modelId))) {
      if (ev.type === 'textDelta') streamText += ev.text;
      if (ev.type === 'usage') {
        cacheRead = ev.usage.cacheReadTokens;
        cacheWrite = ev.usage.cacheWriteTokens;
      }
    }
    expect(streamText).toBe('Streamed from Bedrock');
    expect(seen.streamBearer).toBe('Bearer ABSK-bedrock-bearer-key-123');
    expect(cacheRead).toBe(25);
    expect(cacheWrite).toBe(10);
  });
});
