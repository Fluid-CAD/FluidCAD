import { editorPrefs, type EditorPrefs } from '../../editor/editor-prefs';
import { installedMonospaceFonts } from './monospace-fonts';
import {
  SELECT,
  field,
  numberField,
  toggleRow,
  type PersistPreference,
  type SettingsContext,
  type SettingsTab,
} from './settings-tab';

export const EDITOR_FONT_SIZE_MIN = 8;
export const EDITOR_FONT_SIZE_MAX = 40;

/** The value of the "Editor default" font option — an empty family in the store. */
const DEFAULT_FAMILY = '';

/** Font family, font size, word wrap, and whether the pane opens with the page. */
export class EditorTab implements SettingsTab {
  readonly id = 'editor';
  readonly label = 'Editor';
  private family!: HTMLSelectElement;
  private size!: HTMLInputElement;
  private wordWrap!: HTMLInputElement;
  private openAtStartup!: HTMLInputElement;
  private installed: string[] = [];
  private draft: EditorPrefs = { ...editorPrefs.current };

  mount(root: HTMLElement, ctx: SettingsContext): void {
    this.installed = installedMonospaceFonts();
    this.family = document.createElement('select');
    this.family.className = SELECT;
    this.family.addEventListener('change', () => {
      this.draft.fontFamily = this.family.value;
      ctx.changed();
    });
    root.appendChild(field('Font', this.family));

    this.size = numberField(EDITOR_FONT_SIZE_MIN, EDITOR_FONT_SIZE_MAX, (fontSize) => {
      this.draft.fontSize = fontSize;
      ctx.changed();
    });
    root.appendChild(field('Font size (px)', this.size));

    const wrap = toggleRow('Word wrap', (wordWrap) => {
      this.draft.wordWrap = wordWrap;
      ctx.changed();
    });
    this.wordWrap = wrap.input;
    root.appendChild(wrap.row);

    const startup = toggleRow('Open the editor at startup', (openAtStartup) => {
      this.draft.openAtStartup = openAtStartup;
      ctx.changed();
    });
    this.openAtStartup = startup.input;
    root.appendChild(startup.row);

    this.sync();
  }

  sync(): void {
    this.draft = { ...editorPrefs.current };
    this.fillFamilies(this.draft.fontFamily);
    this.family.value = this.draft.fontFamily;
    if (this.family.value !== this.draft.fontFamily) {
      // Not in the list even after filling: fall back visibly to the default.
      this.family.value = DEFAULT_FAMILY;
    }
    this.size.value = String(this.draft.fontSize);
    this.wordWrap.checked = this.draft.wordWrap;
    this.openAtStartup.checked = this.draft.openAtStartup;
  }

  isDirty(): boolean {
    const current = editorPrefs.current;
    return (
      this.draft.fontFamily !== current.fontFamily ||
      this.draft.fontSize !== current.fontSize ||
      this.draft.wordWrap !== current.wordWrap ||
      this.draft.openAtStartup !== current.openAtStartup
    );
  }

  save(persist: PersistPreference): void {
    const current = editorPrefs.current;
    if (this.draft.fontFamily !== current.fontFamily) {
      persist('editorFontFamily', this.draft.fontFamily);
    }
    if (this.draft.fontSize !== current.fontSize) {
      persist('editorFontSize', this.draft.fontSize);
    }
    if (this.draft.wordWrap !== current.wordWrap) {
      persist('editorWordWrap', this.draft.wordWrap);
    }
    if (this.draft.openAtStartup !== current.openAtStartup) {
      persist('editorOpen', this.draft.openAtStartup);
    }
    editorPrefs.update({ ...this.draft });
  }

  /**
   * "Editor default", every installed candidate, and — when the stored font
   * is none of those (set on another machine, or uninstalled since) — that
   * font too, marked, so the choice is visible rather than silently lost.
   */
  private fillFamilies(current: string): void {
    const options: { value: string; label: string }[] = [{ value: DEFAULT_FAMILY, label: 'Editor default' }];
    for (const family of this.installed) {
      options.push({ value: family, label: family });
    }
    if (current !== DEFAULT_FAMILY && !this.installed.includes(current)) {
      options.push({ value: current, label: `${current} (not installed here)` });
    }
    const existing = Array.from(this.family.options).map((o) => o.value);
    if (existing.length === options.length && existing.every((v, i) => v === options[i].value)) {
      return;
    }
    this.family.innerHTML = '';
    for (const { value, label } of options) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      this.family.appendChild(option);
    }
  }
}
