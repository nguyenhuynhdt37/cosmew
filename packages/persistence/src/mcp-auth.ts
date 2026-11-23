import {MemoryDirectory} from './memory-directory';
import {createHash, randomUUID} from 'node:crypto';
import {chmodSync, lstatSync, mkdirSync, realpathSync} from 'node:fs';
import {basename, join, resolve} from 'node:path';
import {FutrynError, type CredentialVault} from '@cosmew/contracts';

interface Metadata {
  version: 2;
  endpoint: string;
  epoch: string;
  revision: string;
  key?: string;
}

/** Opaque MCP-only vault records. No model-provider credential is reused. */
export class FileMcpAuthStore {
  private readonly root: string;
  private canonicalRoot?: string;
  private authIdentity?: string;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    directory: string,
    private readonly vault: CredentialVault,
  ) {
    this.root = resolve(directory);
  }
  private paths(endpoint: string) {
    const url = new URL(endpoint);
    if (url.username || url.password || url.hash) throw new FutrynError('INVALID_INPUT');
    const canonical = url.href;
    const hash = createHash('sha256').update(`cosmew-mcp-auth-v1:${canonical}`).digest('hex');
    const key = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    return {canonical, key, file: join(this.root, 'mcp-auth', `${hash}.json`)};
  }
  private safeDirectory() {
    mkdirSync(this.root, {recursive: true, mode: 0o700});
    const rootStat = lstatSync(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new FutrynError('STORAGE');
    const canonical = realpathSync(this.root);
    if (this.canonicalRoot && canonical !== this.canonicalRoot) throw new FutrynError('STORAGE');
    this.canonicalRoot = canonical;
    const directory = join(this.root, 'mcp-auth');
    try {
      mkdirSync(directory, {mode: 0o700});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new FutrynError('STORAGE');
    const identity = `${stat.dev}:${stat.ino}`;
    if (this.authIdentity && this.authIdentity !== identity) throw new FutrynError('STORAGE');
    this.authIdentity = identity;
    if (process.platform !== 'win32') chmodSync(directory, 0o700);
  }
  private metadata(endpoint: string) {
    this.safeDirectory();
    const identity = this.paths(endpoint);
    const directory = MemoryDirectory.openPrivate(join(this.root, 'mcp-auth'));
    try {
      const raw = directory.read(basename(identity.file), 2048);
      if (raw === undefined) return undefined;
      const data = JSON.parse(raw);
      if (
        data.version !== 2 ||
        data.endpoint !== identity.canonical ||
        typeof data.epoch !== 'string' ||
        typeof data.revision !== 'string' ||
        (data.key !== undefined && !/^[0-9a-f-]{36}$/.test(data.key))
      )
        throw new Error();
      return data as Metadata;
    } catch {
      throw new FutrynError('STORAGE');
    } finally {
      directory.close();
    }
  }

  async read(endpoint: string): Promise<unknown | undefined> {
    await this.pending;
    let metadata = this.metadata(endpoint);
    if (!metadata) {
      await this.locked(endpoint, async () => {
        if (!this.metadata(endpoint))
          this.publish(endpoint, {
            version: 2,
            endpoint: this.paths(endpoint).canonical,
            epoch: randomUUID(),
            revision: randomUUID(),
          });
      });
      metadata = this.metadata(endpoint)!;
    }
    const encoded = metadata.key ? await this.vault.get({kind: 'keyring', key: metadata.key}) : undefined;
    const current = this.metadata(endpoint);
    if (current?.revision !== metadata.revision) throw new FutrynError('STORAGE');
    try {
      const value = encoded
        ? JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
        : {endpoint: metadata.endpoint};
      return {...value, _storeEpoch: metadata.epoch, _storeRevision: metadata.revision};
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
  private async locked(endpoint: string, action: () => Promise<void>) {
    this.safeDirectory();
    const directory = MemoryDirectory.openPrivate(join(this.root, 'mcp-auth'));
    const name = `.oauth-${this.paths(endpoint).key}`;
    const deadline = Date.now() + 10_000;
    try {
      while (!directory.lock(name, 0)) {
        if (Date.now() >= deadline) throw new FutrynError('STORAGE');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      this.safeDirectory();
      await action();
    } finally {
      directory.close();
    }
  }

  private publish(endpoint: string, metadata: Metadata) {
    this.safeDirectory();
    const directory = MemoryDirectory.openPrivate(join(this.root, 'mcp-auth'));
    try {
      directory.atomic(basename(this.paths(endpoint).file), JSON.stringify(metadata));
    } finally {
      directory.close();
    }
  }

  private mutate(action: () => Promise<void>): Promise<void> {
    const result = this.pending.catch(() => {}).then(action);
    this.pending = result.catch(() => {});
    return result;
  }
  write(endpoint: string, value: unknown): Promise<void> {
    return this.mutate(() =>
      this.locked(endpoint, async () => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FutrynError('INVALID_INPUT');
        const record = value as Record<string, unknown>;
        const previous = this.metadata(endpoint);
        if (previous?.revision !== record._storeRevision || previous?.epoch !== record._storeEpoch)
          throw new FutrynError('STORAGE');
        const {_storeEpoch: ignoredEpoch, _storeRevision: ignoredRevision, ...contents} = record;
        void ignoredEpoch;
        void ignoredRevision;
        const encoded = Buffer.from(JSON.stringify(contents)).toString('base64url');
        if (encoded.length > 8192) throw new FutrynError('INVALID_INPUT');
        // Immutable references prevent an interrupted/stale write from replacing active vault data.
        const key = randomUUID();
        await this.vault.set(key, encoded);
        try {
          this.publish(endpoint, {
            version: 2,
            endpoint: this.paths(endpoint).canonical,
            epoch: previous?.epoch ?? randomUUID(),
            revision: randomUUID(),
            key,
          });
        } catch (error) {
          await this.vault.delete({kind: 'keyring', key});
          throw error;
        }
        if (previous?.key) await this.vault.delete({kind: 'keyring', key: previous.key});
      }),
    );
  }
  delete(endpoint: string): Promise<void> {
    return this.mutate(() =>
      this.locked(endpoint, async () => {
        let previous: Metadata | undefined;
        try {
          previous = this.metadata(endpoint);
        } catch {
          /* Logout replaces corrupt reference metadata. */
        }
        // Durable tombstones fence other processes even when no token currently exists.
        this.publish(endpoint, {
          version: 2,
          endpoint: this.paths(endpoint).canonical,
          epoch: randomUUID(),
          revision: randomUUID(),
        });
        if (previous?.key) await this.vault.delete({kind: 'keyring', key: previous.key});
      }),
    );
  }
}
