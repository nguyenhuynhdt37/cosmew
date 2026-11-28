/** @jsxImportSource react */
import {createContext, useContext, useLayoutEffect, useMemo, useReducer, type ReactNode} from 'react';
import type {AppearanceConfig, ThemeManifest, ThemeTokenKey} from '@cosmew/contracts';
import {ThemeEngine} from '../../theme/theme';

function buildView(engine: ThemeEngine, manifest: ThemeManifest, mode: 'dark' | 'light', appearance: AppearanceConfig) {
  const tokens = engine.tokensFor(manifest, mode);
  const colors = engine.colorCapability !== 'none';
  return {
    engine,
    manifest,
    tokens,
    appearance,
    colors,
    mode,
    color: (token: ThemeTokenKey): string | undefined => (colors ? tokens[token] : undefined),
    animate: appearance.animations.enabled && !appearance.animations.reducedMotion,
    syntaxHighlighting: appearance.syntaxHighlighting,
  };
}
export type ThemeValue = ReturnType<typeof buildView>;

/** One cached view per (manifest, mode, capability, appearance): identical inputs return the same object. */
const views = new WeakMap<ThemeManifest, Map<string, ThemeValue>>();
export function themeView(
  engine: ThemeEngine,
  manifest: ThemeManifest,
  mode: 'dark' | 'light',
  appearance: AppearanceConfig = engine.getActiveAppearance(),
): ThemeValue {
  let byKey = views.get(manifest);
  if (!byKey) views.set(manifest, (byKey = new Map()));
  const key = `${mode}:${engine.colorCapability}:${JSON.stringify(appearance)}`;
  const hit = byKey.get(key);
  if (hit && hit.engine === engine) return hit;
  if (byKey.size > 32) byKey.clear();
  const view = buildView(engine, manifest, mode, appearance);
  byKey.set(key, view);
  return view;
}

function readTheme(engine: ThemeEngine): ThemeValue {
  return themeView(engine, engine.getActiveThemeManifest(), engine.getEffectiveMode());
}
const fallback = new ThemeEngine({systemDarkPreference: true});
const ThemeContext = createContext(readTheme(fallback));
export function ThemeProvider({engine, children}: {engine: ThemeEngine; children: ReactNode}) {
  const [revision, refresh] = useReducer((n: number) => n + 1, 0);
  useLayoutEffect(() => {
    const stop = engine.subscribe(refresh);
    refresh();
    return stop;
  }, [engine]);
  const value = useMemo(() => readTheme(engine), [engine, revision]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Themes only its children with `themeId`, without previewing through the engine, so the rest of the
 * app (transcript included) never re-renders while a picker moves its cursor (ADR 0127).
 */
export function ThemePreviewScope({themeId, children}: {themeId: string; children: ReactNode}) {
  const parent = useContext(ThemeContext);
  const value = useMemo(() => {
    const {engine} = parent;
    const manifest = engine.getTheme(themeId) ?? parent.manifest;
    return themeView(engine, manifest, engine.previewModeFor(manifest.id), {...parent.appearance, theme: manifest.id});
  }, [parent, themeId]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
