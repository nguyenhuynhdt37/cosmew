import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

/** Reuse legacy state in place; never copy credentials, restore grants or merge databases. */
export function defaultStateDirectory(
  environment: Record<string, string | undefined> = process.env,
  home = homedir(),
): string {
  const configured = environment.FUTRYN_HOME ?? environment.HANNES_HOME;
  if (configured !== undefined) return configured;
  const current = join(home, '.futryn'),
    legacy = join(home, '.hannes');
  return existsSync(current) || !existsSync(legacy) ? current : legacy;
}
