import type { UserPreferences } from '../api';

/**
 * The code editor's look, as the Settings dialog sets it: a font family and
 * a size. Kept apart from `viewerSettings` (which is the 3D viewport's) and
 * apart from Monaco (which loads lazily, so this module must not pull it in)
 * — the pane reads the store when it creates its editor and follows it after.
 */
export interface EditorPrefs {
  /** A font family name; empty means the editor's own default stack. */
  fontFamily: string;
  /** Font size, px. */
  fontSize: number;
  /** Lines wrap at the pane edge instead of scrolling sideways. */
  wordWrap: boolean;
  /** The pane opens with the page. Off: the scene alone, the editor a click away. */
  openAtStartup: boolean;
}

export const DEFAULT_EDITOR_FONT_SIZE = 13;
/** Monaco's own stack; what an empty `fontFamily` resolves to. */
export const EDITOR_DEFAULT_FONT_STACK = "Menlo, Monaco, 'Courier New', monospace";

type Listener = (prefs: EditorPrefs) => void;

const defaults: EditorPrefs = { fontFamily: '', fontSize: DEFAULT_EDITOR_FONT_SIZE, wordWrap: false, openAtStartup: false };

class EditorPrefsStore {
  current: EditorPrefs = { ...defaults };
  private listeners = new Set<Listener>();

  update(partial: Partial<EditorPrefs>): void {
    Object.assign(this.current, partial);
    for (const fn of this.listeners) {
      fn(this.current);
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const editorPrefs = new EditorPrefsStore();

export function applyEditorPreferences(prefs: UserPreferences): void {
  editorPrefs.update({
    fontFamily: typeof prefs.editorFontFamily === 'string' ? prefs.editorFontFamily : '',
    fontSize: typeof prefs.editorFontSize === 'number' ? prefs.editorFontSize : DEFAULT_EDITOR_FONT_SIZE,
    wordWrap: prefs.editorWordWrap === true,
    openAtStartup: prefs.editorOpen === true,
  });
}

/** The Monaco options one `EditorPrefs` amounts to — the same rule at create and on change. */
export function editorPrefOptions(prefs: EditorPrefs): {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  wordWrap: 'on' | 'off';
} {
  const family = prefs.fontFamily.trim();
  return {
    fontFamily: family === '' ? EDITOR_DEFAULT_FONT_STACK : `'${family}', ${EDITOR_DEFAULT_FONT_STACK}`,
    fontSize: prefs.fontSize,
    // The stock 13px editor draws 20px lines; keep that ratio as the size moves.
    lineHeight: Math.round(prefs.fontSize * (20 / DEFAULT_EDITOR_FONT_SIZE)),
    wordWrap: prefs.wordWrap ? 'on' : 'off',
  };
}
