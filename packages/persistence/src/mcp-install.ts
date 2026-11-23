import {
  constants,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {dirname, join, resolve} from 'node:path';

export interface ManagedMcpInstallRecord {
  installationId: string;
  packageName: string;
  version: string;
  integrity: string;
  state: 'installing' | 'ready';
  bin?: string;
}
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Owns only UUID directories created here. Config registration belongs to the manager. */
export class FileMcpInstallStore {
  readonly directory: string;
  constructor(stateDirectory: string) {
    this.directory = join(resolve(stateDirectory), 'mcp-packages');
  }
  private ensure(): void {
    const ancestors: string[] = [];
    for (let path = this.directory; ; path = dirname(path)) {
      ancestors.unshift(path);
      if (path === dirname(path)) break;
    }
    for (const path of ancestors) {
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe installation directory.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        mkdirSync(path, {mode: 0o700});
      }
    }
    const stat = lstatSync(this.directory);
    if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
      throw new Error('Installation directory must be private and owned by this user.');
  }
  path(id: string): string {
    if (!ID.test(id)) throw new Error('Invalid installation identity.');
    return join(this.directory, id);
  }
  begin(input: Omit<ManagedMcpInstallRecord, 'installationId' | 'state'>): ManagedMcpInstallRecord {
    this.ensure();
    const record: ManagedMcpInstallRecord = {...input, installationId: crypto.randomUUID(), state: 'installing'};
    const directory = this.path(record.installationId);
    mkdirSync(directory, {mode: 0o700});
    writeFileSync(join(directory, '.cosmew-owner'), record.installationId, {mode: 0o600, flag: 'wx'});
    this.write(record);
    return record;
  }
  read(id: string): ManagedMcpInstallRecord {
    this.assertOwned(id);
    const file = join(this.path(id), 'installation.json');
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const raw = readFileSync(fd, 'utf8');
      if (raw.length > 16_384) throw new Error('Invalid installation manifest.');
      const record = JSON.parse(raw) as ManagedMcpInstallRecord;
      if (
        record.installationId !== id ||
        !['installing', 'ready'].includes(record.state) ||
        typeof record.packageName !== 'string' ||
        typeof record.version !== 'string' ||
        typeof record.integrity !== 'string'
      )
        throw new Error('Invalid installation manifest.');
      return record;
    } finally {
      closeSync(fd);
    }
  }
  ready(id: string, bin: string): ManagedMcpInstallRecord {
    const record = {...this.read(id), state: 'ready' as const, bin};
    this.write(record);
    return record;
  }
  list(): ManagedMcpInstallRecord[] {
    this.ensure();
    return readdirSync(this.directory)
      .filter(id => ID.test(id))
      .flatMap(id => {
        try {
          return [this.read(id)];
        } catch {
          return [];
        }
      });
  }
  remove(id: string): void {
    this.assertOwned(id);
    // rm removes nested symlinks themselves; it does not traverse their targets.
    rmSync(this.path(id), {recursive: true, force: false});
  }
  private assertOwned(id: string): void {
    this.ensure();
    const directory = this.path(id);
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error('Unowned installation.');
    const fd = openSync(join(directory, '.cosmew-owner'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (readFileSync(fd, 'utf8') !== id) throw new Error('Unowned installation.');
    } finally {
      closeSync(fd);
    }
  }
  private write(record: ManagedMcpInstallRecord): void {
    this.assertOwned(record.installationId);
    const temporary = join(this.path(record.installationId), `.${crypto.randomUUID()}.tmp`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      writeFileSync(fd, JSON.stringify(record) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, join(this.path(record.installationId), 'installation.json'));
  }
}
