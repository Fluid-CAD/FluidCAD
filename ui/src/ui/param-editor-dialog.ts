import {
  addParam,
  getParamUsage,
  removeParam,
  updateParam,
  type ParamSelectOption,
  type ParamSpec,
  type ParamTarget,
  type ParamType,
  type ParamUsage,
} from '../api';
import type { UIParamDefinition } from '../types';
import { ICON_CLOSE, ICON_TRASH } from './icons';
import {
  MULTI_CONTROL_CHOICES,
  PARAM_TYPE_CHOICES,
  coerceDefaultValue,
  describeDeletion,
  specFromDefinition,
} from './param-spec';

/**
 * The parameters panel's add / edit / delete dialog. Values the panel sets are
 * runtime overrides; everything this dialog changes is the `param()` call
 * itself, so each commit is a source edit the server applies through the
 * editor host and the resulting re-render feeds back into the panel.
 *
 * Nothing the user types is ever interpolated into markup: the shell is static
 * and every value is assigned through `.value` / `.textContent`, so a label
 * with a quote in it is just a label.
 */
export class ParamEditorDialog {
  private overlay: HTMLDivElement;
  private title: HTMLElement;
  private labelInput: HTMLInputElement;
  private bindingNote: HTMLElement;
  private typeSelect: HTMLSelectElement;
  private defaultRow: HTMLElement;
  private rangeRow: HTMLElement;
  private minInput: HTMLInputElement;
  private maxInput: HTMLInputElement;
  private stepInput: HTMLInputElement;
  private optionsSection: HTMLElement;
  private optionsList: HTMLElement;
  private multiToggle: HTMLInputElement;
  private multiControlRow: HTMLElement;
  private multiControlSelect: HTMLSelectElement;
  private optionalToggle: HTMLInputElement;
  private groupInput: HTMLInputElement;
  private descriptionInput: HTMLInputElement;
  private message: HTMLElement;
  private editActions: HTMLElement;
  private deleteBtn: HTMLButtonElement;
  private saveBtn: HTMLButtonElement;
  private confirmRow: HTMLElement;
  private confirmText: HTMLElement;

  /** Null while adding; the declaration under edit otherwise. */
  private target: ParamTarget | null = null;
  private usage: ParamUsage | null = null;
  private busy = false;

  constructor(container: HTMLElement) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'fixed inset-0 z-[300] bg-black/50 flex items-center justify-center hidden';
    this.overlay.innerHTML = ParamEditorDialog.shellHtml();
    container.appendChild(this.overlay);

    const ref = <T extends HTMLElement>(name: string): T =>
      this.overlay.querySelector<T>(`[data-ref="${name}"]`)!;

    this.title = ref('title');
    this.labelInput = ref('label');
    this.bindingNote = ref('binding-note');
    this.typeSelect = ref('type');
    this.defaultRow = ref('default-row');
    this.rangeRow = ref('range-row');
    this.minInput = ref('min');
    this.maxInput = ref('max');
    this.stepInput = ref('step');
    this.optionsSection = ref('options-section');
    this.optionsList = ref('options-list');
    this.multiToggle = ref('multi');
    this.multiControlRow = ref('multi-control-row');
    this.multiControlSelect = ref('multi-control');
    this.optionalToggle = ref('optional-toggle');
    this.groupInput = ref('group');
    this.descriptionInput = ref('description');
    this.message = ref('message');
    this.editActions = ref('edit-actions');
    this.deleteBtn = ref('delete');
    this.saveBtn = ref('save');
    this.confirmRow = ref('confirm-row');
    this.confirmText = ref('confirm-text');

    for (const { type, label } of PARAM_TYPE_CHOICES) {
      this.typeSelect.appendChild(ParamEditorDialog.option(type, label));
    }
    for (const { type, label } of MULTI_CONTROL_CHOICES) {
      this.multiControlSelect.appendChild(ParamEditorDialog.option(type, label));
    }

    this.bindEvents();
  }

  /** Open on a blank declaration. */
  openForCreate(): void {
    this.target = null;
    this.usage = null;
    this.title.textContent = 'Add parameter';
    this.seed({ label: '', defaultValue: 0, type: 'number' });
    this.bindingNote.classList.add('hidden');
    this.editActions.classList.add('hidden');
    this.show();
    this.labelInput.focus();
  }

  /**
   * Open on an existing declaration. The usage lookup runs alongside — it only
   * gates the delete warning and the "this one has to be edited in code"
   * notice, neither of which blocks the form from being filled in.
   */
  openForEdit(def: UIParamDefinition): void {
    this.target = {
      label: def.label,
      line: def.sourceLocation?.line,
      filePath: def.sourceLocation?.filePath,
    };
    this.usage = null;
    this.title.textContent = 'Edit parameter';
    this.seed(specFromDefinition(def));
    this.bindingNote.classList.add('hidden');
    this.editActions.classList.remove('hidden');
    this.show();
    this.labelInput.focus();
    this.labelInput.select();
    void this.loadUsage(this.target);
  }

  hide(): void {
    this.overlay.classList.add('hidden');
  }

  // ---------------------------------------------------------------------------
  // Markup
  // ---------------------------------------------------------------------------

  private static shellHtml(): string {
    const field = (label: string, control: string) => `
      <label class="flex flex-col gap-1">
        <span class="text-xs text-base-content/60">${label}</span>
        ${control}
      </label>
    `;
    const numberCell = (ref: string, label: string) => `
      <label class="flex-1 flex flex-col gap-1">
        <span class="text-xs text-base-content/60">${label}</span>
        <input data-ref="${ref}" type="number" class="input input-sm input-bordered w-full" />
      </label>
    `;
    return `
      <div class="w-[420px] max-h-[85vh] overflow-y-auto bg-base-100 border border-base-content/10 rounded-lg p-5 shadow-[0_4px_24px_rgba(0,0,0,0.5)]">
        <div class="flex items-center justify-between mb-4">
          <h3 data-ref="title" class="text-sm font-medium text-base-content/90">Parameter</h3>
          <button data-ref="close" class="btn btn-ghost btn-square btn-xs text-base-content/60">
            <span class="[&>svg]:size-4">${ICON_CLOSE}</span>
          </button>
        </div>

        <div class="flex flex-col gap-3">
          ${field('Label', '<input data-ref="label" type="text" class="input input-sm input-bordered w-full" placeholder="Wall thickness" />')}

          <span data-ref="binding-note" class="hidden text-[11px] text-base-content/40 -mt-1"></span>

          ${field('Type', '<select data-ref="type" class="select select-sm select-bordered w-full"></select>')}

          <div data-ref="default-row" class="flex flex-col gap-1">
            <span class="text-xs text-base-content/60">Default value</span>
          </div>

          <div data-ref="range-row" class="flex gap-2">
            ${numberCell('min', 'Min')}
            ${numberCell('max', 'Max')}
            ${numberCell('step', 'Step')}
          </div>

          <div data-ref="options-section" class="flex flex-col gap-2">
            <span class="text-xs text-base-content/60">Options</span>
            <div data-ref="options-list" class="flex flex-col gap-1.5"></div>
            <button data-ref="add-option" class="btn btn-ghost btn-xs self-start text-base-content/60">+ Add option</button>
            <label class="flex items-center justify-between cursor-pointer">
              <span class="text-xs text-base-content/70">Allow multiple</span>
              <input data-ref="multi" type="checkbox" class="toggle toggle-sm toggle-primary" />
            </label>
            <div data-ref="multi-control-row">
              ${field('Shown as', '<select data-ref="multi-control" class="select select-sm select-bordered w-full"></select>')}
            </div>
          </div>

          <div class="collapse collapse-arrow !min-h-0 border border-base-content/10 rounded-md">
            <input data-ref="optional-toggle" type="checkbox" class="!min-h-0 !p-0 !h-8" />
            <div class="collapse-title !min-h-0 !py-2 !px-3 !pr-8 text-xs text-base-content/60">Optional settings</div>
            <div class="collapse-content px-0 pb-0">
              <div class="flex flex-col gap-3 px-3 pb-3">
                ${field('Group', '<input data-ref="group" type="text" class="input input-sm input-bordered w-full" placeholder="Ungrouped" />')}
                ${field('Description', '<input data-ref="description" type="text" class="input input-sm input-bordered w-full" placeholder="Shown under the control" />')}
              </div>
            </div>
          </div>
        </div>

        <div data-ref="message" class="hidden mt-3 bg-error text-error-content rounded-md px-3 py-2 text-xs leading-snug"></div>

        <div data-ref="confirm-row" class="hidden mt-4 flex flex-col gap-2 border border-warning/40 bg-warning/10 rounded-md px-3 py-2.5">
          <span data-ref="confirm-text" class="text-xs leading-snug text-base-content/80"></span>
          <div class="flex justify-end gap-2">
            <button data-ref="confirm-cancel" class="btn btn-ghost btn-xs">Cancel</button>
            <button data-ref="confirm-delete" class="btn btn-error btn-xs">Delete anyway</button>
          </div>
        </div>

        <div class="flex items-center justify-between mt-5">
          <div data-ref="edit-actions">
            <button data-ref="delete" class="btn btn-ghost btn-sm text-error/80" title="Delete parameter">
              <span class="[&>svg]:size-4">${ICON_TRASH}</span>
            </button>
          </div>
          <div class="flex gap-2">
            <button data-ref="cancel" class="btn btn-ghost btn-sm">Cancel</button>
            <button data-ref="save" class="btn btn-primary btn-sm">Save</button>
          </div>
        </div>
      </div>
    `;
  }

  private static option(value: string, label: string): HTMLOptionElement {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  private bindEvents(): void {
    const close = () => this.hide();
    this.overlay.querySelector('[data-ref="close"]')!.addEventListener('click', close);
    this.overlay.querySelector('[data-ref="cancel"]')!.addEventListener('click', close);
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) {
        close();
      }
    });
    this.overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        void this.save();
      }
    });

    // A type change re-renders the default control and carries the old value
    // over when the new control can hold it.
    this.typeSelect.addEventListener('change', () => {
      const type = this.typeSelect.value as ParamType;
      const carried = coerceDefaultValue(
        type, this.readDefaultValue(), this.readOptions(), this.multiToggle.checked,
      );
      this.syncTypeSections(type);
      this.renderDefaultControl(type, carried);
    });

    this.overlay.querySelector('[data-ref="add-option"]')!.addEventListener('click', () => {
      this.appendOptionRow({ label: '', value: '' });
      this.refreshSelectDefault();
    });
    this.optionsList.addEventListener('input', () => this.refreshSelectDefault());
    this.multiToggle.addEventListener('change', () => {
      this.multiControlRow.classList.toggle('hidden', !this.multiToggle.checked);
      this.refreshSelectDefault();
    });

    this.deleteBtn.addEventListener('click', () => this.askToDelete());
    this.overlay.querySelector('[data-ref="confirm-cancel"]')!.addEventListener('click', () => {
      this.confirmRow.classList.add('hidden');
    });
    this.overlay.querySelector('[data-ref="confirm-delete"]')!.addEventListener('click', () => {
      void this.confirmDelete();
    });
    this.saveBtn.addEventListener('click', () => void this.save());
  }

  // ---------------------------------------------------------------------------
  // Form state
  // ---------------------------------------------------------------------------

  private show(): void {
    this.setMessage(null);
    this.confirmRow.classList.add('hidden');
    this.setBusy(false);
    this.overlay.classList.remove('hidden');
  }

  private seed(spec: ParamSpec): void {
    this.labelInput.value = spec.label;
    this.typeSelect.value = spec.type;
    this.minInput.value = spec.min != null ? String(spec.min) : '';
    this.maxInput.value = spec.max != null ? String(spec.max) : '';
    this.stepInput.value = spec.step != null ? String(spec.step) : '';
    this.groupInput.value = spec.group ?? '';
    this.descriptionInput.value = spec.description ?? '';
    // Folded away by default, but never folded over something already set —
    // a description the user cannot see is one they cannot tell is there.
    this.optionalToggle.checked = Boolean(spec.group || spec.description);
    this.multiToggle.checked = spec.multi === true;
    this.multiControlSelect.value = spec.multiControlType ?? 'select';

    this.optionsList.replaceChildren();
    for (const option of spec.options ?? []) {
      this.appendOptionRow(option);
    }
    if (spec.type === 'select' && (spec.options ?? []).length === 0) {
      this.appendOptionRow({ label: '', value: '' });
    }

    this.syncTypeSections(spec.type);
    this.renderDefaultControl(spec.type, spec.defaultValue);
  }

  /**
   * Show only the sections the chosen control actually uses. A slider is the
   * one that has to have a range to be usable at all, so it is the only one
   * that shows the fields — a number's bounds, when the code declares them,
   * are carried through untouched rather than dropped for being off-screen.
   */
  private syncTypeSections(type: ParamType): void {
    this.rangeRow.classList.toggle('hidden', type !== 'slider');
    this.rangeRow.classList.toggle('flex', type === 'slider');
    this.optionsSection.classList.toggle('hidden', type !== 'select');
    this.optionsSection.classList.toggle('flex', type === 'select');
    this.multiControlRow.classList.toggle('hidden', !this.multiToggle.checked);
  }

  /**
   * Redraw the default-value control for the chosen type. Each control writes
   * its value the way `readDefaultValue` reads it back, so the two stay a pair.
   */
  private renderDefaultControl(type: ParamType, value: ParamSpec['defaultValue']): void {
    const previous = this.defaultRow.querySelector('[data-ref="default"]');
    previous?.remove();

    let control: HTMLElement;
    if (type === 'checkbox') {
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.className = 'toggle toggle-sm toggle-primary self-start';
      toggle.checked = value === true;
      control = toggle;
    } else if (type === 'select') {
      const options = this.readOptions();
      const select = document.createElement('select');
      select.className = 'select select-sm select-bordered w-full';
      select.multiple = this.multiToggle.checked;
      if (select.multiple) {
        select.size = Math.min(Math.max(options.length, 2), 5);
      }
      const chosen = new Set((Array.isArray(value) ? value : [value]).map(String));
      for (const option of options) {
        const el = ParamEditorDialog.option(String(option.value), option.label || String(option.value));
        el.selected = chosen.has(String(option.value));
        select.appendChild(el);
      }
      control = select;
    } else {
      const input = document.createElement('input');
      input.className = type === 'color'
        ? 'w-full h-8 cursor-pointer bg-transparent border border-base-content/20 rounded'
        : 'input input-sm input-bordered w-full';
      input.type = type === 'number' || type === 'slider' ? 'number' : type === 'color' ? 'color' : 'text';
      input.value = String(coerceDefaultValue(type, value));
      control = input;
    }
    control.setAttribute('data-ref', 'default');
    this.defaultRow.appendChild(control);
  }

  /**
   * Keep the select's default in step with the options being typed: an option
   * renamed or removed under it would otherwise leave a default the server
   * refuses as "not one of the options".
   */
  private refreshSelectDefault(): void {
    if (this.typeSelect.value !== 'select') {
      return;
    }
    const options = this.readOptions();
    const multi = this.multiToggle.checked;
    this.renderDefaultControl('select', coerceDefaultValue('select', this.readDefaultValue(), options, multi));
  }

  private appendOptionRow(option: ParamSelectOption): void {
    const row = document.createElement('div');
    row.className = 'flex items-center gap-1.5';
    row.innerHTML = `
      <input data-ref="option-label" type="text" placeholder="Label" class="input input-xs input-bordered flex-1" />
      <input data-ref="option-value" type="text" placeholder="value" class="input input-xs input-bordered flex-1 font-mono" />
      <button data-ref="option-remove" class="btn btn-ghost btn-xs btn-square text-base-content/40" title="Remove option">
        <span class="[&>svg]:size-3.5">${ICON_CLOSE}</span>
      </button>
    `;
    row.querySelector<HTMLInputElement>('[data-ref="option-label"]')!.value = option.label;
    row.querySelector<HTMLInputElement>('[data-ref="option-value"]')!.value = String(option.value);
    row.querySelector('[data-ref="option-remove"]')!.addEventListener('click', () => {
      row.remove();
      this.refreshSelectDefault();
    });
    this.optionsList.appendChild(row);
  }

  private readOptions(): ParamSelectOption[] {
    const options: ParamSelectOption[] = [];
    for (const row of this.optionsList.children) {
      const label = row.querySelector<HTMLInputElement>('[data-ref="option-label"]')!.value.trim();
      const raw = row.querySelector<HTMLInputElement>('[data-ref="option-value"]')!.value.trim();
      if (label === '' && raw === '') {
        continue;
      }
      // A value that reads as a number is written as one, so the model can do
      // arithmetic with it; anything else stays text.
      const numeric = Number(raw);
      const value = raw !== '' && Number.isFinite(numeric) ? numeric : raw;
      options.push({ label: label === '' ? String(value) : label, value });
    }
    return options;
  }

  private readDefaultValue(): ParamSpec['defaultValue'] {
    const control = this.defaultRow.querySelector<HTMLElement>('[data-ref="default"]');
    if (!control) {
      return '';
    }
    if (control instanceof HTMLSelectElement) {
      const selected = Array.from(control.selectedOptions, (o) => o.value);
      const options = this.readOptions();
      const typed = selected.map((v) => options.find((o) => String(o.value) === v)?.value ?? v);
      return control.multiple ? typed : typed[0] ?? '';
    }
    const input = control as HTMLInputElement;
    if (input.type === 'checkbox') {
      return input.checked;
    }
    if (input.type === 'number') {
      return input.value.trim() === '' ? 0 : Number(input.value);
    }
    return input.value;
  }

  /** Everything the form describes, or the first reason it describes nothing. */
  private readSpec(): ParamSpec | { error: string } {
    const label = this.labelInput.value.trim();
    if (label === '') {
      return { error: 'Give the parameter a label.' };
    }
    const type = this.typeSelect.value as ParamType;
    const spec: ParamSpec = { label, defaultValue: this.readDefaultValue(), type };

    const group = this.groupInput.value.trim();
    if (group !== '') {
      spec.group = group;
    }
    const description = this.descriptionInput.value.trim();
    if (description !== '') {
      spec.description = description;
    }
    if (type === 'number' || type === 'slider') {
      const min = ParamEditorDialog.readNumber(this.minInput);
      const max = ParamEditorDialog.readNumber(this.maxInput);
      const step = ParamEditorDialog.readNumber(this.stepInput);
      if (min === null || max === null || step === null) {
        return { error: 'Min, max and step have to be numbers.' };
      }
      if (min !== undefined) {
        spec.min = min;
      }
      if (max !== undefined) {
        spec.max = max;
      }
      if (step !== undefined) {
        spec.step = step;
      }
    }
    if (type === 'select') {
      const options = this.readOptions();
      if (options.length === 0) {
        return { error: 'A select parameter needs at least one option.' };
      }
      spec.options = options;
      if (this.multiToggle.checked) {
        spec.multi = true;
        spec.multiControlType = this.multiControlSelect.value as ParamSpec['multiControlType'];
        spec.defaultValue = Array.isArray(spec.defaultValue) ? spec.defaultValue : [];
      }
    }
    return spec;
  }

  /** A finite number, `undefined` for a blank field, `null` for a bad one. */
  private static readNumber(input: HTMLInputElement): number | undefined | null {
    const raw = input.value.trim();
    if (raw === '') {
      return undefined;
    }
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  // ---------------------------------------------------------------------------
  // Commits
  // ---------------------------------------------------------------------------

  private async save(): Promise<void> {
    if (this.busy) {
      return;
    }
    const spec = this.readSpec();
    if ('error' in spec) {
      this.setMessage(spec.error);
      return;
    }
    const target = this.target;
    if (!target) {
      await this.commit(() => addParam(spec));
      return;
    }
    await this.commit(() => updateParam(target, spec));
  }

  private askToDelete(): void {
    if (!this.target) {
      return;
    }
    this.setMessage(null);
    this.confirmText.textContent = describeDeletion(this.target.label, this.usage);
    this.confirmRow.classList.remove('hidden');
  }

  private async confirmDelete(): Promise<void> {
    const target = this.target;
    if (!target || this.busy) {
      return;
    }
    await this.commit(() => removeParam(target));
  }

  /**
   * Run one source edit. The panel redraws off the render the edit triggers,
   * so a success just closes; a refusal stays open with the server's reason —
   * it is the authority on what the file allows.
   */
  private async commit(run: () => Promise<{ success: boolean; reason?: string }>): Promise<void> {
    this.setBusy(true);
    try {
      const result = await run();
      if (result.success) {
        this.hide();
      } else {
        this.confirmRow.classList.add('hidden');
        this.setMessage(result.reason ?? 'The edit could not be applied.');
      }
    } finally {
      this.setBusy(false);
    }
  }

  /**
   * Fetch what the declaration binds. A declaration the editor cannot rewrite
   * (a chained call, a label the file spells twice) says so up front instead
   * of letting the user fill the form in and be refused on save.
   */
  private async loadUsage(target: ParamTarget): Promise<void> {
    const usage = await getParamUsage(target);
    if (this.target !== target) {
      return;
    }
    this.usage = usage;
    if (usage && !usage.editable) {
      this.setMessage(usage.reason ?? 'This parameter has to be edited in the code.');
    }
    // Naming the variable is what makes "the label is not the variable" plain
    // before the user renames anything.
    if (usage?.variable) {
      this.bindingNote.textContent =
        `Bound to ${usage.variable} — renaming the label leaves the code alone.`;
      this.bindingNote.classList.remove('hidden');
    }
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.saveBtn.disabled = busy;
    this.deleteBtn.disabled = busy;
  }

  private setMessage(text: string | null): void {
    this.message.textContent = text ?? '';
    this.message.classList.toggle('hidden', !text);
  }
}
