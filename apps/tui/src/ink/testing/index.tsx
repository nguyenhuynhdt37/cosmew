/** @jsxImportSource react */
import type {ReactElement} from 'react';
import {render} from './wait';
import {ThemeEngine} from '../../theme/theme';
import {FutrynClientProvider, KeymapProvider} from '../hooks';
import {ThemeProvider} from '../theme';
import {OverlayProvider} from '../core/overlay';
import {createClientFixture, type ClientFixture} from './client-fixture';
export * from './client-fixture';
export {render, settle, waitForCondition, waitForFrame} from './wait';
export function renderInk(tree: ReactElement, options: {fixture?: ClientFixture; themeEngine?: ThemeEngine} = {}) {
  const fixture = options.fixture ?? createClientFixture();
  const engine = options.themeEngine ?? new ThemeEngine({env: {NO_COLOR: '1'}, systemDarkPreference: true});
  const wrap = (element: ReactElement) => (
    <FutrynClientProvider client={fixture.client}>
      <ThemeProvider engine={engine}>
        <KeymapProvider>
          <OverlayProvider>{element}</OverlayProvider>
        </KeymapProvider>
      </ThemeProvider>
    </FutrynClientProvider>
  );
  const view = render(wrap(tree));
  return {...view, fixture, rerender: (element: ReactElement) => view.rerender(wrap(element))};
}
