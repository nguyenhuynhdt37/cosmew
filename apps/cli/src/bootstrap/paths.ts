import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

/** Reuse legacy state in place; never copy credentials, restore grants or merge databases. */
export function defaultStateDirectory(
  environment: Record<string, string | undefined> = process.env,
  home = homedir(),
): string {
  const configured = environment.COSMEW_HOME ?? environment.FUTRYN_HOME ?? environment.HANNES_HOME;
  if (configured !== undefined) return configured;
  const current = join(home, '.cosmew'),
    futryn = join(home, '.futryn'),
    legacy = join(home, '.hannes');
  if (existsSync(current)) return current;
  if (existsSync(futryn)) return futryn;
  if (existsSync(legacy)) return legacy;
  return current;
}
