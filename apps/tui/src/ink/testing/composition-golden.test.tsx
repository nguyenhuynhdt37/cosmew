/** @jsxImportSource react */
import {expect, test} from 'bun:test';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {renderToString} from 'ink';
import {InkApp} from '../app';
import {Transcript} from '../features/transcript';
import {LiveDialog} from '../ui';
import {PermissionRequestDialog} from '../features/permissions';
import {Plan} from '../features/plan';
import {messagesToTranscript} from '../features/transcript/logic';
import {createClientFixture} from './client-fixture';
import {ThemeEngine} from '../../theme/theme';

for (const width of [80, 36])
  test(`Ink composed golden ${width} columns`, () => {
    const {client} = createClientFixture();
    const themeEngine = new ThemeEngine({env: {NO_COLOR: '1'}, systemDarkPreference: true});
    const tree = (
      <InkApp
        client={client}
        themeEngine={themeEngine}
        width={width}
        slots={{
          transcript: (
            <Transcript
              historyOffset={0}
              animate={false}
              width={width}
              items={messagesToTranscript(
                [
                  {
                    role: 'user',
                    content: 'Inspect the integration and preserve permission boundaries · Tiếng Việt 日本語',
                  },
                  {
                    role: 'assistant',
                    content:
                      '**Ready**\n\n- Checked tool policy\n- Kept legacy default\n\n```ts\nconst ready = true;\n```',
                    toolCalls: [{id: 'read-1', name: 'read', input: {path: 'note.txt'}}],
                  },
                  {role: 'tool', toolCallId: 'read-1', toolName: 'read', content: 'Safe fixture content'},
                ],
                'golden',
              )}
            />
          ),
          plan: (
            <Plan
              width={width}
              plan={{
                updatedAt: '2026-11-18T00:00:00Z',
                items: [{step: 'Verify integrated UI', status: 'in_progress'}],
                explanation: 'Integration verification',
              }}
            />
          ),
        }}
      />
    );
    const actual = renderToString(tree, {columns: width}) + '\n';
    const dir = join(import.meta.dir, 'golden-ink');
    const path = join(dir, `integrated-${width}.txt`);
    writeFileSync(join('/tmp', `futryn-ink-candidate-${width}.txt`), actual);
    if (process.env.UPDATE_GOLDEN === '1') {
      mkdirSync(dir, {recursive: true});
      writeFileSync(path, actual);
    }
    let expected = '';
    try {
      expected = readFileSync(path, 'utf8');
    } catch {
      /* A missing baseline fails; inspect the /tmp candidate first. */
    }
    expect(actual).toBe(expected);
  });

// Phase F: pending tool activity remains above the inline prompt at both widths.
for (const width of [80, 36])
  test(`Ink inline permission golden ${width} columns`, () => {
    const {client} = createClientFixture();
    const themeEngine = new ThemeEngine({env: {NO_COLOR: '1'}});
    const request = client.enqueuePermissionRequest({
      capability: 'process.execute',
      action: 'exec_command',
      target: 'bun test',
      reason: 'Run tests',
      decisions: ['once', 'session'],
    });
    const actual =
      renderToString(
        <InkApp
          client={client}
          themeEngine={themeEngine}
          width={width}
          slots={{
            transcript: (
              <Transcript
                bounded
                animate={false}
                showSpinner={false}
                width={width}
                items={[
                  {
                    id: 'pending',
                    role: 'assistant',
                    content: 'Checking the workspace.',
                    streaming: true,
                    toolCalls: [{id: 'bash', name: 'exec_command', input: {cmd: 'bun test'}}],
                  },
                ]}
              />
            ),
            composer: (
              <LiveDialog rows={24}>
                <PermissionRequestDialog width={width} request={request} />
              </LiveDialog>
            ),
          }}
        />,
        {columns: width},
      ) + '\n';
    const path = join(import.meta.dir, 'golden-ink', `permission-${width}.txt`);
    writeFileSync(join('/tmp', `futryn-permission-candidate-${width}.txt`), actual);
    if (process.env.UPDATE_GOLDEN === '1') writeFileSync(path, actual);
    expect(actual).toBe(readFileSync(path, 'utf8'));
  });
