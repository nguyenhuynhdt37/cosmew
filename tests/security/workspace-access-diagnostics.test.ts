import {afterEach, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ToolDispatcher, DEFAULT_SANDBOX_CONFIG} from '@cosmew/tools';
import {SessionGrants} from '@cosmew/security';
import {WorkspaceRoot} from '@cosmew/workspace';

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, {recursive: true, force: true});
});

for (const enabled of [false, true])
  test(`file access distinguishes missing paths and working-directory grants with sandbox=${enabled}`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cosmew-access-diagnostics-')));
    cleanup.push(root);
    const project = join(root, 'project'),
      granted = join(root, 'granted'),
      outside = join(root, 'outside');
    for (const path of [project, granted, outside]) mkdirSync(path);
    writeFileSync(join(project, 'package.json'), '{"name":"starter"}');
    writeFileSync(join(granted, 'notes.txt'), 'GRANTED_CONTENT');
    writeFileSync(join(outside, 'private.txt'), 'OUTSIDE_CANARY');
    const dispatcher = new ToolDispatcher({
      workspace: new WorkspaceRoot(project),
      grants: new SessionGrants(),
      redact: text => text,
      approve: async request => {
        expect(request.capability).toBe('fs.read');
        expect(request.reason).toBe('outside-working-directories');
        return 'deny';
      },
      analysisOnly: () => true,
      sandbox: () => ({...DEFAULT_SANDBOX_CONFIG, enabled, readOnly: false, additionalDirectories: [granted]}),
    });
    const invoke = (name: string, input: unknown) => dispatcher.invoke({id: crypto.randomUUID(), name, input});
    const read = await invoke('read', {path: 'package.json'});
    expect(read.status).toBe('ok');
    expect(read.content).toContain('starter');
    expect((await invoke('read', {path: join(granted, 'notes.txt')})).content).toContain('GRANTED_CONTENT');
    const missing = await invoke('grep', {path: 'node_modules/create-next-app', pattern: 'name'});
    expect(missing.code).toBe('NOT_FOUND');
    expect(missing.status).toBe('error');
    expect(missing.content).toContain('not a permission denial');
    const denied = await invoke('read', {path: join(outside, 'private.txt')});
    expect(denied.status).toBe('denied');
    expect(denied.code).toBe('DENIED');
    expect(denied.content).toContain('user denied');
    expect(denied.content).not.toContain('OUTSIDE_CANARY');
  });
