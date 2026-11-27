import {spawnSync} from 'node:child_process';
import {existsSync, renameSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {CosmewError} from '@cosmew/contracts';

const LEGACY_DIRECTORIES = ['.futryn', '.hannes'] as const;
const notices: string[] = [];
const noted = new Set<string>();

function note(text: string): void {
  if (noted.has(text)) return;
  noted.add(text);
  notices.push(text);
}

export function takeStateMigrationNotices(): string[] {
  return notices.splice(0);
}

/** Another live Cosmew process holding the database must exit before the directory can move. */
function databaseIsOpen(path: string): boolean {
  if (process.platform === 'win32' || !existsSync(path)) return false;
  const probe = spawnSync('lsof', ['-t', '--', path], {encoding: 'utf8'});
  if (probe.error || probe.status !== 0) return false;
  return probe.stdout.split(/\s+/).some(pid => pid && pid !== String(process.pid));
}

/**
 * Return `parent/.cosmew`, moving one legacy directory there when the canonical directory is absent.
 * Never merges two databases and never reads a leftover legacy directory after `.cosmew` exists.
 */
export function adoptLegacyStateDirectory(parent: string): string {
  const target = join(parent, '.cosmew');
  if (existsSync(target)) {
    for (const name of LEGACY_DIRECTORIES) {
      if (existsSync(join(parent, name)))
        note(`Left ${name} in place because .cosmew already exists. It is not read or merged.`);
    }
    return target;
  }
  for (const name of LEGACY_DIRECTORIES) {
    const legacy = join(parent, name);
    if (!existsSync(legacy)) continue;
    if (databaseIsOpen(join(legacy, 'provider-auth.sqlite'))) {
      const error = new CosmewError('STORAGE');
      error.message = `Close other Cosmew processes before moving ${name} to .cosmew.`;
      throw error;
    }
    try {
      // Same-filesystem rename keeps credential files and their inodes. No copy, no merge.
      renameSync(legacy, target);
    } catch {
      const error = new CosmewError('STORAGE');
      error.message = `Could not move ${name} to .cosmew. Close other Cosmew processes and retry.`;
      throw error;
    }
    note(`Moved ${name} to .cosmew.`);
    return target;
  }
  return target;
}

/** `COSMEW_HOME` when set; otherwise `~/.cosmew` after a one-time legacy move. */
export function defaultStateDirectory(
  environment: Record<string, string | undefined> = process.env,
  home = homedir(),
): string {
  if (environment.COSMEW_HOME !== undefined) return environment.COSMEW_HOME;
  return adoptLegacyStateDirectory(home);
}
