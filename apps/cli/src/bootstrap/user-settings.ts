import {lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {
  appearanceSchema,
  defaultAppearance,
  partialAppearanceSchema,
  type AppearanceConfig,
  type PartialAppearanceConfig,
} from '@cosmew/contracts';
import {
  DEFAULT_USER_PREFERENCES,
  type AppearanceStore,
  type EditorMode,
  type UserPreferences,
  type UserPreferencesStore,
} from '@cosmew/sdk';
import {parseSettings} from '@cosmew/security';

const KEYS = [
  'theme',
  'themeMode',
  'reducedMotion',
  'syntaxHighlighting',
  'animations',
  'sidebar',
  'wallpaper',
  'syncWithSystem',
  'lightTheme',
  'darkTheme',
];
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Recover only complete top-level JSON members; never evaluate or guess damaged values. */
function recover(text: string): Record<string, unknown> {
  const raw: Record<string, unknown> = Object.create(null);
  if (!text.trimStart().startsWith('{')) return raw;
  let start = text.indexOf('{') + 1,
    depth = 0,
    quoted = false,
    escaped = false;
  const member = (end: number) => {
    try {
      const value: unknown = JSON.parse('{' + text.slice(start, end) + '}');
      if (record(value)) Object.assign(raw, value);
    } catch {
      /* incomplete member is preserved only in the backup */
    }
  };
  for (let at = start; at < text.length; at++) {
    const char = text[at];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') {
      if (depth === 0) {
        member(at);
        return raw;
      }
      depth--;
    } else if (char === ',' && depth === 0) {
      member(at);
      start = at + 1;
    }
  }
  member(text.length);
  return raw;
}

export interface FileAppearanceOptions {
  stateDirectory: string;
  /** Read-only, lazy legacy adapter; never deletes or rewrites the SQLite source. */
  importLegacy?: () => PartialAppearanceConfig;
}

/** User file only. Repository settings are never read by this store. */
export class FileAppearanceStore implements AppearanceStore, UserPreferencesStore {
  readonly path: string;
  private value = defaultAppearance();
  private editorMode: EditorMode = 'normal';
  private key = '';
  private raw: Record<string, unknown> = {};
  private corrupt: string | undefined;
  private blocked = false;
  private unsavedPreferences: Partial<UserPreferences> = {};
  private readonly sessionSteps = new Set<string>();
  private messages: string[] = [];

  constructor(options: FileAppearanceOptions) {
    this.path = join(options.stateDirectory, 'settings.json');
    this.load();
    if (!this.blocked && this.corrupt === undefined && !KEYS.some(key => Object.hasOwn(this.raw, key))) {
      try {
        const legacy = options.importLegacy?.();
        if (legacy && Object.keys(legacy).length) this.write(legacy);
      } catch {
        this.messages = ['Could not import legacy appearance; defaults apply for this session.'];
      }
    }
  }

  notices(): readonly string[] {
    return [...this.messages];
  }
  read(): AppearanceConfig {
    this.load();
    return structuredClone(this.value);
  }

  readPreferences(): UserPreferences {
    this.load();
    const preferences: UserPreferences = {...DEFAULT_USER_PREFERENCES};
    if (!this.blocked && this.corrupt === undefined) {
      for (const key of Object.keys(preferences) as (keyof UserPreferences)[]) {
        const value = this.raw[key];
        if (typeof value === 'boolean') preferences[key] = value;
      }
    }
    return {...preferences, ...this.unsavedPreferences};
  }

  writePreferences(patch: Partial<UserPreferences>): void {
    this.load();
    const changes = {...this.unsavedPreferences};
    for (const key of Object.keys(DEFAULT_USER_PREFERENCES) as (keyof UserPreferences)[]) {
      const value = patch[key];
      if (typeof value === 'boolean') changes[key] = value;
    }
    this.save({...this.raw, ...changes});
    this.unsavedPreferences = this.messages.length ? changes : {};
  }

  readEditorMode(): EditorMode {
    this.load();
    return this.editorMode;
  }

  writeEditorMode(mode: EditorMode): void {
    this.load();
    this.editorMode = mode;
    this.save({...this.raw, editorMode: mode});
  }

  onboardingState(): {completed: readonly string[]; hasStoredTheme: boolean} {
    this.load();
    const saved =
      !this.blocked && this.corrupt === undefined && Array.isArray(this.raw.onboardingCompleted)
        ? this.raw.onboardingCompleted.filter((id): id is string => typeof id === 'string')
        : [];
    return {
      completed: [...new Set([...saved, ...this.sessionSteps])],
      hasStoredTheme:
        !this.blocked &&
        this.corrupt === undefined &&
        typeof this.raw.theme === 'string' &&
        partialAppearanceSchema.safeParse({theme: this.raw.theme}).success,
    };
  }

  completeOnboardingStep(id: string): void {
    const {completed} = this.onboardingState();
    if (completed.includes(id)) return;
    this.save({...this.raw, onboardingCompleted: [...completed, id]});
    this.sessionSteps.add(id);
  }

  private load(): void {
    let stat;
    try {
      stat = lstatSync(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.blocked = true;
        this.messages = ['Could not read user settings; changes apply for this session only.'];
        return;
      }
    }
    const key = stat ? `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}:${stat.mode}` : 'missing';
    if (this.key === key) return;
    this.key = key;
    this.blocked = false;
    this.corrupt = undefined;
    this.raw = {};
    this.value = defaultAppearance();
    this.editorMode = 'normal';
    if (!stat) return;
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 65536 ||
      (process.getuid && stat.uid !== process.getuid())
    ) {
      this.blocked = true;
      this.messages = ['Unsafe user settings file; changes apply for this session only.'];
      return;
    }
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch {
      this.blocked = true;
      this.messages = ['Could not read user settings; changes apply for this session only.'];
      return;
    }
    try {
      const raw: unknown = text.trim() ? JSON.parse(text) : {};
      if (!record(raw)) throw new Error('shape');
      // Permission parser retains the original object, including unknown keys.
      this.raw = parseSettings(text).raw;
    } catch {
      this.corrupt = text;
      this.raw = recover(text);
      this.messages = [
        'Corrupt user settings; appearance defaults apply until the next successful write (original kept as .bak).',
      ];
      return;
    }
    this.editorMode = this.raw.editorMode === 'vim' ? 'vim' : 'normal';
    const candidate: Record<string, unknown> = {};
    for (const [disk, field] of [
      ['theme', 'theme'],
      ['themeMode', 'mode'],
      ['syntaxHighlighting', 'syntaxHighlighting'],
      ['sidebar', 'sidebar'],
      ['wallpaper', 'wallpaper'],
      ['animations', 'animations'],
      ['syncWithSystem', 'syncWithSystem'],
      ['lightTheme', 'lightTheme'],
      ['darkTheme', 'darkTheme'],
    ] as const) {
      if (this.raw[disk] !== undefined) {
        const parsed = partialAppearanceSchema.safeParse({[field]: this.raw[disk]});
        if (parsed.success) Object.assign(candidate, parsed.data);
      }
    }
    if (typeof this.raw.reducedMotion === 'boolean')
      candidate.animations = {
        ...(record(candidate.animations) ? candidate.animations : {}),
        reducedMotion: this.raw.reducedMotion,
      };
    this.value = appearanceSchema.parse({
      ...defaultAppearance(),
      ...candidate,
      animations: {...defaultAppearance().animations, ...(record(candidate.animations) ? candidate.animations : {})},
    });
  }

  write(patch: PartialAppearanceConfig): void {
    this.load();
    const validated = partialAppearanceSchema.parse(patch);
    this.value = appearanceSchema.parse({
      ...this.value,
      ...validated,
      animations: {...this.value.animations, ...validated.animations},
    });
    const raw = {
      ...this.raw,
      theme: this.value.theme,
      themeMode: this.value.mode,
      reducedMotion: this.value.animations.reducedMotion,
      syntaxHighlighting: this.value.syntaxHighlighting,
      animations: this.value.animations,
      sidebar: this.value.sidebar,
      wallpaper: this.value.wallpaper,
      syncWithSystem: this.value.syncWithSystem,
      lightTheme: this.value.lightTheme,
      darkTheme: this.value.darkTheme,
    };
    this.save(raw);
  }

  private save(raw: Record<string, unknown>): void {
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      if (this.blocked) throw new Error('unreadable');
      // rename would otherwise replace a read-only file when its parent is writable.
      try {
        if (!(lstatSync(this.path).mode & 0o222)) throw new Error('read-only');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      mkdirSync(dirname(this.path), {recursive: true, mode: 0o700});
      const text = JSON.stringify(raw, null, 2) + '\n';
      if (Buffer.byteLength(text, 'utf8') > 65536) throw new Error('too large');
      writeFileSync(temporary, text, {mode: 0o600, flag: 'wx'});
      if (this.corrupt !== undefined) {
        try {
          writeFileSync(this.path + '.bak', this.corrupt, {mode: 0o600, flag: 'wx'});
        } catch (error) {
          const backup = lstatSync(this.path + '.bak');
          if (
            (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
            !backup.isFile() ||
            backup.isSymbolicLink() ||
            readFileSync(this.path + '.bak', 'utf8') !== this.corrupt
          )
            throw error;
        }
      }
      renameSync(temporary, this.path);
      this.raw = raw;
      this.corrupt = undefined;
      const stat = lstatSync(this.path);
      this.key = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}:${stat.mode}`;
      this.messages = [];
    } catch {
      this.messages = ['Could not save user settings; changes apply for this session only.'];
    } finally {
      try {
        rmSync(temporary, {force: true});
      } catch {
        /* best effort */
      }
    }
  }
}
