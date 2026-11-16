import type {SettingsSection} from './logic';

export interface SettingsOverlayState {
  selectedIndex: number;
  section: SettingsSection;
  appearanceScope: 'global' | 'project';
}
