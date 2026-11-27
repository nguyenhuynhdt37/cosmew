import {lstatSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {isAbsolute, join} from 'node:path';
import {FutrynError} from '@cosmew/contracts';
import type {AwsSigV4Credentials} from './aws-sigv4';

const MAX_AWS_FILE_BYTES = 256 * 1024;
const VALID_PROFILE = /^[A-Za-z0-9._-]{1,100}$/;

export interface ResolveAwsCredentialsOptions {
  /** Explicit profile name from user host config; when set, never silently falls back to ambient env keys. */
  profile?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  onSecret?: (secret: string) => void;
}

/** Read one bounded, regular (non-symlink) INI file. Returns null when absent or unsafe. */
function readSafeIniFile(path: string): string | null {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_AWS_FILE_BYTES) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Parse AWS INI sections (`[default]`, `[profile foo]`) without executing any embedded commands. */
export function parseAwsIni(text: string): Map<string, Record<string, string>> {
  const sections = new Map<string, Record<string, string>>();
  let current: Record<string, string> | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      const name = line.slice(1, -1).trim();
      if (!name) {
        current = undefined;
        continue;
      }
      current = sections.get(name) ?? {};
      sections.set(name, current);
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (key) current[key] = value;
  }
  return sections;
}

function resolveFilePath(envPath: string | undefined, fallback: string, homeDir: string): string | null {
  if (!envPath) return fallback;
  const trimmed = envPath.trim();
  if (!trimmed) return fallback;
  if (trimmed.startsWith('~/')) return join(homeDir, trimmed.slice(2));
  if (!isAbsolute(trimmed)) return null;
  return trimmed;
}

function isValidKey(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\r\n\x00-\x1f\x7f]/.test(value);
}

/**
 * Resolve AWS SigV4 credentials strictly from explicit user-controlled sources:
 * 1. Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_SESSION_TOKEN`)
 *    when no explicit `profile` is pinned in host config.
 * 2. Shared AWS INI files (`~/.aws/credentials` and `~/.aws/config`, regular non-symlink files <= 256 KiB).
 *
 * Security invariants:
 * - Never executes `credential_process` from `~/.aws/config` (use Cosmew's explicit `auth.command` instead).
 * - Never queries EC2/ECS link-local metadata endpoints (`169.254.169.254`).
 * - Immediately registers secret key and session token with `onSecret` for redaction.
 */
export function resolveAwsCredentials(options: ResolveAwsCredentialsOptions = {}): AwsSigV4Credentials {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();

  if (!options.profile) {
    const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim();
    const secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim();
    const sessionToken = env.AWS_SESSION_TOKEN?.trim() || undefined;
    if (isValidKey(accessKeyId) && isValidKey(secretAccessKey)) {
      options.onSecret?.(secretAccessKey);
      if (sessionToken && isValidKey(sessionToken)) options.onSecret?.(sessionToken);
      return {
        accessKeyId,
        secretAccessKey,
        ...(sessionToken && isValidKey(sessionToken) ? {sessionToken} : {}),
      };
    }
  }

  const profileName = (options.profile ?? env.AWS_PROFILE ?? env.AWS_DEFAULT_PROFILE ?? 'default').trim();
  if (!VALID_PROFILE.test(profileName)) throw new FutrynError('AUTH');

  const credentialsPath = resolveFilePath(
    env.AWS_SHARED_CREDENTIALS_FILE,
    join(homeDir, '.aws', 'credentials'),
    homeDir,
  );
  const configPath = resolveFilePath(env.AWS_CONFIG_FILE, join(homeDir, '.aws', 'config'), homeDir);

  const credentialsText = credentialsPath ? readSafeIniFile(credentialsPath) : null;
  const configText = configPath ? readSafeIniFile(configPath) : null;

  const credSection = credentialsText ? parseAwsIni(credentialsText).get(profileName) : undefined;
  const configSections = configText ? parseAwsIni(configText) : undefined;
  const configSection =
    configSections?.get(profileName === 'default' ? 'default' : `profile ${profileName}`) ??
    configSections?.get(profileName);

  const accessKeyId = (credSection?.aws_access_key_id ?? configSection?.aws_access_key_id)?.trim();
  const secretAccessKey = (credSection?.aws_secret_access_key ?? configSection?.aws_secret_access_key)?.trim();
  const sessionToken = (credSection?.aws_session_token ?? configSection?.aws_session_token)?.trim() || undefined;

  if (!isValidKey(accessKeyId) || !isValidKey(secretAccessKey)) {
    throw new FutrynError('AUTH');
  }
  options.onSecret?.(secretAccessKey);
  if (sessionToken && isValidKey(sessionToken)) options.onSecret?.(sessionToken);
  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken && isValidKey(sessionToken) ? {sessionToken} : {}),
  };
}
