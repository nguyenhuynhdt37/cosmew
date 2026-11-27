import {afterEach, describe, expect, test} from 'bun:test';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {
  domainAllowed,
  isSafeAlwaysRule,
  permissionRuleDecision,
  permissionRuleMatches,
  permissionRuleSchema,
  type PermissionRuleSet,
} from '@cosmew/contracts';
import {
  describeLoosening,
  emptySettingsFile,
  matchesExcludedCommand,
  mergeSettings,
  parseSettings,
  sandboxPathGlobs,
  settingsHash,
  splitRuleList,
  type SettingsLayer,
} from '@cosmew/security';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {parsePermissionFlags} from '../../apps/cli/src/bootstrap/commands';
import {FilePermissionSettings} from '../../apps/cli/src/bootstrap/permission-settings';
import {grantLabel} from '../../apps/cli/src/bootstrap/approvals';
import {WorkspaceRoot} from '@cosmew/workspace';
import {memoryVault} from '../fixtures';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

describe('rule syntax (Claude Code)', () => {
  test('accepted forms, with Write normalized to Edit; rejected forms', () => {
    for (const rule of [
      'Bash',
      'Bash(npm run test:*)',
      'Read(./src/**)',
      'Edit(**/*.ts)',
      'WebFetch(domain:example.com)',
      'WebSearch',
      'Tool(memory)',
      'mcp__github',
      'mcp__github__create_issue',
      'mcp__github__*',
    ])
      expect({rule, ok: permissionRuleSchema.safeParse(rule).success}).toEqual({rule, ok: true});
    expect(permissionRuleSchema.parse('Write(src/**)')).toBe('Edit(src/**)');
    for (const rule of [
      '',
      'Bash(',
      'Nonsense(x)',
      'Bash(a)(b)',
      'mcp__',
      'mcp__a b',
      'Network(curl:*)',
      'Unsandboxed(x)',
      'bash',
    ])
      expect({rule, ok: permissionRuleSchema.safeParse(rule).success}).toEqual({rule, ok: false});
  });

  test('Bash prefix, glob and exact matching', () => {
    const bash = (rule: string, target: string) => permissionRuleMatches(rule, {tool: 'Bash', target});
    expect(bash('Bash(npm run test:*)', 'npm run test')).toBe(true);
    expect(bash('Bash(npm run test:*)', 'npm run test -- --watch')).toBe(true);
    expect(bash('Bash(npm run test:*)', 'npm run tester')).toBe(false);
    expect(bash('Bash(git commit *)', 'git commit -m x')).toBe(true);
    expect(bash('Bash(ls)', 'ls -la')).toBe(false);
    expect(bash('Bash', 'anything')).toBe(true);
  });

  test('WebFetch(domain:...) matches the host and its subdomains, not look-alikes; WebSearch is a bare name', () => {
    const fetch = (rule: string, target: string) => permissionRuleMatches(rule, {tool: 'WebFetch', target});
    expect(fetch('WebFetch(domain:example.com)', 'https://example.com/a?b=1')).toBe(true);
    expect(fetch('WebFetch(domain:example.com)', 'https://docs.example.com/')).toBe(true);
    expect(fetch('WebFetch(domain:example.com)', 'https://evil-example.com/')).toBe(false);
    expect(fetch('WebFetch(domain:example.com)', 'https://example.com.evil.test/')).toBe(false);
    expect(fetch('WebFetch(domain:example.com)', 'example.com')).toBe(true);
    expect(permissionRuleMatches('WebSearch', {tool: 'WebSearch', target: 'web_search'})).toBe(true);
    expect(permissionRuleMatches('WebFetch', {tool: 'WebFetch', target: 'https://anything.test'})).toBe(true);
  });

  test('mcp__server__tool matches that tool, mcp__server the whole server, a wildcard the prefix', () => {
    const mcp = (rule: string, target: string) => permissionRuleMatches(rule, {tool: 'Mcp', target});
    expect(mcp('mcp__github__create_issue', 'mcp__github__create_issue')).toBe(true);
    expect(mcp('mcp__github__create_issue', 'mcp__github__delete_repo')).toBe(false);
    expect(mcp('mcp__github', 'mcp__github__delete_repo')).toBe(true);
    expect(mcp('mcp__github', 'mcp__githubx__tool')).toBe(false);
    expect(mcp('mcp__github__*', 'mcp__github__anything')).toBe(true);
    expect(mcp('mcp__github', 'Bash')).toBe(false);
    const rules: PermissionRuleSet = {allow: ['mcp__github'], ask: [], deny: ['mcp__github__delete_repo']};
    expect(permissionRuleDecision(rules, {tool: 'Mcp', target: 'mcp__github__delete_repo'})).toBe('deny');
    expect(permissionRuleDecision(rules, {tool: 'Mcp', target: 'mcp__github__list'})).toBe('allow');
    expect(isSafeAlwaysRule('mcp__github__create_issue')).toBe(true);
    expect(isSafeAlwaysRule('mcp__github')).toBe(false);
    expect(isSafeAlwaysRule('mcp__github__*')).toBe(false);
    expect(isSafeAlwaysRule('mcp__*')).toBe(false);
  });

  test('path rules: relative to the working directory, /x from the project root, //x absolute; no escaping the root', () => {
    const decide = (rules: Partial<PermissionRuleSet>, tool: 'Read' | 'Edit', target: string) =>
      permissionRuleDecision({allow: [], ask: [], deny: [], ...rules}, {tool, target});
    expect(decide({allow: ['Read(./src/**)']}, 'Read', 'src/a/b.ts')).toBe('allow');
    expect(decide({allow: ['Read(./src/**)']}, 'Read', 'lib/b.ts')).toBeUndefined();
    expect(decide({allow: ['Read(/src/**)']}, 'Read', 'src/a.ts')).toBe('allow');
    expect(decide({allow: ['Read(./src/**)']}, 'Read', 'src/../../.ssh/key')).toBeUndefined();
    expect(decide({deny: ['Edit(**/*.env)']}, 'Edit', 'config/prod.env')).toBe('deny');
    expect(decide({deny: ['Read(//etc/passwd)']}, 'Read', '/etc/passwd')).toBe('deny');
    expect(decide({deny: ['Read(./secrets)']}, 'Read', 'secrets/key.pem')).toBeUndefined();
    expect(decide({deny: ['Read(./secrets/**)']}, 'Read', 'secrets/key.pem')).toBe('deny');
  });

  test('domain patterns and sandbox path globs', () => {
    expect(domainAllowed('registry.npmjs.org', ['*.npmjs.org'])).toBe(true);
    expect(domainAllowed('npmjs.org', ['*.npmjs.org'])).toBe(false);
    expect(domainAllowed('Github.com', ['github.com'])).toBe(true);
    expect(domainAllowed('api.github.com', ['github.com'])).toBe(false);
    expect(
      sandboxPathGlobs(
        ['Read(./secrets/**)', 'Read(//etc/shadow)', 'Read(~/.kube/**)', 'Edit(/dist/**)', 'Bash(ls)'],
        'Read',
        '/p',
        '/h',
      ),
    ).toEqual(['/p/secrets/**', '/etc/shadow', '/h/.kube/**']);
    expect(sandboxPathGlobs(['Edit(/dist/**)', 'Read(x)'], 'Edit', '/p', '/h')).toEqual(['/p/dist/**']);
    expect(matchesExcludedCommand('git', 'git status')).toBe(true);
    expect(matchesExcludedCommand('git', 'gitk')).toBe(false);
    expect(matchesExcludedCommand('docker:*', 'docker compose up')).toBe(true);
    expect(matchesExcludedCommand('npm run *', 'npm run build')).toBe(true);
  });

  test('settings parsing drops invalid entries with diagnostics and survives bad JSON', () => {
    const {settings, diagnostics} = parseSettings(
      JSON.stringify({
        unrelated: {keep: true},
        permissions: {
          allow: ['Bash(ls)', 'Bogus(x)', 7],
          deny: ['Write(a)'],
          defaultMode: 'nope',
          additionalDirectories: ['../x'],
        },
        sandbox: {
          enabled: 'yes',
          network: {allowedDomains: ['Example.com', 'bad domain', '*.npmjs.org']},
          excludedCommands: ['git'],
        },
      }),
    );
    expect(settings.permissions.allow).toEqual(['Bash(ls)']);
    expect(settings.permissions.deny).toEqual(['Edit(a)']);
    expect(settings.permissions.defaultMode).toBeUndefined();
    expect(settings.sandbox.enabled).toBeUndefined();
    expect(settings.sandbox.allowedDomains).toEqual(['example.com', '*.npmjs.org']);
    expect(settings.sandbox.excludedCommands).toEqual(['git']);
    expect(diagnostics.length).toBeGreaterThanOrEqual(4);
    expect(parseSettings('{not json').diagnostics).toEqual(['not valid JSON; the file is ignored']);
    expect(parseSettings('[]').settings).toEqual(emptySettingsFile());
  });

  test('--allowedTools / --disallowedTools split on commas and spaces, keeping parentheses together', () => {
    expect(splitRuleList(['Bash(git log:*) Read,Edit', 'WebFetch(domain:a.com),mcp__x__y'])).toEqual({
      rules: ['Bash(git log:*)', 'Read', 'Edit', 'WebFetch(domain:a.com)', 'mcp__x__y'],
      invalid: [],
    });
    expect(splitRuleList(['Bash(ok) Bogus']).invalid).toEqual(['Bogus']);
    expect(parsePermissionFlags(['--allowedTools', 'Bash(ls:*) Edit', '--disallowedTools', 'Bash(rm:*)'])).toEqual({
      allow: ['Bash(ls:*)', 'Edit'],
      deny: ['Bash(rm:*)'],
    });
    expect(parsePermissionFlags(['--dangerously-skip-permissions'])).toEqual({mode: 'bypassPermissions'});
    expect(parsePermissionFlags(['--permission-mode', 'acceptEdits'])).toEqual({mode: 'acceptEdits'});
    expect(() => parsePermissionFlags(['--permission-mode', 'auto'])).toThrow();
    expect(() => parsePermissionFlags(['--dangerously-skip-permissions', '--permission-mode', 'plan'])).toThrow();
    expect(() => parsePermissionFlags(['--allowedTools', 'Bogus(x)'])).toThrow();
    for (const removed of [
      '--yolo',
      '--full-auto',
      '--sandbox',
      '--approval',
      '-a',
      '-s',
      '--dangerously-bypass-approvals-and-sandbox',
    ])
      expect(() => parsePermissionFlags([removed, 'x'])).toThrow();
  });
});

describe('merging and precedence', () => {
  const layer = (
    scope: SettingsLayer['scope'],
    trusted: boolean,
    edit: (file: ReturnType<typeof emptySettingsFile>) => void,
  ): SettingsLayer => {
    const file = emptySettingsFile();
    edit(file);
    return {scope, file, trusted, baseDir: '/project'};
  };

  test('local > project > user for scalars; lists accumulate; deny > ask > allow is applied by the engine', () => {
    const merged = mergeSettings(
      [
        layer('user', true, f => {
          f.permissions.defaultMode = 'plan';
          f.sandbox.autoAllowBashIfSandboxed = false;
          f.permissions.allow = ['Bash(ls:*)'];
          f.permissions.deny = ['Bash(rm:*)'];
        }),
        layer('project', true, f => {
          f.permissions.defaultMode = 'acceptEdits';
          f.permissions.allow = ['Bash(npm test:*)'];
          f.permissions.ask = ['Bash(git push:*)'];
        }),
        layer('local', true, f => {
          f.permissions.defaultMode = 'default';
          f.sandbox.autoAllowBashIfSandboxed = true;
          f.permissions.additionalDirectories = ['../shared', '/abs/dir', '~/cache'];
          f.sandbox.allowedDomains = ['github.com'];
        }),
      ],
      '/home/u',
    );
    expect(merged.defaultMode).toBe('default');
    expect(merged.sandbox.autoAllowBashIfSandboxed).toBe(true);
    expect(merged.rules.allow).toEqual(['Bash(npm test:*)', 'Bash(ls:*)']);
    expect(merged.rules.ask).toEqual(['Bash(git push:*)']);
    expect(merged.rules.deny).toEqual(['Bash(rm:*)']);
    expect(merged.additionalDirectories).toEqual(['/shared', '/abs/dir', '/home/u/cache']);
    expect(merged.sandbox.allowedDomains).toEqual(['github.com']);
    expect(merged.sandbox.enabled).toBe(false);
    expect(merged.sandbox.allowUnsandboxedCommands).toBe(true);
  });

  test('an untrusted layer contributes only what tightens', () => {
    const merged = mergeSettings(
      [
        layer('user', true, f => {
          f.permissions.allow = ['Bash(ls:*)'];
          f.sandbox.allowedDomains = ['github.com'];
        }),
        layer('project', false, f => {
          f.permissions.allow = ['Bash(curl:*)'];
          f.permissions.deny = ['Read(./secrets/**)'];
          f.permissions.ask = ['Bash(git push:*)'];
          f.permissions.defaultMode = 'bypassPermissions';
          f.permissions.additionalDirectories = ['/etc'];
          f.sandbox.enabled = false;
          f.sandbox.excludedCommands = ['curl'];
          f.sandbox.allowedDomains = ['evil.test'];
          f.sandbox.allowUnsandboxedCommands = true;
          f.sandbox.autoAllowBashIfSandboxed = true;
        }),
        layer('local', false, f => {
          f.permissions.defaultMode = 'plan';
          f.sandbox.allowUnsandboxedCommands = false;
          f.sandbox.autoAllowBashIfSandboxed = false;
          f.sandbox.enabled = true;
        }),
      ],
      '/home/u',
    );
    expect(merged.rules).toEqual({allow: ['Bash(ls:*)'], ask: ['Bash(git push:*)'], deny: ['Read(./secrets/**)']});
    expect(merged.defaultMode).toBe('plan');
    expect(merged.additionalDirectories).toEqual([]);
    expect(merged.sandbox).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: false,
      excludedCommands: [],
      allowUnsandboxedCommands: false,
      allowedDomains: ['github.com'],
    });
  });

  test('an untrusted layer cannot downgrade user defaultMode from plan to default', () => {
    const merged = mergeSettings(
      [
        layer('user', true, f => {
          f.permissions.defaultMode = 'plan';
        }),
        layer('project', false, f => {
          f.permissions.defaultMode = 'default';
        }),
      ],
      '/home/u',
    );
    expect(merged.defaultMode).toBe('plan');
  });

  test('what a file would grant is listed for the trust prompt; tightening-only files need none', () => {
    const file = emptySettingsFile();
    expect(describeLoosening(file)).toEqual([]);
    file.permissions.deny = ['Bash(rm:*)'];
    file.permissions.ask = ['Bash(git push:*)'];
    file.permissions.defaultMode = 'plan';
    file.sandbox.enabled = true;
    file.sandbox.allowUnsandboxedCommands = false;
    expect(describeLoosening(file)).toEqual([]);
    file.permissions.allow = ['Bash(npm test:*)'];
    file.permissions.defaultMode = 'bypassPermissions';
    file.sandbox.enabled = false;
    file.sandbox.excludedCommands = ['git'];
    file.sandbox.allowedDomains = ['x.test'];
    file.permissions.additionalDirectories = ['../y'];
    expect(describeLoosening(file)).toEqual([
      'allow rule: Bash(npm test:*)',
      'defaultMode: bypassPermissions',
      'additional directory: ../y',
      'sandbox.enabled: false (commands run without the OS sandbox)',
      'excluded from the sandbox: git',
      'network domain: x.test',
    ]);
  });
});

function project() {
  const home = mkdtempSync(join(tmpdir(), 'futryn-settings-home-'));
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'futryn-settings-ws-')));
  cleanup.push(
    () => rmSync(home, {recursive: true, force: true}),
    () => rmSync(root, {recursive: true, force: true}),
  );
  const write = (scope: 'user' | 'project' | 'local', value: unknown) => {
    const path =
      scope === 'user'
        ? join(home, 'settings.json')
        : join(root, '.cosmew', scope === 'project' ? 'settings.json' : 'settings.local.json');
    mkdirSync(join(path, '..'), {recursive: true});
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
    return path;
  };
  const app = startup(home, {vault: memoryVault()});
  cleanup.push(async () => {
    await app.shutdownCommands();
    app.db.close();
  });
  return {home, root, write, app, store: app.settings};
}

describe('trust gating of repository settings (files)', () => {
  const loosening = {
    permissions: {
      allow: ['Bash(npm test:*)'],
      deny: ['Bash(rm:*)'],
      defaultMode: 'acceptEdits',
      additionalDirectories: ['../shared'],
    },
    sandbox: {enabled: false, excludedCommands: ['git'], network: {allowedDomains: ['evil.test']}},
  };

  test('a repository allow rule is ignored until approved; deny and ask always apply; a changed file asks again', () => {
    const p = project();
    const projectPath = p.write('project', loosening);
    p.write('user', {permissions: {ask: ['Bash(git push:*)']}, sandbox: {enabled: true}});
    const settings = new FilePermissionSettings({workspace: p.root, stateDirectory: p.home, store: p.store});
    const before = settings.snapshot();
    expect(before.rules.allow).toEqual([]);
    expect(before.rules.deny).toEqual(['Bash(rm:*)']);
    expect(before.rules.ask).toEqual(['Bash(git push:*)']);
    expect(before.defaultMode).toBeUndefined();
    expect(before.additionalDirectories).toEqual([]);
    expect(before.sandbox).toMatchObject({enabled: true, excludedCommands: [], allowedDomains: []});
    expect(before.pendingTrust).toHaveLength(1);
    expect(before.pendingTrust[0]).toMatchObject({scope: 'project', path: projectPath});
    expect(before.pendingTrust[0]!.grants).toContain('allow rule: Bash(npm test:*)');
    expect(before.files.find(file => file.scope === 'project')).toMatchObject({trusted: false, exists: true});

    // Approve exactly this content: everything it grants now applies.
    settings.trust(projectPath, before.pendingTrust[0]!.hash, true);
    const after = settings.snapshot();
    expect(after.pendingTrust).toEqual([]);
    expect(after.rules.allow).toEqual(['Bash(npm test:*)']);
    expect(after.defaultMode).toBe('acceptEdits');
    expect(after.additionalDirectories).toEqual([resolve(p.root, '../shared')]);
    expect(after.sandbox).toMatchObject({enabled: false, excludedCommands: ['git'], allowedDomains: ['evil.test']});

    // The approval is stored by content hash, not by path: any change loses it.
    expect(p.store.read().trustedProjectSettings?.[projectPath]).toEqual([
      settingsHash(readFileSync(projectPath, 'utf8')),
    ]);
    p.write('project', {
      ...loosening,
      permissions: {...loosening.permissions, allow: ['Bash(npm test:*)', 'Bash(curl:*)']},
    });
    const changed = settings.snapshot();
    expect(changed.rules.allow).toEqual([]);
    expect(changed.rules.deny).toEqual(['Bash(rm:*)']);
    expect(changed.pendingTrust).toHaveLength(1);
    expect(changed.pendingTrust[0]!.grants).toContain('allow rule: Bash(curl:*)');
    // Reverting to the approved content is trusted again (same hash).
    p.write('project', loosening);
    expect(settings.snapshot().rules.allow).toEqual(['Bash(npm test:*)']);
  });

  test('the approval is bound to the content it was given for; a session approval is not persisted', () => {
    const p = project();
    const localPath = p.write('local', loosening);
    const settings = new FilePermissionSettings({workspace: p.root, stateDirectory: p.home, store: p.store});
    const pending = settings.snapshot().pendingTrust[0]!;
    expect(() => settings.trust(localPath, settingsHash('something else'), true)).toThrow();
    expect(() => settings.trust('/not/a/settings/file', pending.hash, true)).toThrow();
    settings.trust(localPath, pending.hash, false);
    expect(settings.snapshot().rules.allow).toEqual(['Bash(npm test:*)']);
    expect(p.store.read().trustedProjectSettings).toBeUndefined();
    // A new process (a new settings object) has no session memory.
    const fresh = new FilePermissionSettings({workspace: p.root, stateDirectory: p.home, store: p.store});
    expect(fresh.snapshot().rules.allow).toEqual([]);
    expect(fresh.snapshot().pendingTrust).toHaveLength(1);
  });

  test('files that only tighten, missing files and invalid files need no approval and never loosen', () => {
    const p = project();
    p.write('project', {
      permissions: {deny: ['Bash(rm:*)'], defaultMode: 'plan'},
      sandbox: {allowUnsandboxedCommands: false},
    });
    p.write('local', '{broken');
    const settings = new FilePermissionSettings({workspace: p.root, stateDirectory: p.home, store: p.store});
    const snapshot = settings.snapshot();
    expect(snapshot.pendingTrust).toEqual([]);
    expect(snapshot.defaultMode).toBe('plan');
    expect(snapshot.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(snapshot.diagnostics.join('\n')).toContain('local settings: not valid JSON');
    expect(snapshot.rules.deny).toEqual(['Bash(rm:*)']);
  });

  test('a symlinked or oversized settings file is ignored', () => {
    const p = project();
    const target = join(p.root, 'elsewhere.json');
    writeFileSync(target, JSON.stringify({permissions: {allow: ['Bash']}}));
    mkdirSync(join(p.root, '.cosmew'), {recursive: true});
    require('node:fs').symlinkSync(target, join(p.root, '.cosmew', 'settings.json'));
    p.write('local', JSON.stringify({permissions: {deny: ['Bash(x)']}, pad: 'x'.repeat(70_000)}));
    const snapshot = new FilePermissionSettings({workspace: p.root, stateDirectory: p.home, store: p.store}).snapshot();
    expect(snapshot.rules).toEqual({allow: [], ask: [], deny: []});
    expect(snapshot.diagnostics.join('\n')).toContain('regular file');
    expect(snapshot.diagnostics.join('\n')).toContain('larger than 64 KiB');
  });

  test('user settings always apply; writes keep unknown keys and are trusted only when nothing unapproved was there', () => {
    const p = project();
    p.write('user', {theme: 'dark', permissions: {allow: ['Bash(ls:*)']}});
    const settings = new FilePermissionSettings({workspace: p.root, stateDirectory: p.home, store: p.store});
    expect(settings.snapshot().rules.allow).toEqual(['Bash(ls:*)']);
    settings.addRule('user', 'deny', 'Bash(rm:*)');
    settings.addAllowedDomain('user', 'github.com');
    const saved = JSON.parse(readFileSync(join(p.home, 'settings.json'), 'utf8'));
    expect(saved.theme).toBe('dark');
    expect(saved.permissions).toEqual({allow: ['Bash(ls:*)'], ask: [], deny: ['Bash(rm:*)']});
    expect(saved.sandbox.network.allowedDomains).toEqual(['github.com']);
    expect(statMode(join(p.home, 'settings.json'))).toBe(0o600);

    // A user-authored local rule is trusted at once ...
    settings.addRule('local', 'allow', 'Bash(make:*)');
    expect(settings.snapshot().rules.allow).toContain('Bash(make:*)');
    expect(settings.snapshot().pendingTrust).toEqual([]);
    // ... but writing into a planted, unapproved file does not launder its other content.
    p.write('project', {permissions: {allow: ['Bash(curl:*)']}});
    settings.addRule('project', 'deny', 'Bash(rm -rf:*)');
    const after = settings.snapshot();
    expect(after.rules.allow).not.toContain('Bash(curl:*)');
    expect(after.rules.deny).toContain('Bash(rm -rf:*)');
    expect(after.pendingTrust).toHaveLength(1);
    expect(after.pendingTrust[0]!.grants).toEqual(['allow rule: Bash(curl:*)']);
    // A corrupt file is never overwritten.
    p.write('local', '{broken');
    expect(() => settings.addRule('local', 'allow', 'Bash(ls)')).toThrow();
    expect(readFileSync(join(p.root, '.cosmew', 'settings.local.json'), 'utf8')).toBe('{broken');
  });
});

function statMode(path: string): number {
  return require('node:fs').statSync(path).mode & 0o777;
}

describe('migration of rules saved by the previous model', () => {
  test('per-workspace rules move to the local settings file, trusted, and the old store entry is removed', () => {
    const p = project();
    p.store.update(settings => {
      settings.projectPermissionRules = {
        [p.root]: {
          allow: [
            'Bash(npm test:*)',
            'Edit(src/**)',
            'Network(curl:*)',
            'Unsandboxed(npm run build)',
            'WebFetch(domain:a.com)',
          ],
          ask: ['Bash(git push:*)', 'Network(wget:*)'],
          deny: ['Read(.env)', 'Unsandboxed(rm -rf x)'],
        },
        '/some/other/project': {allow: ['Bash(ls)'], ask: [], deny: []},
      };
    });
    const settings = new FilePermissionSettings({workspace: p.root, stateDirectory: p.home, store: p.store});
    const snapshot = settings.snapshot();
    expect(snapshot.rules.allow).toEqual(['Bash(npm test:*)', 'Edit(src/**)', 'WebFetch(domain:a.com)']);
    expect(snapshot.rules.ask).toEqual(['Bash(git push:*)', 'Bash(wget:*)']);
    expect(snapshot.rules.deny).toEqual(['Read(.env)', 'Bash(rm -rf x)']);
    expect(snapshot.pendingTrust).toEqual([]);
    const file = JSON.parse(readFileSync(join(p.root, '.cosmew', 'settings.local.json'), 'utf8'));
    expect(file.permissions.allow).toEqual(['Bash(npm test:*)', 'Edit(src/**)', 'WebFetch(domain:a.com)']);
    expect(snapshot.diagnostics.join('\n')).toContain('moved 9 saved permission rule(s)');
    expect(snapshot.diagnostics.join('\n')).toContain('dropped legacy allow rule Network(curl:*)');
    // Only this workspace's entry moved; the old store no longer holds it.
    expect(p.store.read().projectPermissionRules?.[p.root]).toBeUndefined();
    expect(p.store.read().projectPermissionRules?.['/some/other/project']?.allow).toEqual(['Bash(ls)']);
    // A second start does not duplicate anything.
    const again = new FilePermissionSettings({workspace: p.root, stateDirectory: p.home, store: p.store}).snapshot();
    expect(again.rules.allow).toEqual(snapshot.rules.allow);
  });

  test('when the file cannot be written the old rules keep applying (nothing is lost)', () => {
    const p = project();
    p.store.update(settings => {
      settings.projectPermissionRules = {[p.root]: {allow: ['Bash(ls:*)'], ask: [], deny: ['Bash(rm:*)']}};
    });
    // `.cosmew` is a regular file: the directory cannot be created.
    writeFileSync(join(p.root, '.cosmew'), 'not a directory');
    const settings = new FilePermissionSettings({workspace: p.root, stateDirectory: p.home, store: p.store});
    const snapshot = settings.snapshot();
    expect(snapshot.rules.allow).toEqual(['Bash(ls:*)']);
    expect(snapshot.rules.deny).toEqual(['Bash(rm:*)']);
    expect(p.store.read().projectPermissionRules?.[p.root]).toBeDefined();
    expect(snapshot.diagnostics.join('\n')).toContain('stay in effect');
  });
});

describe('the client: trust prompts and the network gate', () => {
  function clientFor(p: ReturnType<typeof project>, mode?: 'plan' | 'bypassPermissions') {
    const app = startup(p.home, {vault: memoryVault(), permissions: mode ? {mode} : {}});
    cleanup.push(async () => {
      await app.shutdownCommands();
      app.db.close();
    });
    return app.createFutrynClient(p.root);
  }

  test('enabling tools offers each unapproved repository file once; `always` persists by hash, `session` does not', async () => {
    const p = project();
    const path = p.write('project', {permissions: {allow: ['Bash(npm test:*)']}});
    const client = clientFor(p);
    expect(client.listPendingPermissions()).toEqual([]);
    client.setToolsEnabled(true);
    const [prompt] = client.listPendingPermissions();
    expect(prompt).toMatchObject({capability: 'settings.trust', target: path, decisions: ['session', 'always']});
    expect(prompt!.reason).toContain('allow rule: Bash(npm test:*)');
    expect(client.permissionRules().allow).toEqual([]);
    // Offering again does not duplicate the prompt.
    client.setToolsEnabled(true);
    expect(client.listPendingPermissions()).toHaveLength(1);
    client.resolvePermission(prompt!.approvalId, prompt!.scopeHash, 'always');
    expect(client.permissionRules().allow).toEqual(['Bash(npm test:*)']);
    expect(p.store.read().trustedProjectSettings?.[path]).toHaveLength(1);
    // A change re-asks.
    p.write('project', {permissions: {allow: ['Bash(npm test:*)', 'Bash(make:*)']}});
    client.reviewSettingsTrust();
    expect(client.permissionRules().allow).toEqual([]);
    const [second] = client.listPendingPermissions();
    expect(second!.reason).toContain('Bash(make:*)');
    client.resolvePermission(second!.approvalId, second!.scopeHash, 'session');
    expect(client.permissionRules().allow).toEqual(['Bash(npm test:*)', 'Bash(make:*)']);
    expect(p.store.read().trustedProjectSettings?.[path]).toHaveLength(1);
  });

  test('denying or dismissing the prompt keeps the file ignored; headless runs never prompt and report instead', async () => {
    const p = project();
    p.write('local', {permissions: {allow: ['Bash(npm test:*)'], deny: ['Bash(rm:*)']}});
    const client = clientFor(p);
    client.setToolsEnabled(true);
    const [prompt] = client.listPendingPermissions();
    client.dismissPermissionDialog(prompt!.approvalId);
    expect(client.permissionRules()).toEqual({allow: [], ask: [], deny: ['Bash(rm:*)']});
    expect(client.listPendingPermissions()).toEqual([]);
    expect(client.permissionSettings().pendingTrust).toHaveLength(1);
    // The /permissions screen can still approve it deliberately.
    client.approvePendingSettings(client.permissionSettings().pendingTrust[0]!.path, false);
    expect(client.permissionRules().allow).toEqual(['Bash(npm test:*)']);

    const q = project();
    q.write('project', {permissions: {allow: ['Bash(npm test:*)']}});
    const headless = clientFor(q);
    headless.setSettingsTrustPrompts(false);
    headless.setToolsEnabled(true);
    expect(headless.listPendingPermissions()).toEqual([]);
    expect(headless.permissionRules().allow).toEqual([]);
    expect(headless.permissionSettings().pendingTrust).toHaveLength(1);
  });

  test('allowedDomains (exact and wildcard) allow without asking', async () => {
    const p = project();
    p.write('user', {sandbox: {network: {allowedDomains: ['github.com', '*.npmjs.org']}}});
    p.write('user', {
      sandbox: {network: {allowedDomains: ['github.com', '*.npmjs.org']}},
      permissions: {allow: ['WebFetch(domain:docs.example.com)']},
    });
    const client = clientFor(p);
    client.setToolsEnabled(true);
    expect(await client.authorizeNetwork('docs.example.com', 443)).toBe(true);
    expect(await client.authorizeNetwork('github.com', 443)).toBe(true);
    expect(await client.authorizeNetwork('registry.npmjs.org', 443)).toBe(true);
    expect(client.listPendingPermissions()).toEqual([]);
  });

  test('the network gate asks about a new domain: once is cached briefly, session sticks, always saves to the local settings', async () => {
    const p = project();
    p.write('user', {permissions: {deny: ['WebFetch(domain:evil.test)']}});
    const client = clientFor(p);
    client.setToolsEnabled(true);
    const answer = async (host: string, decision: 'once' | 'session' | 'always' | 'deny') => {
      const pending = client.authorizeNetwork(host, 443);
      await Bun.sleep(5);
      const [prompt] = client.listPendingPermissions();
      expect(prompt).toMatchObject({
        capability: 'network.connect',
        decisions: ['once', 'session', 'always'],
        alwaysRule: `domain:${host}`,
      });
      client.resolvePermission(prompt!.approvalId, prompt!.scopeHash, decision);
      return pending;
    };
    // deny rules refuse without asking
    expect(await client.authorizeNetwork('evil.test', 443)).toBe(false);
    expect(await client.authorizeNetwork('sub.evil.test', 443)).toBe(false);
    expect(client.listPendingPermissions()).toEqual([]);
    // once: allowed, remembered only briefly so one command's connections do not re-prompt
    expect(await answer('once.test', 'once')).toBe(true);
    expect(await client.authorizeNetwork('once.test', 443)).toBe(true);
    expect(client.listPendingPermissions()).toEqual([]);
    // a refusal is remembered too (no prompt storm), and does not leak to other hosts
    expect(await answer('no.test', 'deny')).toBe(false);
    expect(await client.authorizeNetwork('no.test', 443)).toBe(false);
    // session: allowed for the session without a new prompt, not written anywhere
    expect(await answer('session.test', 'session')).toBe(true);
    expect(await client.authorizeNetwork('session.test', 443)).toBe(true);
    expect(existsSync(join(p.root, '.cosmew', 'settings.local.json'))).toBe(false);
    // always: saved to sandbox.network.allowedDomains of the local settings
    expect(await answer('always.test', 'always')).toBe(true);
    const saved = JSON.parse(readFileSync(join(p.root, '.cosmew', 'settings.local.json'), 'utf8'));
    expect(saved.sandbox.network.allowedDomains).toEqual(['always.test']);
    expect(client.permissionSettings().sandbox.allowedDomains).toContain('always.test');
    expect(await client.authorizeNetwork('always.test', 443)).toBe(true);
    // concurrent connections to the same new host share one prompt
    const first = client.authorizeNetwork('shared.test', 443);
    const second = client.authorizeNetwork('shared.test', 443);
    await Bun.sleep(5);
    expect(client.listPendingPermissions()).toHaveLength(1);
    const [prompt] = client.listPendingPermissions();
    client.resolvePermission(prompt!.approvalId, prompt!.scopeHash, 'once');
    expect([await first, await second]).toEqual([true, true]);
  });

  test('plan mode refuses the network; bypassPermissions allows new domains without asking but not denied ones', async () => {
    const p = project();
    p.write('user', {permissions: {deny: ['WebFetch(domain:evil.test)']}});
    const bypass = clientFor(p, 'bypassPermissions');
    bypass.setToolsEnabled(true);
    expect(await bypass.authorizeNetwork('new.test', 443)).toBe(true);
    expect(await bypass.authorizeNetwork('evil.test', 443)).toBe(false);
    expect(bypass.listPendingPermissions()).toEqual([]);
    const plan = clientFor(project(), 'plan');
    plan.setToolsEnabled(true);
    expect(await plan.authorizeNetwork('github.com', 443)).toBe(false);
  });

  test('a repository file cannot allow a domain until it is approved', async () => {
    const p = project();
    const path = p.write('project', {sandbox: {network: {allowedDomains: ['exfil.test']}}});
    const client = clientFor(p);
    client.setSettingsTrustPrompts(false);
    client.setToolsEnabled(true);
    const pending = client.authorizeNetwork('exfil.test', 443);
    await Bun.sleep(5);
    // Not allowed by the file: it falls to the ask, which the test declines.
    const [prompt] = client.listPendingPermissions();
    expect(prompt).toMatchObject({capability: 'network.connect'});
    client.dismissPermissionDialog(prompt!.approvalId);
    expect(await pending).toBe(false);
    client.approvePendingSettings(path, false);
    expect(await client.authorizeNetwork('exfil.test', 443)).toBe(true);
  });

  test('session-only trust is never promoted to persistent trust when mutating local settings', () => {
    const p = project();
    const localPath = p.write('local', {
      permissions: {allow: ['Bash(curl:*)'], defaultMode: 'acceptEdits'},
    });
    const settings = new FilePermissionSettings({workspace: p.root, stateDirectory: p.home, store: p.store});
    const pending = settings.snapshot().pendingTrust;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.path).toBe(localPath);

    // Trust only for the current session (persist = false).
    settings.trust(localPath, pending[0]!.hash, false);
    expect(settings.snapshot().pendingTrust).toEqual([]);
    expect(p.store.read().trustedProjectSettings?.[localPath]).toBeUndefined();

    // Mutating local settings keeps session trust active now, but never persists trust across restarts.
    settings.addRule('local', 'deny', 'Bash(rm:*)');
    expect(settings.snapshot().pendingTrust).toEqual([]);
    expect(p.store.read().trustedProjectSettings?.[localPath]).toBeUndefined();

    // A fresh settings instance (simulating restart) must ask for trust again.
    const restarted = new FilePermissionSettings({workspace: p.root, stateDirectory: p.home, store: p.store});
    const afterRestart = restarted.snapshot();
    expect(afterRestart.pendingTrust).toHaveLength(1);
    expect(afterRestart.rules.allow).toEqual([]);
    expect(afterRestart.rules.deny).toEqual(['Bash(rm:*)']);
  });

  test('matchesExcludedCommand handles repeated wildcards linearly and grantLabel formats MCP/network/external targets cleanly', () => {
    const hostilePattern = 'a' + '*a'.repeat(40) + '*b';
    const hostileInput = 'a'.repeat(120) + 'c';
    const started = performance.now();
    expect(matchesExcludedCommand(hostilePattern, hostileInput)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
    expect(matchesExcludedCommand('npm * run *', 'npm --prefix app run build')).toBe(true);

    const p = project();
    const ws = new WorkspaceRoot(p.root);
    expect(grantLabel({capability: 'mcp.call', target: 'mcp__github__search:deadbeef1234'}, ws)).toBe(
      'MCP mcp__github__search',
    );
    expect(grantLabel({capability: 'network.connect', target: 'https://example.com'}, ws)).toBe('https://example.com');
    expect(grantLabel({capability: 'network.search', target: 'https://api.exa.ai'}, ws)).toBe('https://api.exa.ai');
    expect(grantLabel({capability: 'fs.read', target: join(p.root, 'src/app.ts')}, ws)).toBe('src/app.ts');
    expect(grantLabel({capability: 'fs.read', target: '/etc/hosts'}, ws)).toBe('/etc/hosts');
  });
});
