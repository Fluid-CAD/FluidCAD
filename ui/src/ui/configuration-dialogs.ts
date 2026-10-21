/**
 * The small dialogs the Parameters panel's configuration band asks through
 * (`docs/assembly-configurations-plan.md` §3.4): a row name for Add / Save
 * as… / Rename…, the Save / Discard / Cancel choice before a switch would
 * drop the session's tweaks, and the confirm before a row is deleted.
 *
 * Same chrome as the parameter editor (`param-editor-dialog.ts`): a dimmed
 * full-window overlay, a bordered card with a title and ✕, the error box
 * under the field, ghost Cancel beside the primary action. Everything the
 * user typed is assigned through `.value` / `.textContent`, never markup.
 */

import { ICON_CLOSE } from './icons';

/** The reserved row: the `param()` literals — never a name a row can take. */
const DEFAULT_CONFIGURATION = 'Default';

const OVERLAY_CLASS = 'fixed inset-0 z-[300] bg-black/50 flex items-center justify-center';
const CARD_CLASS = 'w-[340px] max-w-[92vw] bg-base-100 border border-base-content/10 rounded-lg p-5 '
  + 'shadow-[0_4px_24px_rgba(0,0,0,0.5)]';

export type ConfigurationNamePrompt = {
  title: string;
  /** The primary button's label — Add, Save, Rename. */
  confirmLabel: string;
  /** The field's starting text, selected so typing replaces it. */
  initial?: string;
  /** Row names already in the table — a new name may not repeat one. */
  taken: string[];
  /**
   * Commit the name. Resolves null when it landed — the dialog closes — or
   * the refusal's text, which the dialog shows and stays open on.
   */
  submit(name: string): Promise<string | null>;
};

/** What a switch away from a modified row does with the tweaks. */
export type ConfigurationSwitchChoice = 'save' | 'discard' | 'cancel';

/**
 * Why `name` cannot be a row name, or null when it can. `current` is the
 * row being renamed — keeping its own name is not a clash.
 */
export function configurationNameProblem(name: string, taken: string[], current?: string): string | null {
  if (name === '') {
    return 'Enter a name.';
  }
  if (name === DEFAULT_CONFIGURATION) {
    return `${DEFAULT_CONFIGURATION} is reserved — it is the parameters' own values.`;
  }
  if (name !== current && taken.includes(name)) {
    return `A configuration named “${name}” already exists.`;
  }
  return null;
}

/**
 * Ask for a row name and commit it through `opts.submit`. Resolves once the
 * dialog closes — committed or cancelled. A refusal (the field's own check
 * or the server's) keeps it open with the reason under the field.
 */
export function promptConfigurationName(host: HTMLElement, opts: ConfigurationNamePrompt): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = OVERLAY_CLASS;
    overlay.dataset.configurationPrompt = '';
    overlay.innerHTML = `
      <div class="${CARD_CLASS}">
        <div class="flex items-center justify-between mb-4">
          <h3 data-ref="title" class="text-sm font-medium text-base-content/90"></h3>
          <button data-ref="close" class="btn btn-ghost btn-square btn-xs text-base-content/60" title="Close">
            <span class="[&>svg]:size-4">${ICON_CLOSE}</span>
          </button>
        </div>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-base-content/60">Name</span>
          <input data-ref="name" type="text" spellcheck="false" class="input input-sm input-bordered w-full" placeholder="Wide" />
        </label>
        <div data-ref="message" class="hidden mt-3 bg-error text-error-content rounded-md px-3 py-2 text-xs leading-snug"></div>
        <div class="flex items-center justify-end gap-2 mt-5">
          <button data-ref="cancel" class="btn btn-ghost btn-sm">Cancel</button>
          <button data-ref="ok" class="btn btn-primary btn-sm"></button>
        </div>
      </div>
    `;
    const ref = <T extends HTMLElement>(name: string): T => overlay.querySelector<T>(`[data-ref="${name}"]`)!;
    const input = ref<HTMLInputElement>('name');
    const message = ref<HTMLElement>('message');
    const ok = ref<HTMLButtonElement>('ok');
    ref('title').textContent = opts.title;
    ok.textContent = opts.confirmLabel;
    input.value = opts.initial ?? '';

    let busy = false;
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve();
    };
    const showMessage = (text: string) => {
      message.textContent = text;
      message.classList.remove('hidden');
    };
    const commit = async () => {
      if (busy) {
        return;
      }
      const name = input.value.trim();
      const problem = configurationNameProblem(name, opts.taken, opts.initial);
      if (problem) {
        showMessage(problem);
        input.focus();
        return;
      }
      if (name === opts.initial) {
        finish(); // nothing to rename
        return;
      }
      busy = true;
      ok.disabled = true;
      message.classList.add('hidden');
      const refused = await opts.submit(name);
      busy = false;
      ok.disabled = false;
      if (refused !== null) {
        showMessage(refused);
        return;
      }
      finish();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        finish();
      } else if (e.key === 'Enter' && e.target === input) {
        e.preventDefault();
        e.stopPropagation();
        void commit();
      }
    };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) {
        finish();
      }
    });
    input.addEventListener('input', () => message.classList.add('hidden'));
    ref('close').addEventListener('click', finish);
    ref('cancel').addEventListener('click', finish);
    ok.addEventListener('click', () => void commit());
    host.appendChild(overlay);
    input.focus();
    input.select();
  });
}

/**
 * Before a switch away from `active` drops its tweaks: Save them into the
 * row first, Discard them, or Cancel the switch. Without `canSave` (Default
 * has no row to save into) the choice is Discard or Cancel.
 */
export function chooseConfigurationSwitch(
  host: HTMLElement,
  opts: { active: string; target: string; canSave: boolean },
): Promise<ConfigurationSwitchChoice> {
  const message = opts.canSave
    ? `${opts.active} has unsaved changes. Save them into ${opts.active} before switching to ${opts.target}?`
    : `Discard the unsaved changes to ${opts.active} and switch to ${opts.target}?`;
  const buttons: ChoiceButton<ConfigurationSwitchChoice>[] = [
    { value: 'cancel', label: 'Cancel', className: 'btn-ghost' },
    { value: 'discard', label: 'Discard', className: opts.canSave ? 'btn-ghost text-error/80' : 'btn-error' },
  ];
  if (opts.canSave) {
    buttons.push({ value: 'save', label: 'Save', className: 'btn-primary' });
  }
  return choose(host, 'Switch configuration', message, buttons, 'cancel', opts.canSave ? 'save' : 'discard');
}

/** Before Delete removes the row `name` from the table. */
export async function confirmConfigurationDelete(host: HTMLElement, name: string): Promise<boolean> {
  const choice = await choose(
    host,
    'Delete configuration',
    `Delete the configuration “${name}”? Its row is removed from the configurations() table.`,
    [
      { value: 'cancel', label: 'Cancel', className: 'btn-ghost' },
      { value: 'delete', label: 'Delete', className: 'btn-error' },
    ],
    'cancel',
    'delete',
  );
  return choice === 'delete';
}

type ChoiceButton<T extends string> = { value: T; label: string; className: string };

/**
 * A message with a row of buttons; resolves with the one picked. Escape and
 * the backdrop pick `dismiss`, Enter picks `primary`.
 */
function choose<T extends string>(
  host: HTMLElement,
  title: string,
  text: string,
  buttons: ChoiceButton<T>[],
  dismiss: T,
  primary: T,
): Promise<T> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = OVERLAY_CLASS;
    overlay.dataset.configurationChoice = '';
    overlay.innerHTML = `
      <div class="${CARD_CLASS}">
        <h3 data-ref="title" class="text-sm font-medium text-base-content/90 mb-3"></h3>
        <p data-ref="text" class="text-xs text-base-content/70 leading-snug"></p>
        <div data-ref="buttons" class="flex items-center justify-end gap-2 mt-5"></div>
      </div>
    `;
    overlay.querySelector('[data-ref="title"]')!.textContent = title;
    overlay.querySelector('[data-ref="text"]')!.textContent = text;
    let settled = false;
    const finish = (value: T) => {
      if (settled) {
        return;
      }
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(value);
    };
    const row = overlay.querySelector('[data-ref="buttons"]')!;
    for (const button of buttons) {
      const el = document.createElement('button');
      el.className = `btn btn-sm ${button.className}`;
      el.dataset.choice = button.value;
      el.textContent = button.label;
      el.addEventListener('click', () => finish(button.value));
      row.appendChild(el);
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        finish(dismiss);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        finish(primary);
      }
    };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) {
        finish(dismiss);
      }
    });
    host.appendChild(overlay);
    row.querySelector<HTMLButtonElement>(`[data-choice="${primary}"]`)?.focus();
  });
}
