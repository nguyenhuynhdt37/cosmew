import {describe, expect, test} from 'bun:test';
import {WALLPAPER_PRESET_IDS, defaultAnimationConfig} from '@futryn/contracts';
import {WALLPAPER_SCENES, WallpaperEngine} from '@futryn/tui';

describe('FUTRYN Live ASCII Wallpaper Engine', () => {
  test('implements all 12 declarative ASCII wallpaper presets and resolves clawd alias to futryn-spark', () => {
    const engine = new WallpaperEngine();
    expect(Object.keys(WALLPAPER_SCENES).length).toBe(12);
    expect(engine.listPresets().length).toBe(12);
    expect(WALLPAPER_PRESET_IDS.length).toBe(12);

    for (const id of WALLPAPER_PRESET_IDS) {
      const preset = engine.getPreset(id);
      expect(preset).toBeDefined();
      expect(preset?.id).toBe(id);
    }

    // Compatibility alias for upstream clawd scene
    expect(engine.getPreset('clawd')?.id).toBe('futryn-spark');
    expect(engine.getPreset('non-existent')).toBeNull();
  });

  test('renders non-empty ASCII frames across all 12 presets within budget and supports smooth/grid motion', () => {
    const engine = new WallpaperEngine();
    const cols = 100;
    const rows = 30;
    const config = defaultAnimationConfig();

    for (const preset of engine.listPresets()) {
      const frameA = engine.renderFrame(preset.id, {
        cols,
        rows,
        timeSeconds: 1.5,
        config: {...config, motion: 'smooth', veil: 0.2},
        backgroundHex: preset.defaultBg,
        eventKind: 'streaming',
      });
      expect(frameA.length).toBe(rows);
      expect(frameA[0]?.length).toBe(cols);

      let populatedCells = 0;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const cell = frameA[y]?.[x];
          if (cell) {
            populatedCells++;
            expect(cell.fg).toMatch(/^#[0-9a-f]{6}$/);
            expect(cell.ch.length).toBe(1);
          }
        }
      }
      expect(populatedCells).toBeGreaterThan(20);
      // Fast pure arithmetic cell generation (< 25ms even under CI load)
      expect(engine.lastFrameMs()).toBeLessThan(25);

      const frameGrid = engine.renderFrame(preset.id, {
        cols,
        rows,
        timeSeconds: 3.2,
        config: {...config, motion: 'grid', cellSize: 2},
        backgroundHex: preset.defaultBg,
      });
      expect(frameGrid.length).toBe(rows);
    }
  });

  test('attenuates center reading column with readability veil and respects reducedMotion, pauseUnfocused, and tiny terminal auto-disable', () => {
    const engine = new WallpaperEngine();
    const cols = 90;
    const rows = 28;
    const baseCfg = defaultAnimationConfig();

    // High veil (0.9) should strongly attenuate alpha in the center reading column compared to low veil (0.0)
    const noVeil = engine.renderFrame('sakura-dusk', {
      cols,
      rows,
      timeSeconds: 5,
      config: {...baseCfg, veil: 0},
      backgroundHex: '#231a2e',
      centerColumnRange: [20, 70],
    });
    const highVeil = engine.renderFrame('sakura-dusk', {
      cols,
      rows,
      timeSeconds: 5,
      config: {...baseCfg, veil: 0.9},
      backgroundHex: '#231a2e',
      centerColumnRange: [20, 70],
    });

    let sumNoVeilCenterAlpha = 0;
    let sumHighVeilCenterAlpha = 0;
    for (let y = 0; y < rows; y++) {
      for (let x = 30; x < 60; x++) {
        sumNoVeilCenterAlpha += noVeil[y]?.[x]?.alpha ?? 0;
        sumHighVeilCenterAlpha += highVeil[y]?.[x]?.alpha ?? 0;
      }
    }
    expect(sumHighVeilCenterAlpha).toBeLessThan(sumNoVeilCenterAlpha);

    // Reduced motion renders identical static frames across different timestamps
    const static1 = engine.renderFrame('moonlit', {
      cols,
      rows,
      timeSeconds: 1,
      config: {...baseCfg, reducedMotion: true},
      backgroundHex: '#0f1628',
    });
    const static2 = engine.renderFrame('moonlit', {
      cols,
      rows,
      timeSeconds: 42,
      config: {...baseCfg, reducedMotion: true},
      backgroundHex: '#0f1628',
    });
    expect(static1).toEqual(static2);

    // Unfocused terminal with pauseUnfocused freezes animation
    const unfocused1 = engine.renderFrame('koi-pond', {
      cols,
      rows,
      timeSeconds: 2,
      config: {...baseCfg, pauseUnfocused: true},
      backgroundHex: '#091821',
      focused: false,
    });
    const unfocused2 = engine.renderFrame('koi-pond', {
      cols,
      rows,
      timeSeconds: 19,
      config: {...baseCfg, pauseUnfocused: true},
      backgroundHex: '#091821',
      focused: false,
    });
    expect(unfocused1).toEqual(unfocused2);

    // Auto-disables on tiny terminals (< 24 cols or < 8 rows) or when disabled
    const tiny = engine.renderFrame('neon-rain', {
      cols: 18,
      rows: 6,
      timeSeconds: 1,
      config: baseCfg,
      backgroundHex: '#0c1020',
    });
    const tinyPopulated = tiny.flat().filter(Boolean).length;
    expect(tinyPopulated).toBe(0);

    const disabled = engine.renderFrame('neon-rain', {
      cols,
      rows,
      timeSeconds: 1,
      config: {...baseCfg, enabled: false},
      backgroundHex: '#0c1020',
    });
    expect(disabled.flat().filter(Boolean).length).toBe(0);
  });
});
