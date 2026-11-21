/** @jsxImportSource react */
import {renderToString} from 'ink';
import {InkApp} from '../../app';
import {ThemeEngine} from '../../../theme/theme';
import {StartupGate, useStartupGate} from '../startup-gate';
import {PermissionRequestDialog} from '../permissions';
import {QuestionDialog} from '../question';
import {HelpDialog} from '../help';
import {SettingsDialog} from '../settings';
import {RewindDialog} from '../panels';
import {dialogFixture} from './test-fixture';
const fixture = dialogFixture();
const {client} = fixture;
client.setUserInputAvailable(true);
void client.askUser([
  {id: 'c', header: 'Color', question: 'Which color?', options: [{label: 'Red', description: 'warm'}]},
]);
const request = client.enqueuePermissionRequest({
  capability: 'fs.write',
  action: 'edit',
  target: 'a.txt',
  reason: 'Edit',
  decisions: ['once'],
  diffPreview: '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-hello\n+HELLO\n world',
});
const engine = new ThemeEngine({env: {FORCE_COLOR: '3'}});
const frame = (node: React.ReactNode) =>
  renderToString(<InkApp client={client} themeEngine={engine} slots={{transcript: node}} />);
function Gate() {
  const state = useStartupGate({onReady() {}, onExit() {}});
  return <StartupGate state={state} width={100} />;
}
process.stdout.write(
  JSON.stringify({
    trust: frame(<Gate />),
    permission: frame(<PermissionRequestDialog request={request} width={100} />),
    question: frame(<QuestionDialog width={100} />),
    help: frame(<HelpDialog width={100} />),
    settings: frame(<SettingsDialog width={100} />),
    rewind: frame(<RewindDialog width={100} />),
  }),
);
