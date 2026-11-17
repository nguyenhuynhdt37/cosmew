import {afterEach, expect, test} from 'bun:test';
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionGrants} from '@futryn/security';
import {ToolDispatcher, type ApprovalRequest} from '@futryn/tools';
import {WorkspaceRoot} from '@futryn/workspace';
import {toModelMessages} from '../../packages/models/src/adapter';

/** ADR 0041: read of directories, tails, media, notebooks and did-you-mean, under the read policy. */

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const REGISTERED_SECRET = 'sk-registered-secret-0001';
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function setup() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'futryn-read-')));
  cleanup.push(() => rmSync(base, {recursive: true, force: true}));
  const root = join(base, 'ws');
  mkdirSync(join(root, 'src', 'deep'), {recursive: true});
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, 'state'));
  writeFileSync(join(root, '.git', 'config'), '[core]\n');
  writeFileSync(join(root, 'src', 'App.ts'), 'export const app = 1;\n');
  writeFileSync(join(root, 'src', 'b.ts'), 'b\n');
  writeFileSync(join(root, '.env'), 'TOKEN=secret-value\n');
  const asked: ApprovalRequest[] = [];
  const dispatcher = new ToolDispatcher({
    workspace: new WorkspaceRoot(root),
    grants: new SessionGrants(),
    stateDirectory: join(root, 'state'),
    approve: async request => {
      asked.push(request);
      return 'deny';
    },
    redact: text => text.replaceAll(REGISTERED_SECRET, '[REDACTED]'),
  });
  const read = (input: unknown) => dispatcher.invoke({id: crypto.randomUUID(), name: 'read', input});
  return {base, root, asked, read};
}

test('a directory lists entries, directories first with "/", paged; .git and Futryn state are omitted', async () => {
  const s = setup();
  const listing = await s.read({path: '.'});
  expect(listing.status).toBe('ok');
  const lines = listing.content.split('\n').slice(1);
  expect(lines).toEqual(['src/', '.env']);
  expect(listing.content).not.toContain('.git');
  expect(listing.content).not.toContain('state');
  const page = await s.read({path: 'src', offset: 2, limit: 1});
  expect(page.content.split('\n')[1]).toBe('App.ts');
  expect(page.content).toContain('continue with offset 3');
  expect((await s.read({path: 'src', offset: -1})).code).toBe('INVALID_INPUT');
  expect((await s.read({path: '.git'})).status).toBe('denied');
  // A listing names a secret file but never reads it.
  expect(listing.content).not.toContain('secret-value');
  expect(s.asked).toHaveLength(0);
});

test('a negative offset reads the last N lines', async () => {
  const s = setup();
  writeFileSync(join(s.root, 'log.txt'), Array.from({length: 50}, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  const tail = await s.read({path: 'log.txt', offset: -3});
  expect(tail.content.split('\n')).toEqual(['48\tline 48', '49\tline 49', '50\tline 50']);
  expect((await s.read({path: 'log.txt', offset: 0})).code).toBe('INVALID_INPUT');
});

test('did-you-mean suggests one readable path and never a secret, Git internals or a path outside', async () => {
  const s = setup();
  expect((await s.read({path: 'src/Appp.ts'})).content).toContain('Did you mean src/App.ts?');
  expect((await s.read({path: 'src/App.js'})).content).toContain('Did you mean src/App.ts?');
  // Absolute path written from the wrong root: its tail exists in the workspace.
  const moved = await s.read({path: '/home/other/checkout/src/App.ts'});
  expect(moved.status).toBe('denied');
  expect(moved.content).toContain('Did you mean src/App.ts');
  // Secret, Git and ambiguous candidates are never suggested.
  for (const path of ['.envv', '.git/confg', 'src/c.ts', '/tmp/nowhere/.env'])
    expect({path, content: (await s.read({path})).content}).not.toMatchObject({
      content: expect.stringContaining('Did you mean'),
    });
  expect(s.asked).toHaveLength(0);
});

test('images and PDFs are detected by bytes and returned as attachments; 20 MiB is the limit', async () => {
  const s = setup();
  writeFileSync(join(s.root, 'logo.bin'), Buffer.from(PNG, 'base64'));
  const image = await s.read({path: 'logo.bin'});
  expect(image.status).toBe('ok');
  expect(image.attachments).toEqual([{mime: 'image/png', data: PNG, name: 'logo.bin'}]);
  expect(image.content).toContain('image/png');
  expect(image.content).not.toContain(PNG);
  writeFileSync(join(s.root, 'doc.pdf'), '%PDF-1.4\n%fixture\n%%EOF\n');
  expect((await s.read({path: 'doc.pdf'})).attachments?.[0]?.mime).toBe('application/pdf');
  // A PNG name with text content is text, not media.
  writeFileSync(join(s.root, 'fake.png'), 'not an image\n');
  expect((await s.read({path: 'fake.png'})).attachments).toBeUndefined();
  const big = openSync(join(s.root, 'big.png'), 'w');
  writeSync(big, Buffer.from(PNG, 'base64').subarray(0, 16));
  ftruncateSync(big, 20 * 1024 * 1024 + 1);
  closeSync(big);
  const tooBig = await s.read({path: 'big.png'});
  expect(tooBig.code).toBe('FILE_TOO_LARGE');
  expect(tooBig.attachments).toBeUndefined();
  // A media secret still asks first; denial returns nothing.
  writeFileSync(join(s.root, 'id_rsa'), Buffer.from(PNG, 'base64'));
  const secret = await s.read({path: 'id_rsa'});
  expect(secret.status).toBe('denied');
  expect(secret.attachments).toBeUndefined();
});

test('notebooks render cells with outputs; image outputs become attachments', async () => {
  const s = setup();
  writeFileSync(
    join(s.root, 'nb.ipynb'),
    JSON.stringify({
      cells: [
        {cell_type: 'markdown', source: ['# Title\n', 'text']},
        {
          cell_type: 'code',
          execution_count: 3,
          source: 'print(1)',
          outputs: [
            {output_type: 'stream', text: ['1\n']},
            {output_type: 'display_data', data: {'image/png': PNG, 'text/plain': '<Figure>'}},
            {output_type: 'error', ename: 'ValueError', evalue: 'bad'},
          ],
        },
      ],
    }),
  );
  const result = await s.read({path: 'nb.ipynb'});
  expect(result.content).toContain('[1] markdown');
  expect(result.content).toContain('[2] code (execution 3)');
  expect(result.content).toContain('print(1)');
  expect(result.content).toContain('  1');
  expect(result.content).toContain('ValueError: bad');
  expect(result.attachments).toEqual([{mime: 'image/png', data: PNG, name: 'nb.ipynb#cell-2-output-1'}]);
});

test('a model known to lack vision gets a note, never the media; OpenAI chat drops PDFs with a note', () => {
  const messages = [
    {role: 'user' as const, content: 'look'},
    {role: 'assistant' as const, content: '', toolCalls: [{id: 'c1', name: 'read', input: {path: 'a.png'}}]},
    {
      role: 'tool' as const,
      content: 'Read image a.png',
      toolCallId: 'c1',
      toolName: 'read',
      attachments: [
        {mime: 'image/png' as const, data: PNG, name: 'a.png'},
        {mime: 'application/pdf' as const, data: 'JVBERi0=', name: 'b.pdf'},
      ],
    },
  ];
  const blind = JSON.stringify(toModelMessages(messages, {protocol: 'anthropic', vision: 'unsupported'}));
  expect(blind).not.toContain(PNG);
  expect(blind).toContain('cannot view images');
  const chat = toModelMessages(messages, {protocol: 'chat', vision: 'unknown'});
  expect(chat.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
  expect(JSON.stringify(chat[2])).toContain('PDF attachment(s) not sent');
  expect(JSON.stringify(chat[3])).toContain(PNG);
  expect(JSON.stringify(chat[3])).not.toContain('JVBERi0=');
});

test('media is validated and scanned: malformed media is binary, a registered secret is refused, names are redacted', async () => {
  const s = setup();
  const png = Buffer.from(PNG, 'base64');
  // Signature only: not an image.
  writeFileSync(
    join(s.root, 'fake.bin'),
    Buffer.concat([png.subarray(0, 8), Buffer.from('junk junk junk junk junk junk')]),
  );
  const fake = await s.read({path: 'fake.bin'});
  expect(fake.code).toBe('BINARY_FILE');
  expect(fake.attachments).toBeUndefined();
  // A real PNG carrying a registered secret after IEND is refused, nothing attached.
  writeFileSync(join(s.root, 'leak.png'), Buffer.concat([png, Buffer.from(REGISTERED_SECRET)]));
  const leak = await s.read({path: 'leak.png'});
  expect(leak.code).toBe('SECRET_IN_MEDIA');
  expect(leak.attachments).toBeUndefined();
  expect(JSON.stringify(leak)).not.toContain(REGISTERED_SECRET);
  // A PDF without a trailer is binary.
  writeFileSync(join(s.root, 'cut.pdf'), '%PDF-1.4\nno trailer');
  expect((await s.read({path: 'cut.pdf'})).code).toBe('BINARY_FILE');
  // The attachment name passes through redaction.
  writeFileSync(join(s.root, `${REGISTERED_SECRET}.png`), png);
  const named = await s.read({path: `${REGISTERED_SECRET}.png`});
  expect(named.attachments?.[0]?.name).toBe('[REDACTED].png');
  // A normal image still attaches.
  writeFileSync(join(s.root, 'ok.png'), png);
  expect((await s.read({path: 'ok.png'})).attachments?.[0]?.data).toBe(PNG);
  // Notebook output images get the same checks.
  writeFileSync(
    join(s.root, 'leak.ipynb'),
    JSON.stringify({
      cells: [
        {
          cell_type: 'code',
          source: 'x',
          outputs: [
            {
              output_type: 'display_data',
              data: {'image/png': Buffer.concat([png, Buffer.from(REGISTERED_SECRET)]).toString('base64')},
            },
            {output_type: 'display_data', data: {'image/png': Buffer.from('not an image at all').toString('base64')}},
          ],
        },
      ],
    }),
  );
  const notebook = await s.read({path: 'leak.ipynb'});
  expect(notebook.attachments).toBeUndefined();
  expect(notebook.content).toContain('omitted');
});

test('directory listing omits symlinks pointing to .git, Futryn state, or outside the workspace', async () => {
  const s = setup();
  writeFileSync(join(s.base, 'outside.txt'), 'outside\n');
  writeFileSync(join(s.root, 'state', 'token.json'), 'secret\n');
  symlinkSync(join(s.root, '.git', 'config'), join(s.root, 'innocent-git-link'));
  symlinkSync(join(s.root, 'state', 'token.json'), join(s.root, 'innocent-state-link'));
  symlinkSync(join(s.base, 'outside.txt'), join(s.root, 'innocent-outside-link'));
  symlinkSync(join(s.root, 'src', 'App.ts'), join(s.root, 'safe-link.ts'));
  const listing = await s.read({path: '.'});
  expect(listing.status).toBe('ok');
  const entries = listing.content.split('\n').slice(1);
  expect(entries).not.toContain('innocent-git-link');
  expect(entries).not.toContain('innocent-state-link');
  expect(entries).not.toContain('innocent-outside-link');
  expect(entries).toContain('safe-link.ts');
});
