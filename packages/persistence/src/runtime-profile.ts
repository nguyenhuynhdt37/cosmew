import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { HannesError } from '@hannes/contracts';

/** Persistence owns every temporary runtime write. Only named credential files
 * may enter the vault; runtime logs, transcripts and workspace files cannot. */
export class RuntimeProfile {
  readonly directory: string;
  readonly workspace: string;
  constructor(root: string, private readonly allowed: readonly string[], settings: Record<string, string>, snapshot?: string) {
    const base = join(root, 'runtime-tmp');
    mkdirSync(base, { recursive: true, mode: 0o700 });
    if (lstatSync(base).isSymbolicLink() || (lstatSync(base).mode & 0o077)) throw new HannesError('STORAGE');
    this.directory = realpathSync(mkdtempSync(join(base, 'profile-')));
    this.workspace = join(this.directory, 'workspace');
    mkdirSync(this.workspace, { mode: 0o700 });
    try {
      this.write('empty-system-settings.json', '{}');
      if (snapshot) {
        const record = JSON.parse(snapshot);
        if (record.version !== 1 || !record.files || typeof record.files !== 'object') throw new HannesError('STORAGE');
        for (const [name, value] of Object.entries(record.files)) {
          if (!allowed.includes(name) || typeof value !== 'string' || Buffer.byteLength(value) > 65536) throw new HannesError('STORAGE');
          JSON.parse(value); this.write(name, value);
        }
      }
      for (const [name, value] of Object.entries(settings)) this.write(name, value);
    } catch { this.close(); throw new HannesError('STORAGE'); }
  }
  private write(name: string, value: string): void {
    const target = resolve(this.directory, name);
    if (!target.startsWith(this.directory + '/') || name.includes('..')) throw new HannesError('STORAGE');
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, value, { mode: 0o600, flag: 'wx' });
  }
  snapshot(): string {
    const files: Record<string, string> = {};
    for (const name of this.allowed) {
      const path = join(this.directory, name);
      let stat;
      try { stat = lstatSync(path); } catch { continue; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || !realpathSync(path).startsWith(this.directory + '/')) throw new HannesError('STORAGE');
      const raw = readFileSync(path, 'utf8'); JSON.parse(raw); files[name] = raw;
    }
    if (!Object.keys(files).length) throw new HannesError('AUTH');
    const payload = JSON.stringify({ version: 1, files });
    if (Buffer.byteLength(payload) > 65536) throw new HannesError('STORAGE');
    return payload;
  }
  close(): void { rmSync(this.directory, { recursive: true, force: true }); }
}
