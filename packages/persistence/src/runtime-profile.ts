import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { FutrynError } from '@futryn/contracts';

// Copilot CLI 1.0.107 writes this header before its otherwise strict JSON.
// Normalize only the known managed format, leaving strings (including tokens
// and URLs containing //) untouched. Vault documents remain strict JSON so
// nested credential values still participate in secret redaction.
function credentialDocument(name: string, raw: string): string {
  const text = name === 'config.json'
    ? raw.replace(/^\/\/ User settings belong in settings\.json\.\r?\n\/\/ This file is managed automatically\.\r?\n/, '')
    : raw;
  try { return JSON.stringify(JSON.parse(text)); }
  catch { throw new FutrynError('STORAGE'); }
}

/** Persistence owns every temporary runtime write. Only named credential files
 * may enter the vault; runtime logs, transcripts and workspace files cannot. */
export class RuntimeProfile {
  readonly directory: string;
  readonly workspace: string;
  constructor(root: string, private readonly allowed: readonly string[], settings: Record<string, string>, snapshot?: string) {
    const base = join(root, 'runtime-tmp');
    mkdirSync(base, { recursive: true, mode: 0o700 });
    if (lstatSync(base).isSymbolicLink() || (lstatSync(base).mode & 0o077)) throw new FutrynError('STORAGE');
    this.directory = realpathSync(mkdtempSync(join(base, 'profile-')));
    this.workspace = join(this.directory, 'workspace');
    mkdirSync(this.workspace, { mode: 0o700 });
    try {
      this.write('empty-system-settings.json', '{}');
      if (snapshot) {
        const record = JSON.parse(snapshot);
        if (record.version !== 1 || !record.files || typeof record.files !== 'object') throw new FutrynError('STORAGE');
        for (const [name, value] of Object.entries(record.files)) {
          if (!allowed.includes(name) || typeof value !== 'string' || Buffer.byteLength(value) > 65536) throw new FutrynError('STORAGE');
          this.write(name, credentialDocument(name, value));
        }
      }
      for (const [name, value] of Object.entries(settings)) this.write(name, value);
    } catch { this.close(); throw new FutrynError('STORAGE'); }
  }
  private write(name: string, value: string): void {
    const target = resolve(this.directory, name);
    if (!target.startsWith(this.directory + '/') || name.includes('..')) throw new FutrynError('STORAGE');
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, value, { mode: 0o600, flag: 'wx' });
  }
  snapshot(): string {
    const files: Record<string, string> = {};
    for (const name of this.allowed) {
      const path = join(this.directory, name);
      let stat;
      try { stat = lstatSync(path); } catch { continue; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || !realpathSync(path).startsWith(this.directory + '/')) throw new FutrynError('STORAGE');
      files[name] = credentialDocument(name, readFileSync(path, 'utf8'));
    }
    if (!Object.keys(files).length) throw new FutrynError('AUTH');
    const payload = JSON.stringify({ version: 1, files });
    if (Buffer.byteLength(payload) > 65536) throw new FutrynError('STORAGE');
    return payload;
  }
  close(): void { rmSync(this.directory, { recursive: true, force: true }); }
}
