import {afterEach, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, realpathSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {SkillCatalog, parseSkillDocument, renderSkillCatalog, skillInvocations, WorkspaceRoot} from '@futryn/workspace';
import {ToolDispatcher, type ToolAuditRecord} from '@futryn/tools';
import {SessionGrants} from '@futryn/security';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});
});
const document = (name = 'demo', extra = '', body = 'Do $ARGUMENTS carefully.') =>
  `---\nname: ${name}\ndescription: A useful skill\n${extra}---\n${body}`;
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-skills-')));
  roots.push(root);
  const project = join(root, 'project'),
    home = join(root, 'home');
  mkdirSync(project);
  mkdirSync(home);
  mkdirSync(join(project, '.git'));
  const put = (base: string, path: string, content = document()) => {
    const target = join(base, path);
    mkdirSync(dirname(target), {recursive: true});
    writeFileSync(target, content);
    return target;
  };
  return {root, project, home, put, catalog: () => new SkillCatalog({workspace: new WorkspaceRoot(project), home})};
}

test('frontmatter validates supported scalars, folded descriptions and ignores authority keys', () => {
  const parsed = parseSkillDocument(
    document('demo', 'disable-model-invocation: true\nargument-hint: "[file]"\nallowed-tools: [Bash]\n'),
  );
  expect(parsed).toMatchObject({
    name: 'demo',
    disableModelInvocation: true,
    argumentHint: '[file]',
    body: 'Do $ARGUMENTS carefully.',
  });
  expect(parsed).not.toHaveProperty('allowed-tools');
  expect(parseSkillDocument('---\nname: demo\ndescription: >-\n  first line\n  next line\n---\nbody').description).toBe(
    'first line next line',
  );
});

test('missing, malformed, wrong typed, unsafe, overlong and oversize skills fail locally', () => {
  for (const text of [
    'body',
    '---\ndescription: Missing name\n---\nbody',
    '---\nname: demo\n---\nx',
    document('../escape'),
    document('x'.repeat(65)),
    document().replace('A useful skill', 'x'.repeat(1025)),
    document().replace('A useful skill', 'false'),
    document('demo', 'disable-model-invocation: yes\n'),
    document('demo', 'name: again\n'),
    document('demo', '', 'x'.repeat(65536)),
  ])
    expect(() => parseSkillDocument(text)).toThrow();
  const f = fixture();
  f.put(f.project, '.futryn/skills/bad/SKILL.md', 'bad');
  f.put(f.home, '.agents/skills/good/SKILL.md');
  const report = f.catalog().report();
  expect(report.skills.some(s => s.name === 'demo')).toBe(true);
  expect(report.errors.length).toBe(1);
});

test('project precedence, nearest repo scopes, compatibility roots, duplicates and system creator', () => {
  const f = fixture();
  f.put(f.home, '.futryn/skills/demo/SKILL.md');
  f.put(f.project, '.agents/skills/demo/SKILL.md');
  const child = join(f.project, 'sub');
  mkdirSync(child);
  f.put(child, '.claude/skills/demo/SKILL.md');
  const report = new SkillCatalog({workspace: new WorkspaceRoot(child), home: f.home}).report();
  expect(report.skills.find(s => s.name === 'demo')?.path).toContain('/sub/.claude/');
  expect(report.warnings.filter(w => w.code === 'DUPLICATE_NAME')).toHaveLength(2);
  expect(report.skills.find(s => s.name === 'skill-creator')?.source).toBe('system');
});

test('catalog budget shortens descriptions before dropping entries, hides disabled skills', () => {
  const f = fixture();
  f.put(f.project, '.futryn/skills/hidden/SKILL.md', document('hidden', 'disable-model-invocation: true\n'));
  const report = f.catalog().report();
  expect(renderSkillCatalog(report.skills).instructions).not.toContain('hidden');
  const many = Array.from({length: 70}, (_, n) => ({
    ...report.skills[0]!,
    name: `skill-${n}`,
    disableModelInvocation: false,
    description: 'd'.repeat(1024),
    shortPath: `.futryn/skills/${n}/SKILL.md`,
  }));
  const short = renderSkillCatalog(many);
  expect(short.instructions.length).toBeLessThanOrEqual(8000);
  expect(short.instructions).toContain('skill-69');
  expect(short.warnings.length).toBeGreaterThan(0);
  const dropped = renderSkillCatalog([...many, ...many, ...many]);
  expect(dropped.instructions.length).toBeLessThanOrEqual(8000);
  expect(dropped.warnings.some(w => w.code === 'CATALOG_OMITTED')).toBe(true);
});

test('model exposure requires an invocable project or user skill; explicit loads remain mediated', async () => {
  for (const source of ['none', 'disabled', 'project', 'user'] as const) {
    const f = fixture();
    if (source !== 'none')
      f.put(
        source === 'user' ? f.home : f.project,
        '.futryn/skills/demo/SKILL.md',
        document('demo', source === 'disabled' ? 'disable-model-invocation: true\n' : ''),
      );
    const catalog = f.catalog();
    const dispatcher = new ToolDispatcher({
      workspace: new WorkspaceRoot(f.project),
      skills: catalog,
      grants: new SessionGrants(),
      approve: async () => 'deny',
      redact: s => s,
    });
    const exposed = source === 'project' || source === 'user';
    expect(dispatcher.descriptors().some(d => d.name === 'skill')).toBe(exposed);
    expect(!!catalog.instructions()).toBe(exposed);
    expect(catalog.report().skills.some(s => s.source === 'system')).toBe(true);
    const name = source === 'disabled' ? 'demo' : 'skill-creator';
    expect((await dispatcher.invoke({id: source, name: 'skill', input: {name}})).status).toBe('ok');
  }
  expect(renderSkillCatalog([])).toEqual({instructions: '', warnings: []});
});

test('slash arguments and dollar mentions select once, including hidden skills', () => {
  const f = fixture();
  f.put(f.project, '.futryn/skills/demo/SKILL.md', document('demo', 'disable-model-invocation: true\n'));
  const skills = f.catalog().report().skills;
  expect(skillInvocations('Ignore \\$demo', skills)).toEqual([]);
  expect(skillInvocations('/demo src/a.ts', skills)).toEqual([{name: 'demo', args: 'src/a.ts'}]);
  expect(skillInvocations('Use $demo and $demo; $demo-other and escaped \\$demo', skills)).toEqual([
    {name: 'demo', args: ''},
  ]);
  expect(skillInvocations('/demo x', skills, ['/demo'])).toEqual([]);
});

test('dollar mentions exclude common environment variables and Markdown code', () => {
  const f = fixture();
  f.put(f.project, '.futryn/skills/demo/SKILL.md', document('demo'));
  const demo = f
    .catalog()
    .report()
    .skills.find(s => s.name === 'demo')!;
  const envNames = ['PATH', 'HOME', 'USER', 'SHELL', 'PWD', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'TERM', 'XDG_CONFIG_HOME'];
  const skills = [demo, ...envNames.flatMap(name => [name, name.toLowerCase()].map(name => ({...demo, name})))];
  for (const name of envNames) {
    expect(skillInvocations(`Use $${name} and [$${name.toLowerCase()}](SKILL.md)`, skills)).toEqual([]);
  }
  for (const prompt of [
    '`$demo`',
    '``code `$demo` code``',
    '```sh\n$demo\n```',
    '~~~sh\n$demo\n~~~',
    '````md\n```\n$demo\n```\n````',
    '```sh\n$demo',
    'prefix `$demo\nmore code`',
    '$demo:other',
  ]) {
    expect(skillInvocations(prompt, skills)).toEqual([]);
  }
  expect(skillInvocations('`$demo` then $demo', skills)).toEqual([{name: 'demo', args: ''}]);
  expect(skillInvocations('```\n$demo\n```\n$demo', skills)).toEqual([{name: 'demo', args: ''}]);
  expect(skillInvocations('/demo `$PATH`', skills)).toEqual([{name: 'demo', args: '`$PATH`'}]);
  expect(skillInvocations('/PATH', skills)).toEqual([{name: 'PATH', args: ''}]);
});

test('skill dispatcher permits only discovered files, audits/redacts and never grants allowed-tools', async () => {
  const f = fixture();
  const file = f.put(
    f.home,
    '.futryn/skills/demo/SKILL.md',
    document('demo', 'allowed-tools: [Bash]\n', 'secret body'),
  );
  const catalog = f.catalog(),
    audit: ToolAuditRecord[] = [],
    grants = new SessionGrants();
  const dispatcher = new ToolDispatcher({
    workspace: new WorkspaceRoot(f.project),
    skills: catalog,
    grants,
    approve: async () => 'deny',
    redact: s => s.replaceAll('secret', '[redacted]'),
    audit: r => audit.push(r),
  });
  const invoke = (name: string) => dispatcher.invoke({id: crypto.randomUUID(), name: 'skill', input: {name}});
  const result = await invoke('demo');
  expect(result.status).toBe('ok');
  expect(result.content).toContain('[redacted] body');
  expect(result.skillDirectory).toBe(dirname(file));
  expect(grants.list()).toHaveLength(0);
  expect(audit.map(r => r.phase)).toEqual(['requested', 'decided', 'completed']);
  expect((await invoke('missing')).status).toBe('error');
  expect((await invoke('../demo')).code).toBe('INVALID_INPUT');
  rmSync(file);
  symlinkSync(f.put(f.root, 'outside.md', document()), file);
  expect((await invoke('demo')).status).not.toBe('ok');
});

test('discovery refuses symlink roots/files and skips vendored and gitignored trees', () => {
  const f = fixture();
  f.put(f.home, '.futryn/skills/demo/SKILL.md');
  mkdirSync(join(f.project, '.futryn'));
  symlinkSync(join(f.home, '.futryn/skills'), join(f.project, '.futryn/skills'));
  f.put(f.project, '.agents/skills/vendor/x/SKILL.md', document('vendored'));
  const report = f.catalog().report();
  expect(report.skills.find(s => s.name === 'demo')?.source).toBe('user');
  expect(report.skills.some(s => s.name === 'vendored')).toBe(false);
});

test('64 KiB is inclusive and the tool returns the complete file without clipping JSON escapes', async () => {
  const f = fixture();
  const prefix = document('demo', '', '');
  const content =
    prefix +
    '\\"'.repeat(Math.floor((65536 - Buffer.byteLength(prefix)) / 2)) +
    'x'.repeat((65536 - Buffer.byteLength(prefix)) % 2);
  expect(Buffer.byteLength(content)).toBe(65536);
  f.put(f.home, '.futryn/skills/demo/SKILL.md', content);
  const d = new ToolDispatcher({
    workspace: new WorkspaceRoot(f.project),
    skills: f.catalog(),
    grants: new SessionGrants(),
    approve: async () => 'deny',
    redact: s => s,
  });
  const result = await d.invoke({id: 'large', name: 'skill', input: {name: 'demo'}});
  expect(result.status).toBe('ok');
  expect(result.content).toBe(content);
  expect(result.truncated).toBeUndefined();
});

test('read deny, cancelled approval and a symlink swap during approval never disclose skill body', async () => {
  const f = fixture();
  const file = f.put(f.home, '.futryn/skills/demo/SKILL.md', document());
  const catalog = f.catalog();
  let prompts = 0;
  let policy: 'allow' | 'ask' | 'deny' = 'deny';
  const controller = new AbortController();
  const d = new ToolDispatcher({
    workspace: new WorkspaceRoot(f.project),
    skills: catalog,
    grants: new SessionGrants(),
    readPolicy: () => policy,
    redact: s => s,
    approve: async () => {
      prompts++;
      rmSync(file);
      symlinkSync(f.put(f.root, 'other.md', document()), file);
      return 'once';
    },
  });
  const invoke = () => d.invoke({id: crypto.randomUUID(), name: 'skill', input: {name: 'demo'}});
  expect((await invoke()).status).toBe('denied');
  expect(prompts).toBe(0);
  policy = 'ask';
  expect((await invoke()).status).toBe('denied');
  expect(prompts).toBe(1);
  controller.abort();
  await expect(d.invoke({id: 'abort', name: 'skill', input: {name: 'demo'}}, controller.signal)).rejects.toBeDefined();
});

test('ignored skill roots and ignored nested scope cannot contribute project skills', () => {
  const f = fixture();
  expect(Bun.spawnSync(['git', 'init', '-q', f.project]).exitCode).toBe(0);
  f.put(f.project, '.gitignore', '.futryn/\nignored/\n');
  f.put(f.project, '.futryn/skills/demo/SKILL.md');
  f.put(f.project, 'ignored/.agents/skills/ignored/SKILL.md', document('ignored'));
  const catalog = new SkillCatalog({workspace: new WorkspaceRoot(join(f.project, 'ignored')), home: f.home});
  expect(catalog.report().skills.map(s => s.name)).toEqual(['skill-creator']);
});

test('default ~/.futryn state keeps all files hidden except the exact discovered user SKILL.md', async () => {
  const f = fixture();
  const file = f.put(f.home, '.futryn/skills/demo/SKILL.md');
  const state = join(f.home, '.futryn');
  f.put(f.home, '.futryn/credentials.db', 'STATE_SECRET');
  const catalog = f.catalog();
  const grants = new SessionGrants();
  const options = {
    workspace: new WorkspaceRoot(f.project),
    skills: catalog,
    stateDirectory: state,
    grants,
    approve: async () => 'deny' as const,
    redact: (s: string) => s,
  };
  const d = new ToolDispatcher(options);
  expect((await d.invoke({id: 'state-skill', name: 'skill', input: {name: 'demo'}})).status).toBe('ok');
  expect(catalog.isStateSkillFile(file, state)).toBe(true);
  expect(catalog.isStateSkillFile(join(state, 'credentials.db'), state)).toBe(false);
  const denied = new ToolDispatcher({...options, readPolicy: () => 'deny' as const});
  expect((await denied.invoke({id: 'deny-state-skill', name: 'skill', input: {name: 'demo'}})).status).toBe('denied');
  for (const path of [file, join(state, 'credentials.db'), join(state, 'skills/demo/run.sh')])
    expect((await d.invoke({id: crypto.randomUUID(), name: 'read', input: {path}})).status).not.toBe('ok');
  const inside = new ToolDispatcher({...options, workspace: new WorkspaceRoot(f.home)});
  expect(
    (await inside.invoke({id: 'state-is-workspace', name: 'read', input: {path: '.futryn/credentials.db'}})).status,
  ).toBe('denied');
  expect(grants.list()).toHaveLength(0);
});

test('a newly required Read approval cannot be bypassed between authorization and skill execution', async () => {
  const f = fixture();
  f.put(f.home, '.futryn/skills/demo/SKILL.md');
  let policy: 'allow' | 'ask' = 'allow',
    prompts = 0;
  const d = new ToolDispatcher({
    workspace: new WorkspaceRoot(f.project),
    skills: f.catalog(),
    grants: new SessionGrants(),
    redact: s => s,
    readPolicy: () => policy,
    approve: async () => {
      prompts++;
      return 'deny';
    },
  });
  const pending = d.invoke({id: 'new-read-policy', name: 'skill', input: {name: 'demo'}});
  policy = 'ask';
  expect((await pending).status).toBe('denied');
  expect(prompts).toBe(0);
});
