/** @jsxImportSource react */
import {createContext, useContext, useLayoutEffect, useReducer, type ReactNode} from 'react';
import type {ThemeTokenKey} from '@futryn/contracts';
import {ThemeEngine} from '../../theme/theme';

function readTheme(engine: ThemeEngine) {
  const tokens = engine.getActiveTokens();
  const colors = engine.colorCapability !== 'none';
  const appearance = engine.getActiveAppearance();
  return {
    engine,
    tokens,
    colors,
    mode: engine.getEffectiveMode(),
    color: (token: ThemeTokenKey): string | undefined => (colors ? tokens[token] : undefined),
    animate: appearance.animations.enabled && !appearance.animations.reducedMotion,
    syntaxHighlighting: appearance.syntaxHighlighting,
  };
}
const fallback = new ThemeEngine({systemDarkPreference: true});
const ThemeContext = createContext(readTheme(fallback));
export function ThemeProvider({engine, children}: {engine: ThemeEngine; children: ReactNode}) {
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useLayoutEffect(() => {
    const stop = engine.subscribe(refresh);
    refresh();
    return stop;
  }, [engine]);
  return <ThemeContext.Provider value={readTheme(engine)}>{children}</ThemeContext.Provider>;
}
export function useTheme() {
  return useContext(ThemeContext);
}
