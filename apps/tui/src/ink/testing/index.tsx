/** @jsxImportSource react */
import type {ReactElement} from 'react';
import {render} from 'ink-testing-library';
import {ThemeEngine} from '../../theme/theme';
import {FutrynClientProvider} from '../hooks';
import {ThemeProvider} from '../theme';
import {OverlayProvider} from '../core/overlay';
import {createClientFixture, type ClientFixture} from './client-fixture';
export * from './client-fixture';
export const settle = () => new Promise<void>(resolve => setTimeout(resolve, 30));
export function renderInk(tree: ReactElement, options: {fixture?: ClientFixture; themeEngine?: ThemeEngine} = {}) {
  const fixture = options.fixture ?? createClientFixture();
  const engine = options.themeEngine ?? new ThemeEngine({env: {NO_COLOR: '1'}, systemDarkPreference: true});
  const wrap = (element: ReactElement) => (
    <FutrynClientProvider client={fixture.client}>
      <ThemeProvider engine={engine}>
        <OverlayProvider>{element}</OverlayProvider>
      </ThemeProvider>
    </FutrynClientProvider>
  );
  const view = render(wrap(tree));
  return {...view, fixture, rerender: (element: ReactElement) => view.rerender(wrap(element))};
}
