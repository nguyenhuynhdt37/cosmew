# ADR 0122 — Enterprise Cloud Providers: AWS Bedrock, Google Vertex AI & Azure OpenAI

Date: 2026-11-27. Status: implemented (contract 1.67).

## Context

Enterprise teams frequently access frontier coding models through their own cloud tenants rather than consumer API keys:
- **AWS Bedrock** (Converse API & ConverseStream EventStream, IAM SigV4 or Bedrock API Keys).
- **Google Vertex AI** (Gemini publishers via `generateContent`/`streamGenerateContent` and Anthropic Claude publishers via `rawPredict`/`streamRawPredict`, authenticated via Service Account / ADC OAuth2 tokens, `gcloud` token command, or Express API keys).
- **Azure OpenAI / Azure AI Foundry** (v1 Responses/Chat endpoints and deployment-based `/openai/deployments/{deployment}` endpoints, authenticated via `api-key` header or Microsoft Entra ID `Bearer` token commands).

Previously, `~/.cosmew/config.toml` refused `aws`, `project_id`, `location`, and `credential_file` fields, and `protocolSchema` only covered `chat`, `responses`, `anthropic`, and `gemini`.

## Decision

### 1. Contract 1.67 Schema Extensions
- Extend `protocolSchema` to: `chat | responses | anthropic | gemini | azure | bedrock | vertex | vertex-anthropic`.
- Extend `providerSchema.auth` to add `aws-sigv4` and `google-adc`, and `providerSchema.catalog` to add `bedrock`.
- Add non-secret cloud metadata blocks on `providerSchema`:
  - `aws?: {region, profile?}`
  - `vertex?: {projectId, location, credentialFile?}`
  - `azure?: {apiVersion?, apiMode?, useDeploymentBasedUrls?}`
- Extend `providerReplaySchema` so `azure` (Responses mode) replays OpenAI encrypted reasoning, `vertex` replays Gemini `thoughtSignature`, `vertex-anthropic` replays Anthropic `signature`/`redactedData`, and `bedrock` replays Bedrock `signature`/`redactedData`.

### 2. Wire Adapters & Controlled Dependencies
- **AWS Bedrock (`wire_api = "bedrock"`)**:
  - Pin `@ai-sdk/amazon-bedrock@5.0.142` (Apache-2.0, matching `@ai-sdk/provider@4.0.38` and `@ai-sdk/provider-utils@5.0.81` in `bun.lock`) for Converse / ConverseStream EventStream framing, tool use, multimodal inputs, reasoning, and `cachePoint` prompt caching (with HTTP 400 fallback when unsupported by a model).
  - Disable ambient SDK credential fallback by supplying a managed placeholder key to `createAmazonBedrock` and stripping it before `ProviderTransport.request()`. Cosmew owns both Bedrock Bearer API key injection and per-request **AWS SigV4** (`packages/models/src/aws-sigv4.ts`) applied *after* `decorate()` on every attempt/retry so custom headers, query params, and timestamps never invalidate signatures.
  - Model catalog (`catalog = "bedrock"`): only when `baseURL` is an official `https://bedrock-runtime.<region>.amazonaws.com*` endpoint may `ProviderTransport` call the paired control-plane origin `https://bedrock.<region>.amazonaws.com/foundation-models` (and `/inference-profiles`), still signed with SigV4 or Bearer auth.
- **Google Vertex AI (`wire_api = "vertex"` & `wire_api = "vertex-anthropic"`)**:
  - Zero new dependencies: `vertex` reuses `@ai-sdk/google` directly against `https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google` (or `aiplatform.googleapis.com` for `location = "global"`).
  - `vertex-anthropic` reuses `@ai-sdk/anthropic` (preserving prompt caching, thinking budgets/effort, replay, and inline tool media) while rewriting requests to `/models/{model}:streamRawPredict`/`:rawPredict` with `anthropic_version: "vertex-2023-10-16"` and removing `model` from the JSON body.
  - `packages/models/src/google-auth.ts` implements pure `node:crypto` RS256 Service Account JWT exchange and `authorized_user` refresh-token exchange against `https://oauth2.googleapis.com/token`, avoiding `google-auth-library` and its ambient metadata-server calls.
- **Azure OpenAI / AI Foundry (`wire_api = "azure"`)**:
  - Zero new dependencies: reuses `@ai-sdk/openai` (Responses API, default for `/openai/v1`) and `@ai-sdk/openai-compatible` (Chat Completions, default for deployment-based `/openai/deployments/{deployment}` URLs with `?api-version=...`).
  - `ProviderTransport` maps `api-key` auth to Azure's `api-key` header while preserving `Authorization: Bearer` for Microsoft Entra ID token commands (`az account get-access-token`).

### 3. Security Boundaries (Invariants Preserved)
- Cloud provider tables remain **user-level only** (`~/.cosmew/config.toml`); repository files never supply providers or credential file paths.
- `aws-auth.ts` reads only bounded regular non-symlink files (≤ 256 KiB) from `~/.aws/{credentials,config}`, **never executes `credential_process`**, and **never queries EC2/ECS IMDS (`169.254.169.254`)**. When an explicit `aws.profile` is set, it never silently falls back to ambient env keys.
- `google-auth.ts` accepts only absolute (or `~/`) non-symlink credential files (≤ 64 KiB) without `..` segments, restricts `token_uri` strictly to `https://oauth2.googleapis.com/token` and `https://www.googleapis.com/oauth2/v4/token`, refuses redirects, and never queries GCE IMDS.
- Every resolved secret (`secretAccessKey`, `sessionToken`, `private_key`, `refresh_token`, `client_secret`, OAuth access tokens) is immediately registered with `SecretRedactor` via `onSecret`.

## Verification Status

- Automated unit and local HTTP/EventStream integration fixtures (AWS SigV4 test vectors, RSA JWT verification, Azure v1 & deployment endpoints, Vertex Gemini & Claude `:streamRawPredict`, Bedrock Converse + binary AWS EventStream + SigV4 + Bearer + catalog) are verified under Bun 1.4.4.
- Live cloud verification against production AWS Bedrock, Google Vertex AI, and Azure OpenAI tenants remains **Needs verification**.
