/** @jsxImportSource react */
import {renderToString} from 'ink';
import {FutrynClientProvider, KeymapProvider} from '../../hooks';
import {ThemeProvider} from '../../theme';
import {OverlayProvider} from '../../core';
import {ThemeEngine} from '../../../theme/theme';
import {dialogFixture} from '../picker/test-fixture';
import {PlanApprovalDialog} from './index';
const light = process.argv[2] === 'light';
const engine = new ThemeEngine({env: {FORCE_COLOR: '3', COLORFGBG: light ? '0;15' : '15;0'}});
const fixture = dialogFixture({
  startSession: () => ({id: 's', selection: {accountId: 'a', modelId: 'm'}, messages: []}),
});
fixture.client.createSession();
fixture.client.setPermissionMode('plan');
fixture.client.setUserInputAvailable(true);
void fixture.client.proposePlan('Add subtract.');
process.stdout.write(
  JSON.stringify(
    renderToString(
      <FutrynClientProvider client={fixture.client}>
        <ThemeProvider engine={engine}>
          <KeymapProvider>
            <OverlayProvider>
              <PlanApprovalDialog width={80} visibleRows={2} onCancel={() => {}} />
            </OverlayProvider>
          </KeymapProvider>
        </ThemeProvider>
      </FutrynClientProvider>,
      {columns: 80},
    ),
  ),
);
