import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {FileMemories} from '@cosmew/persistence';
import {MemoryDirectory} from '../../packages/persistence/src/memory-directory';
import {createHash} from 'node:crypto';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});
});
const entry = {name: 'preference', description: 'Original', type: 'user' as const, content: 'Original body'};
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cosmew-memory-recovery-')));
  roots.push(root);
  const state = join(root, 'state'),
    project = join(root, 'project');
  mkdirSync(state);
  mkdirSync(project);
  return {root, state, project, store: new FileMemories(state, project, t => t)};
}
async function pausedChild(state: string, project: string, boundary: string, action = 'write') {
  const script = `
import {writeSync} from 'node:fs';
import {FileMemories} from ${JSON.stringify(resolve('packages/persistence/src/memories.ts'))};
import {MemoryDirectory} from ${JSON.stringify(resolve('packages/persistence/src/memory-directory.ts'))};
const pause = () => { writeSync(1, 'ready\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
const atomic = MemoryDirectory.prototype.atomic;
MemoryDirectory.prototype.atomic = function(name, text) { atomic.call(this, name, text); if (name === ${JSON.stringify(boundary)}) pause(); };
const remove = MemoryDirectory.prototype.delete;
MemoryDirectory.prototype.delete = function(name) { remove.call(this, name); if (${JSON.stringify(boundary)} === 'deleted' && name === 'preference.md') pause(); };
const lock = MemoryDirectory.prototype.lock;
MemoryDirectory.prototype.lock = function() { lock.call(this); if (${JSON.stringify(boundary)} === 'lock') pause(); };
const store = new FileMemories(${JSON.stringify(state)}, ${JSON.stringify(project)}, t => t);
if (${JSON.stringify(action)} === 'read') store.read('preference');
else if (${JSON.stringify(action)} === 'context') store.context();
else if (${JSON.stringify(action)} === 'delete') store.delete('preference');
else store.write({name:'preference', description:'Changed', type:'user', content:'Changed body'});
`;
  const child = Bun.spawn([process.execPath, '-e', script], {stdout: 'pipe', stderr: 'pipe'});
  const reader = child.stdout.getReader();
  const ready = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('child did not reach boundary')), 5000)),
  ]).catch(async error => {
    child.kill('SIGKILL');
    await child.exited;
    throw error;
  });
  expect(new TextDecoder().decode(ready.value)).toContain('ready');
  return child;
}
test('SIGKILL releases the memory lock without stealing it from a live holder after restart', async () => {
  const {state, project, store} = fixture();
  store.write(entry);
  const child = await pausedChild(state, project, 'lock');
  try {
    expect(() => store.read(entry.name)).toThrow();
    expect(() => store.write({...entry, content: 'contending writer'})).toThrow();
  } finally {
    child.kill('SIGKILL');
    await child.exited;
  }
  expect(store.read(entry.name)).toContain('Original body');
});
for (const boundary of ['.pending.json', 'preference.md', 'MEMORY.md', '.usage.json']) {
  test(`SIGKILL after ${boundary} reconciles actual files, index and usage`, async () => {
    const {state, project, store} = fixture();
    store.write(entry);
    store.read(entry.name);
    const child = await pausedChild(state, project, boundary);
    child.kill('SIGKILL');
    await child.exited;
    const reopened = new FileMemories(state, project, t => t);
    const changed = boundary !== '.pending.json';
    expect(reopened.context()).toContain(changed ? 'Changed' : 'Original');
    expect(reopened.list()).toMatchObject([{description: changed ? 'Changed' : 'Original', usage_count: 1}]);
    expect(reopened.read(entry.name)).toContain(changed ? 'Changed body' : 'Original body');
  });
}
test('recovery keeps user edits made after the interrupted content commit', async () => {
  const {state, project, store} = fixture();
  store.write(entry);
  const child = await pausedChild(state, project, 'preference.md');
  child.kill('SIGKILL');
  await child.exited;
  const file = join(store.directory, 'preference.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace('Changed', 'User edit').replace('Changed body', 'User body'));
  const reopened = new FileMemories(state, project, t => t);
  expect(reopened.context()).toContain('User edit');
  expect(reopened.read(entry.name)).toContain('User body');
});
test('lock symlinks fail closed without touching their target', () => {
  const {root, store} = fixture();
  store.prepareDirectory();
  rmSync(join(store.directory, '.lock'));
  const outside = join(root, 'outside');
  writeFileSync(outside, 'untouched');
  symlinkSync(outside, join(store.directory, '.lock'));
  expect(() => store.write(entry)).toThrow();
  expect(readFileSync(outside, 'utf8')).toBe('untouched');
});

test('SIGKILL after delete removes obsolete index and usage records on restart', async () => {
  const {state, project, store} = fixture();
  store.write(entry);
  store.read(entry.name);
  const child = await pausedChild(state, project, 'deleted', 'delete');
  child.kill('SIGKILL');
  await child.exited;
  expect(store.context()).toBe('');
  expect(store.list()).toEqual([]);
  store.write(entry);
  expect(store.list()[0]?.usage_count).toBe(0);
});
test('legacy ownerless directory locks have actionable diagnostics and are never stolen', () => {
  const {store} = fixture();
  store.prepareDirectory();
  rmSync(join(store.directory, '.lock'));
  mkdirSync(join(store.directory, '.lock'));
  expect(() => store.write(entry)).toThrow('Stop all Cosmew processes');
});
test('an unlocked persistent lock ignores stale or reused PID text', () => {
  const {store} = fixture();
  store.write(entry);
  writeFileSync(join(store.directory, '.lock'), JSON.stringify({pid: process.pid, start: 'old-process'}));
  expect(store.read(entry.name)).toContain('Original body');
});
test('pending journal symlinks and arbitrary target names fail closed', () => {
  const {root, store} = fixture();
  store.write(entry);
  const outside = join(root, 'outside');
  writeFileSync(outside, 'untouched');
  const pending = join(store.directory, '.pending.json');
  symlinkSync(outside, pending);
  expect(() => store.context()).toThrow();
  expect(readFileSync(outside, 'utf8')).toBe('untouched');
  rmSync(pending);
  writeFileSync(
    pending,
    JSON.stringify({version: 1, name: '../outside', before: null, after: null, usage: {version: 1, entries: {}}}),
  );
  expect(() => store.context()).toThrow();
  expect(readFileSync(outside, 'utf8')).toBe('untouched');
});

test('a second crash during reconciliation leaves an idempotent recoverable journal', async () => {
  const {state, project, store} = fixture();
  store.write(entry);
  store.read(entry.name);
  const writer = await pausedChild(state, project, 'preference.md');
  writer.kill('SIGKILL');
  await writer.exited;
  const index = join(store.directory, 'MEMORY.md');
  writeFileSync(index, readFileSync(index, 'utf8') + '\nUser-maintained note.\n');
  const recovery = await pausedChild(state, project, 'MEMORY.md', 'context');
  recovery.kill('SIGKILL');
  await recovery.exited;
  expect(store.context()).toContain('Changed');
  expect(readFileSync(index, 'utf8')).toContain('\n\nUser-maintained note.\n');
  expect(store.list()[0]?.usage_count).toBe(1);
  expect(store.context().match(/Changed/g)?.length).toBe(1);
});

test('SIGKILL after a read counter commit does not lose or double count usage on reopening', async () => {
  const {state, project, store} = fixture();
  store.write(entry);
  store.read(entry.name);
  const child = await pausedChild(state, project, '.usage.json', 'read');
  child.kill('SIGKILL');
  await child.exited;
  expect(store.list()[0]?.usage_count).toBe(2);
  expect(store.list()[0]?.usage_count).toBe(2);
  expect(store.read(entry.name)).toContain('Original body');
  expect(store.list()[0]?.usage_count).toBe(3);
});

for (const journal of [
  '{broken',
  JSON.stringify({
    version: 1,
    name: 'preference',
    before: null,
    after: null,
    usage: {version: 1, entries: {preference: {usage_count: 'invalid'}}},
  }),
]) {
  test('corrupt pending JSON or schema reports normalized STORAGE', () => {
    const {store} = fixture();
    store.write(entry);
    writeFileSync(join(store.directory, '.pending.json'), journal);
    try {
      store.context();
      throw new Error('unexpected success');
    } catch (error) {
      expect(error).toMatchObject({code: 'STORAGE'});
    }
  });
}
test('a killed subprocess leaving more than 264 temporary files does not wedge reopening', async () => {
  const {state, project, store} = fixture();
  store.write(entry);
  const script = `
import {writeFileSync,writeSync} from 'node:fs';
import {MemoryDirectory} from ${JSON.stringify(resolve('packages/persistence/src/memory-directory.ts'))};
import {createHash} from 'node:crypto';
const directory = ${JSON.stringify(store.directory)};
const d = MemoryDirectory.open(${JSON.stringify(state)}, createHash('sha256').update(${JSON.stringify(project)}).digest('hex'), false);
d.lock();
for (let i = 0; i < 300; i++) writeFileSync(directory + '/.' + crypto.randomUUID() + '.tmp', 'abandoned');
writeSync(1, 'ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
`;
  const child = Bun.spawn([process.execPath, '-e', script], {stdout: 'pipe', stderr: 'pipe'});
  try {
    const ready = await child.stdout.getReader().read();
    expect(new TextDecoder().decode(ready.value)).toBe('ready');
  } finally {
    child.kill('SIGKILL');
    await child.exited;
  }
  expect(store.read(entry.name)).toContain('Original body');
  expect(store.list()).toHaveLength(1);
});
for (const action of ['read', 'write'] as const)
  test(`an independent process releasing a short lock lets a waiting ${action} complete`, async () => {
    const {state, project, store} = fixture();
    store.write(entry);
    const script = `
import {writeSync} from 'node:fs';
import {MemoryDirectory} from ${JSON.stringify(resolve('packages/persistence/src/memory-directory.ts'))};
import {createHash} from 'node:crypto';
const d = MemoryDirectory.open(${JSON.stringify(state)}, createHash('sha256').update(${JSON.stringify(project)}).digest('hex'), false);
d.lock(); writeSync(1,'ready');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,80); d.close();
`;
    const child = Bun.spawn([process.execPath, '-e', script], {stdout: 'pipe', stderr: 'pipe'});
    try {
      const ready = await child.stdout.getReader().read();
      expect(new TextDecoder().decode(ready.value)).toBe('ready');
      if (action === 'write') {
        store.write({...entry, description: 'Concurrent write'});
        expect(store.context()).toContain('Concurrent write');
      } else expect(store.read(entry.name)).toContain('Original body');
    } finally {
      child.kill();
      await child.exited;
    }
  });

test('same-process lock contention fails immediately without blocking the owner', () => {
  const {state, project, store} = fixture();
  store.write(entry);
  const owner = MemoryDirectory.open(state, createHash('sha256').update(project).digest('hex'), false)!;
  owner.lock();
  try {
    const started = performance.now();
    expect(() => store.read(entry.name)).toThrow();
    expect(performance.now() - started).toBeLessThan(150);
  } finally {
    owner.close();
  }
  expect(store.read(entry.name)).toContain('Original body');
});
