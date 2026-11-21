/** @jsxImportSource react */
import {renderToString} from 'ink';
import {InkApp} from '../app';
import {ThemeEngine} from '../../theme/theme';
import {dialogFixture} from '../features/picker/test-fixture';
import {Welcome} from '../features/welcome';
import {Transcript} from '../features/transcript';
import {ComposerFooter} from '../features/status';
import {PermissionRequestDialog} from '../features/permissions';
import {Notices} from '../features/notices';
import {Diff, ListPicker, Spinner} from '../ui';
const {client} = dialogFixture();
const request = client.enqueuePermissionRequest({
  capability: 'fs.read',
  action: 'Read file',
  target: 'file',
  reason: 'fixture',
  decisions: ['once'],
});
const engine = new ThemeEngine({env: {FORCE_COLOR: '3'}});
const frame = (transcript: React.ReactNode) =>
  renderToString(<InkApp client={client} themeEngine={engine} slots={{transcript}} />);
process.stdout.write(
  JSON.stringify({
    welcome: frame(<Welcome status={client.status()} />),
    activity: frame(
      <>
        <Transcript
          bounded
          detailed
          animate={false}
          items={[
            {
              id: 'tool',
              role: 'assistant',
              content: '',
              toolCalls: [
                {id: 'ok', name: 'read', input: {path: 'ok'}},
                {id: 'error', name: 'read', input: {path: 'error'}},
              ],
              toolResults: [
                {callId: 'ok', name: 'read', status: 'ok', content: 'done'},
                {callId: 'error', name: 'read', status: 'error', content: 'failed'},
              ],
            },
          ]}
        />
        <Spinner startedAt={Date.now()} />
        <Notices notices={[{id: 'warning', text: '⚠ Warning'}]} />
      </>,
    ),
    modes: frame(
      <>
        {(['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const).map(mode => (
          <ComposerFooter key={mode} mode={mode} width={80} />
        ))}
      </>,
    ),
    permission: frame(<PermissionRequestDialog request={request} />),
    picker: frame(<ListPicker items={[{id: 'selected', label: 'Selected'}]} onSelect={() => {}} />),
    diff: frame(<Diff diff={'@@ -1 +1 @@\n-old\n+new'} />),
    user: frame(<Transcript bounded items={[{id: 'user', role: 'user', content: 'prompt'}]} />),
  }),
);
