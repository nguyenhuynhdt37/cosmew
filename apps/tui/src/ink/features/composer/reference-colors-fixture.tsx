/** @jsxImportSource react */
import {renderToString} from 'ink';
import {FutrynClientProvider} from '../../hooks';
import {ThemeProvider} from '../../theme';
import {OverlayProvider} from '../../core';
import {ThemeEngine} from '../../../theme/theme';
import {createClientFixture} from '../../testing';
import {ComposerView, useComposer, type ComposerOptions} from './index';

const light = process.argv[2] === 'light';
const engine = new ThemeEngine({env: {FORCE_COLOR: '3', ...(light ? {COLORFGBG: '0;15'} : {COLORFGBG: '15;0'})}});
function Harness(props: ComposerOptions) {
  const state = useComposer({...props, inputWidth: 97});
  return <ComposerView controller={state} width={100} fullscreen />;
}
const frame = (props: Partial<ComposerOptions>, mode?: 'plan' | 'acceptEdits' | 'bypassPermissions') => {
  const fixture = createClientFixture();
  if (mode && mode !== 'bypassPermissions') fixture.client.setPermissionMode(mode);
  return renderToString(
    <FutrynClientProvider client={fixture.client}>
      <ThemeProvider engine={engine}>
        <OverlayProvider>
          <Harness onSubmit={() => {}} {...props} />
        </OverlayProvider>
      </ThemeProvider>
    </FutrynClientProvider>,
    {columns: 100},
  );
};
process.stdout.write(
  JSON.stringify({
    mode: engine.getEffectiveMode(),
    idle: frame({}),
    bash: frame({initialValue: '!'}),
    plan: frame({}, 'plan'),
    accept: frame({}, 'acceptEdits'),
    busy: frame({busy: true}),
    slash: frame({initialValue: '/mo'}),
    files: frame({initialValue: '@', workspaceAccess: true}),
  }),
);
