import {expect, test} from 'bun:test';
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';

const root = resolve(import.meta.dir, '../..');

// Immutable decision/audit/delivery evidence retains the product name used at the time.
const historical = /^(?:docs\/(?:adr|audits|superpowers|delivery)\/|tests\/fixtures\/)/;

// Existing API identifiers remain callable by older SDK consumers (ADR 0076).
const apiAliases =
  /\b(?:FutrynError|HannesError|FutrynClient|HannesClient|FutrynBackendPorts|FutrynClientOptions|FutrynClientProvider|useFutrynClient|createFutrynClient|FutrynTuiOptions)\b/g;
// Published environment aliases and legacy state paths are still read/protected in place.
const compatibilityTokens = /(?:FUTRYN|HANNES)_[A-Z0-9_]+\b|\.(?:futryn|hannes)(?:-patch-)?|\buse-futryn-client\b/gi;
// Historical ADR/delivery paths must keep resolving after the rename.
const adrLinks = /(?:\.\.\/|docs\/)?(?:adr|delivery)\/[\w/-]*(?:futryn|hannes)[\w/-]*\.md/g;
// Fixture values and descriptions exercise old persisted data/API behavior, not product copy.
const fixtureFiles = /(?:\.test\.tsx?$|(?:test|colors|reference-colors)-fixture\.tsx?$)/;

type Exception = {files: RegExp; tokens: RegExp; reason: string};
const exceptions: Exception[] = [
  {
    files: /^tests\/contracts\/branding-guard\.test\.ts$/,
    tokens: /futryn|hannes/gi,
    reason: 'The guard itself must spell the prohibited names in scanner patterns and fixtures.',
  },
  {
    files: /^scripts\/environment\.ts$/,
    tokens: /(?:FUTRYN|HANNES)_/g,
    reason: 'Read-only environment fallback prefixes are constructed dynamically.',
  },
  {
    files: /^(?:CLAUDE|README)\.md$|^apps\/cli\/src\/index\.ts$/,
    tokens: /`(?:hannes(?: tui)?|futryn)`|bun run hannes|fyn, futryn, hannes/g,
    reason: 'Document the retained CLI aliases and persisted backend id.',
  },
  {
    files: /^(?:package|apps\/cli\/package)\.json$/,
    tokens: /"(?:hannes|futryn)"|@futryn\/[a-z-]+|https:\/\/github\.com\/nguyenhuynhdt37\/futryn\.git/g,
    reason: 'CLI/workspace aliases and the actual upstream repository URL remain compatible.',
  },
  {
    files: /^apps\/cli\/src\/bootstrap\/paths\.ts$/,
    tokens: /\bfutryn\b/g,
    reason: 'The legacy state resolver names its existing directory candidate.',
  },
  {
    files: /^apps\/tui\/src\/ink\/integrated-shell\.tsx$/,
    tokens: /futryn-(?:edit|plan-edit|transcript)-/g,
    reason: 'Existing internal temporary-file prefixes; this file is owned by the concurrent run.',
  },
  {
    files: /^apps\/tui\/src\/theme\/(?:compat|presets|theme|wallpaper)\.ts$|^packages\/contracts\/src\/models\.ts$/,
    tokens: /futryn-spark|futryn-default|(['"])futryn\1/g,
    reason: 'Persisted theme ids and import/export sourceFormat values must remain readable.',
  },
  {
    files: /^packages\/(?:contracts\/src\/models|sdk\/src\/client|models\/src\/registry)\.ts$/,
    tokens: /(['"`])hannes\1/g,
    reason: 'Persisted execution backend and loop/tool owner ids are unchanged.',
  },
  {
    files: /^packages\/contracts\/src\/permissions\.ts$/,
    tokens: /__futryn_unrelated_command__/g,
    reason: 'Stable internal sentinel used to reject overbroad command rules.',
  },
  {
    files: /^packages\/models\/src\/adapter\.ts$/,
    tokens: /hannes-no-credential|futryn-prompt-cache:|futryn-/g,
    reason: 'Existing provider placeholder and cache-key namespace preserve cache identity.',
  },
  {
    files: /^packages\/security\/src\/secrets\.ts$/,
    tokens: /hannes\.provider-auth\.v1/g,
    reason: 'OS keyring service identity cannot change without migrating credentials.',
  },
  {
    files: /^packages\/security\/src\/tool-policy\.ts$/,
    tokens: /hannes-state/g,
    reason: 'Stable policy denial code is consumed by existing clients.',
  },
  {
    files: /^packages\/tools\/src\/exec\/native\.ts$/,
    tokens: /COSMEW\|FUTRYN\|HANNES|futryn-service/g,
    reason: 'Redact all historical environment prefixes and retain the internal supervisor label.',
  },
  {
    files: /^packages\/tools\/src\/exec\/seatbelt-profile\.ts$/,
    tokens: /futryn\|hannes/g,
    reason: 'Seatbelt must protect both legacy state roots and patch files.',
  },
  {
    files: /^packages\/workspace\/src\/worktrees\.ts$/,
    tokens: /futryn-worktrees-|futryn\/agent-/g,
    reason: 'Existing worktree/branch namespace supports retained isolated sessions.',
  },
  {
    files: /^docs\/architecture\/repository-map\.md$/,
    tokens: /examples\/hannes-plugin/g,
    reason: 'Historical planned example path is a repository-map reference.',
  },
  {
    files: /^tests\/contracts\/cosmew-compatibility\.test\.ts$/,
    tokens: /\b(?:futryn|hannes)\b/g,
    reason: 'Legacy-root resolver fixtures name the two directory candidates.',
  },
  {
    files: /^tests\/(?:contracts\/host-config|end-to-end\/host-providers)\.test\.ts$/,
    tokens: /Futryn|futryn\.dev/g,
    reason: 'User-supplied X-Title/Referer fixture values round-trip without rebranding.',
  },
  {
    files: /^tests\/contracts\/project-branding\.test\.ts$/,
    tokens: /Hannes/g,
    reason: 'Negative branding assertion must still reject the previous product heading.',
  },
  {
    files: /^tests\/contracts\/provider-adapters\.test\.ts$/,
    tokens: /futryn-/g,
    reason: 'Assert the stable provider cache-key namespace.',
  },
  {
    files: /^tests\/contracts\/(?:subagent-definitions|subagents-s5c)\.test\.ts$/,
    tokens: /nearer futryn|futryn\/agent-/g,
    reason: 'Assert legacy fixture descriptions and existing worktree branch names.',
  },
  {
    files: /^tests\/security\/claude-sandbox\.test\.ts$/,
    tokens: /futryn\|hannes/g,
    reason: 'Assert that generated Seatbelt regexes protect both legacy roots.',
  },
  {
    files: /^tests\/(?:security\/native-exec|end-to-end\/exec-command)\.test\.ts$/,
    tokens: /Futryn|FUTRYN/g,
    reason: 'Multiline native acceptance test titles retain historical evidence labels.',
  },
  {
    files:
      /^(?:reports\/Xử lý ngữ cảnh agent\.md|research_notes\/(?:Codex OpenCode Futryn audit\/repo|Xử lý ngữ cảnh agent\/(?:claude|codex|opencode))\.md)$/,
    tokens: /(?:futryn|hannes)/gi,
    reason: 'Dated read-only research/audit evidence retains its original subject and local paths.',
  },
];

function unexplained(file: string, line: string): string {
  let text = line.replace(apiAliases, '').replace(compatibilityTokens, '').replace(adrLinks, '');
  if (fixtureFiles.test(file)) {
    // Disposable fixture paths, synthetic environment values and persisted backend/theme ids.
    text = text.replace(/(['"`])(?:futryn|hannes)[\w/-]*|\/(?:futryn|hannes)[\w/-]*/g, '');
    if (/^\s*(?:\*|\/\/)/.test(line)) text = text.replace(/(?:futryn|hannes)(?:-default)?/gi, '');
    // Test descriptions are historical behavioral evidence, never shipped product copy.
    if (/^\s*(?:test|describe|nativeTest)\(/.test(line)) text = text.replace(/futryn|hannes/gi, '');
  }
  for (const exception of exceptions) if (exception.files.test(file)) text = text.replace(exception.tokens, '');
  return text;
}

test('tracked text has no unexplained legacy product branding', () => {
  const files = execFileSync('git', ['-c', 'core.fsmonitor=false', 'ls-files', '-z'], {encoding: 'utf8', cwd: root})
    .split('\0')
    .filter(Boolean);
  const offenders: string[] = [];
  for (const file of files) {
    if (!/\.(?:ts|tsx|md|json|toml|sh)$/.test(file) || historical.test(file)) continue;
    for (const [index, line] of readFileSync(resolve(root, file), 'utf8').split('\n').entries()) {
      if (/futryn|hannes/i.test(unexplained(file, line))) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    }
  }
  console.log(`Branding offenders: ${offenders.length}`);
  expect(offenders, offenders.join('\n')).toEqual([]);
});

test('compatibility exceptions still expose unrelated product copy on the same line', () => {
  expect(unexplained('apps/cli/src/exec.ts', 'FutrynError: Futryn is ready')).toContain('Futryn is ready');
  expect(unexplained('apps/tui/src/ink/integrated-shell.tsx', "const dir = 'futryn-edit-'; // Hannes app")).toContain(
    'Hannes app',
  );
  expect(unexplained('packages/core/src/agent/turn.ts', 'HANNES is the product')).toContain('HANNES');
});

test('README local document links resolve', () => {
  const broken: string[] = [];
  for (const file of ['README.md', 'docs/README.md']) {
    const markdown = readFileSync(resolve(root, file), 'utf8');
    for (const match of markdown.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1]!;
      if (/^[a-z]+:|^#/i.test(target)) continue;
      if (!existsSync(resolve(root, dirname(file), decodeURIComponent(target.split('#')[0]!)))) {
        broken.push(`${file}: ${target}`);
      }
    }
  }
  expect(broken, broken.join('\n')).toEqual([]);
});
