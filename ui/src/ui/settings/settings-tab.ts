import type { UserPreferences } from '../../api';

/** Persist one preference — what a tab's `save` is handed. */
export type PersistPreference = <K extends keyof UserPreferences>(key: K, value: UserPreferences[K]) => void;

/** What a tab can tell the dialog: a control changed, or everything should go back to defaults. */
export interface SettingsContext {
  /** A control was edited: the tab's dot shows and Save enables. */
  changed(): void;
  /** Reset everything on the server and re-apply the defaults to the page. Resolves false when the server refused. */
  resetAll(): Promise<boolean>;
}

/**
 * One page of the Settings dialog. A tab edits a draft; nothing reaches the
 * app or the preferences file until the dialog's Save, and Cancel drops the
 * draft by calling `sync` again.
 */
export interface SettingsTab {
  readonly id: string;
  readonly label: string;
  /** Build the controls into `root`, once. */
  mount(root: HTMLElement, ctx: SettingsContext): void;
  /** Drop the draft and re-read the stores into the controls — on open, on Cancel, after a reset. */
  sync(): void;
  /** Whether the draft differs from what is applied. */
  isDirty(): boolean;
  /** Apply the draft to the app and persist what changed. */
  save(persist: PersistPreference): void;
}

// Shared control chrome, so the five tabs read as one dialog.
export const FIELD = 'flex flex-col gap-1 mb-4';
export const FIELD_LABEL = 'text-xs text-base-content/70';
export const FIELD_HINT = 'text-[11px] text-base-content/50';
export const SELECT = 'select select-sm select-bordered w-full';
export const NUMBER_INPUT = 'input input-sm input-bordered w-28';
export const TOGGLE_ROW = 'flex items-center justify-between gap-3 mb-4 cursor-pointer';
export const TOGGLE = 'toggle toggle-sm toggle-primary';

/** A label above a control, with an optional one-line hint under it. */
export function field(label: string, control: HTMLElement, hint?: string): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = FIELD;
  const labelEl = document.createElement('label');
  labelEl.className = FIELD_LABEL;
  labelEl.textContent = label;
  wrap.appendChild(labelEl);
  wrap.appendChild(control);
  if (hint) {
    const hintEl = document.createElement('p');
    hintEl.className = FIELD_HINT;
    hintEl.textContent = hint;
    wrap.appendChild(hintEl);
  }
  return wrap;
}

/** A labelled toggle row; `onChange` gets the new checked state. */
export function toggleRow(label: string, onChange: (checked: boolean) => void): { row: HTMLLabelElement; input: HTMLInputElement } {
  const row = document.createElement('label');
  row.className = TOGGLE_ROW;
  const text = document.createElement('span');
  text.className = FIELD_LABEL;
  text.textContent = label;
  row.appendChild(text);
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = TOGGLE;
  input.addEventListener('change', () => onChange(input.checked));
  row.appendChild(input);
  return { row, input };
}

/**
 * A number input clamped to `[min, max]`. `onChange` gets the clamped integer
 * on every keystroke (so the draft follows typing) and the field itself is
 * rewritten to the clamped value when it commits.
 */
export function numberField(min: number, max: number, onChange: (value: number) => void): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.className = NUMBER_INPUT;
  input.min = String(min);
  input.max = String(max);
  input.step = '1';
  const clamped = (): number | null => {
    const raw = Number(input.value);
    return input.value.trim() === '' || !Number.isFinite(raw) ? null : Math.round(Math.min(max, Math.max(min, raw)));
  };
  input.addEventListener('input', () => {
    const value = clamped();
    if (value !== null) {
      onChange(value);
    }
  });
  const commit = (): void => {
    const value = clamped();
    if (value !== null) {
      input.value = String(value);
      onChange(value);
    }
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
      input.blur();
    }
  });
  return input;
}
