import { THEME_TOKEN_KEYS } from '@hannes/contracts';
import { wideLayout } from '../../core/layout';
import type { OverlayFeature, ThemeFrame, TuiHost } from '../../core/feature';
import { editField, stepIndex } from '../../ui';
import { HEX_CHAR, customCopyId, duplicateId, withHash } from './logic';
import { createInitialThemeEditorState, type ThemeEditorState } from './types';
import { renderThemeEditorOverlay } from './view';

export class ThemeEditorFeature implements OverlayFeature {
  readonly overlays = ['theme-editor'] as const;
  private state: ThemeEditorState = createInitialThemeEditorState();

  constructor(private readonly host: TuiHost) {}

  open(): void {
    const { themeEngine } = this.host;
    this.state = createInitialThemeEditorState(themeEngine.getActiveAppearance().theme, themeEngine.getEffectiveMode());
  }

  layout(_overlay: 'theme-editor', cols: number, rows: number) { return wideLayout(cols, rows); }

  render(_overlay: 'theme-editor', size: { width: number; height: number }, theme: ThemeFrame) {
    return renderThemeEditorOverlay({ ...size, engine: this.host.themeEngine, state: this.state, tokens: theme.tokens, borderStyle: theme.borderStyle });
  }

  async handleKey(_overlay: 'theme-editor', key: string): Promise<void> {
    const { host } = this;
    const engine = host.themeEngine;
    const st = this.state;
    const manifest = engine.getTheme(st.targetThemeId) ?? engine.getActiveThemeManifest();
    const patch = (next: Partial<ThemeEditorState>) => { this.state = { ...st, ...next }; };

    if (st.renaming) {
      if (key === 'Escape') { patch({ renaming: false }); return; }
      if (key === 'Enter') {
        try {
          const targetId = manifest.builtIn
            ? (await engine.duplicateTheme(manifest.id, customCopyId(manifest.id), st.nameDraft)).id
            : (await engine.renameCustomTheme(manifest.id, st.nameDraft), manifest.id);
          patch({ targetThemeId: targetId, renaming: false, statusMessage: `Saved custom theme name "${st.nameDraft}".` });
        } catch {
          patch({ renaming: false, statusMessage: 'Invalid theme name.' });
        }
        return;
      }
      const nameDraft = editField(st.nameDraft, key, { max: 60 });
      if (nameDraft !== null) patch({ nameDraft });
      return;
    }

    if (st.editingHex) {
      if (key === 'Escape') { patch({ editingHex: false }); return; }
      if (key === 'Enter') {
        const tokenKey = THEME_TOKEN_KEYS[st.selectedTokenIndex]!;
        const candidateHex = withHash(st.hexDraft);
        try {
          let targetId = manifest.id;
          if (manifest.builtIn) {
            targetId = customCopyId(manifest.id);
            if (!engine.hasTheme(targetId)) await engine.duplicateTheme(manifest.id, targetId, `${manifest.name} Custom`);
          }
          await engine.updateCustomThemeToken(targetId, st.editMode, tokenKey, candidateHex);
          await engine.setTheme(targetId);
          patch({ targetThemeId: targetId, editingHex: false, statusMessage: `Updated ${tokenKey} to ${candidateHex.toLowerCase()} on "${targetId}".` });
        } catch {
          patch({ editingHex: false, statusMessage: `Invalid hex color "${candidateHex}". Expected #rrggbb.` });
        }
        return;
      }
      const hexDraft = editField(st.hexDraft, key, { max: 7, accept: HEX_CHAR });
      if (hexDraft !== null) patch({ hexDraft });
      return;
    }

    const tokenKey = THEME_TOKEN_KEYS[st.selectedTokenIndex]!;
    if (key === 'Escape') { host.closeOverlay(); return; }
    if (key === 'Tab') { patch({ editMode: st.editMode === 'dark' ? 'light' : 'dark' }); return; }
    if (key === 'ArrowDown' || key === 'ArrowUp') { patch({ selectedTokenIndex: stepIndex(st.selectedTokenIndex, key, THEME_TOKEN_KEYS.length) }); return; }
    if (key === 'Enter') {
      patch({ editingHex: true, hexDraft: (st.editMode === 'light' ? manifest.light : manifest.dark)[tokenKey] });
      return;
    }
    if (key === 'Ctrl+D') {
      const dup = await engine.duplicateTheme(manifest.id, duplicateId(manifest.id), `${manifest.name} Copy`);
      await engine.setTheme(dup.id);
      patch({ targetThemeId: dup.id, statusMessage: `Duplicated to custom theme "${dup.id}".` });
      return;
    }
    if (key === 'Ctrl+R') { patch({ renaming: true, nameDraft: manifest.name }); return; }
    if (key === 'Ctrl+Z') {
      if (manifest.builtIn) { patch({ statusMessage: 'Built-in themes are already at default values.' }); return; }
      await engine.resetCustomThemeToken(manifest.id, st.editMode, tokenKey);
      patch({ statusMessage: `Reset token "${tokenKey}" to default.` });
      return;
    }
    if (key === 'Ctrl+U') {
      if (manifest.builtIn) { patch({ statusMessage: 'Built-in themes cannot be reset.' }); return; }
      await engine.resetCustomTheme(manifest.id);
      patch({ statusMessage: `Reset all tokens of "${manifest.id}" to default.` });
      return;
    }
    if (key === 'Ctrl+X') {
      if (manifest.builtIn) { patch({ statusMessage: 'Built-in themes are immutable and cannot be deleted.' }); return; }
      await engine.removeCustomTheme(manifest.id);
      this.state = { ...createInitialThemeEditorState('auto', engine.getEffectiveMode()), statusMessage: `Deleted custom theme "${manifest.id}".` };
    }
  }
}
