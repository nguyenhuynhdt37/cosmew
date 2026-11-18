/** @jsxImportSource react */
import {expect, test} from 'bun:test';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {renderToString} from 'ink';
import {InkApp} from '../app';
import {Transcript} from '../features/transcript';
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
