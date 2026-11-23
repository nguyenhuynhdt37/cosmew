import {createHash} from 'node:crypto';
import {readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';

const roots = ['.cosmew', '.futryn', '.hannes'];
const files = ['settings.json', 'provider-auth.sqlite', 'config.toml', 'mcp.json', 'keybindings.json'];

function metadata(path: string): string | undefined {
  const stat = statSync(path, {bigint: true, throwIfNoEntry: false});
  if (!stat) return undefined;
  if (!stat.isFile()) throw new Error(`Expected a regular user state file at ${path}`);
  return `${stat.size}:${stat.mtimeNs}`;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function watchUserState(home: string): (metadataOnly?: boolean) => void {
  const baseline = roots.flatMap(root =>
    files.map(file => {
      const path = join(home, root, file);
      const original = metadata(path);
      return {path, metadata: original, hash: original === undefined ? undefined : sha256(path), reported: false};
    }),
  );

  return (metadataOnly = false) => {
    const failures: string[] = [];
    for (const entry of baseline) {
      if (metadataOnly && entry.reported) continue;
      try {
        const current = metadata(entry.path);
        const hashChanged =
          !metadataOnly && current !== undefined && current === entry.metadata && sha256(entry.path) !== entry.hash;
        if (current === entry.metadata && !hashChanged) continue;
        failures.push(`user state changed: ${entry.path}`);
      } catch {
        failures.push(`could not verify user state: ${entry.path}`);
      }
      entry.reported = true;
    }
    if (failures.length) throw new Error(`Cosmew test isolation violation:\n${failures.join('\n')}`);
  };
}
