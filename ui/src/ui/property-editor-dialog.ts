import {
  addProperty,
  getPropertyUsage,
  getScopeVariables,
  removeProperty,
  updateProperty,
  type PropertySpec,
  type PropertyTarget,
  type PropertyUsage,
} from '../api';
import type { SourceLocation, UIPropertyDefinition } from '../types';
import { ActivePartTracker, type PartChoice } from '../interactive/active-part-tracker';
import { describeDeletionPlan, type DeletionWording } from './declaration-usage';
import { ExpressionField } from './expression-field';
import { ICON_CLOSE, ICON_TRASH } from './icons';
import { identifierFromLabel } from './label-identifier';
import type { PartChoices } from './param-editor-dialog';

const NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The parameters panel's add / edit / delete dialog for `property()`
 * declarations — the values a part publishes. The label is what the panel
 * shows; the name the code reads the property by is derived from it and
 * shown read-only, so renaming the label renames the property (and, through
 * the server, every read of it). A property's value is an EXPRESSION over
 * the part's parameters (`width - 2 * wall`), so the value field is the 3D
 * dialogs' expression field with the chosen part's variables on offer; each
 * commit is a source edit the server applies through the editor host, and
 * the resulting re-render feeds the panel.
 *
 * Nothing the user types is interpolated into markup: the shell is static
 * and every value goes through `.value` / `.textContent`.
 */
export class PropertyEditorDialog {
  private overlay: HTMLDivElement;
  private title: HTMLElement;
  private labelInput: HTMLInputElement;
  private nameInput: HTMLInputElement;
  private partRow: HTMLElement;
  private partSelect: HTMLSelectElement;
  private valueInput: HTMLInputElement;
  private valueField: ExpressionField;
  private message: HTMLElement;
  private editActions: HTMLElement;
  private deleteBtn: HTMLButtonElement;
  private saveBtn: HTMLButtonElement;
  private confirmRow: HTMLElement;
  private confirmText: HTMLElement;

  /** Null while adding; the declaration under edit otherwise. */
  private target: PropertyTarget | null = null;
  private usage: PropertyUsage | null = null;
  private busy = false;
  private partProvider: (() => PartChoices) | null = null;
  private partChoices: PartChoice[] = [];
  /** Identity of the last variables request — a stale answer must not land on a newer form. */
  private variablesRequest = 0;

  constructor(container: HTMLElement) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'fixed inset-0 z-[300] bg-black/50 flex items-center justify-center hidden';
    this.overlay.innerHTML = PropertyEditorDialog.shellHtml();
    container.appendChild(this.overlay);

    const ref = <T extends HTMLElement>(name: string): T =>
      this.overlay.querySelector<T>(`[data-ref="${name}"]`)!;

    this.title = ref('title');
    this.labelInput = ref('label');
    this.nameInput = ref('name');
    this.partRow = ref('part-row');
    this.partSelect = ref('part');
    this.valueInput = ref('value');
    this.message = ref('message');
    this.editActions = ref('edit-actions');
    this.deleteBtn = ref('delete');
    this.saveBtn = ref('save');
    this.confirmRow = ref('confirm-row');
    this.confirmText = ref('confirm-text');

    this.valueField = new ExpressionField(this.valueInput);
    this.valueField.onSubmit = () => void this.save();

    this.bindEvents();
  }

  /** Where the Part dropdown reads the scene's parts and the selected one from. */
  setPartProvider(provider: () => PartChoices): void {
    this.partProvider = provider;
  }

  /**
   * Open on a blank declaration. The Part dropdown opens on `preferredPart`
   * when the caller has one (the panel's own Part dropdown), else on the
   * timeline's selected part; the value field offers that part's variables.
   */
  openForCreate(preferredPart?: SourceLocation | null): void {
    this.target = null;
    this.usage = null;
    this.title.textContent = 'Add property';
    this.labelInput.value = '';
    this.nameInput.value = '';
    this.valueField.setValue('');
    this.populateParts(preferredPart);
    this.editActions.classList.add('hidden');
    this.show();
    this.labelInput.focus();
    void this.loadVariables();
  }

  /**
   * Open on an existing declaration. The value's source text comes from the
   * usage lookup (the render only carries the computed value), so the field
   * fills in a moment after the dialog opens.
   */
  openForEdit(def: UIPropertyDefinition): void {
    const target: PropertyTarget = {
      name: def.name,
      line: def.sourceLocation?.line,
      filePath: def.sourceLocation?.filePath,
    };
    this.target = target;
    this.usage = null;
    this.title.textContent = 'Edit property';
    // The name only follows the label once the user edits it: a declaration
    // whose name does not reduce from its label keeps that name until then.
    this.labelInput.value = def.label ?? def.name;
    this.nameInput.value = def.name;
    // Until the source text arrives the field shows what the render computed.
    this.valueField.setValue(PropertyEditorDialog.valueText(def.value));
    // A declaration stays in the part it was written in.
    this.partRow.classList.add('hidden');
    this.partRow.classList.remove('flex');
    this.editActions.classList.remove('hidden');
    this.show();
    this.labelInput.focus();
    this.labelInput.select();
    void this.loadUsage(target);
    void this.loadVariables(def.sourceLocation?.line ?? null);
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
    return `
      <div class="w-[420px] max-h-[85vh] overflow-y-auto bg-base-100 border border-base-content/10 rounded-lg p-5 shadow-[0_4px_24px_rgba(0,0,0,0.5)]">
        <div class="flex items-center justify-between mb-4">
          <h3 data-ref="title" class="text-sm font-medium text-base-content/90">Property</h3>
          <button data-ref="close" class="btn btn-ghost btn-square btn-xs text-base-content/60">
            <span class="[&>svg]:size-4">${ICON_CLOSE}</span>
          </button>
        </div>

        <div class="flex flex-col gap-3">
          ${field('Label', '<input data-ref="label" type="text" class="input input-sm input-bordered w-full" placeholder="Internal width" />')}

          ${field('Name', '<input data-ref="name" type="text" readonly class="input input-sm input-bordered w-full font-mono text-base-content/70" placeholder="internalWidth" spellcheck="false" />')}
          <span class="text-[11px] text-base-content/50 -mt-2">What the code reads as <code>properties.name</code>, from the label.</span>

          <div data-ref="part-row" class="hidden flex-col gap-1">
            ${field('Part', '<select data-ref="part" class="select select-sm select-bordered w-full"></select>')}
          </div>

          ${field('Value', '<input data-ref="value" type="text" class="input input-sm input-bordered w-full" placeholder="width - 2 * wall" />')}
          <span class="text-[11px] text-base-content/50 -mt-2">An expression over the part’s parameters. Type a name to see what is in scope.</span>
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
            <button data-ref="delete" class="btn btn-ghost btn-sm text-error/80" title="Delete property">
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

  /** How a computed value reads back as an expression when the source text is unknown. */
  private static valueText(value: UIPropertyDefinition['value']): string {
    if (typeof value === 'string') {
      return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    }
    if (Array.isArray(value)) {
      return `[${value.map((v) => PropertyEditorDialog.valueText(v)).join(', ')}]`;
    }
    return String(value);
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
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement) && e.target !== this.valueInput) {
        // The value field owns its own Enter (suggestion fill vs submit).
        e.preventDefault();
        void this.save();
      }
    });
    // Another part, another set of variables to offer.
    this.partSelect.addEventListener('change', () => void this.loadVariables());
    // The name follows the label as it is typed.
    this.labelInput.addEventListener('input', () => {
      this.nameInput.value = identifierFromLabel(this.labelInput.value.trim());
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

  /** Fill the Part dropdown from the provider and open it on the preferred part. */
  private populateParts(preferredPart?: SourceLocation | null): void {
    const choices = this.partProvider?.() ?? { parts: [], selected: null };
    this.partChoices = choices.parts;
    this.partSelect.replaceChildren();
    this.partRow.classList.toggle('hidden', choices.parts.length === 0);
    this.partRow.classList.toggle('flex', choices.parts.length > 0);
    if (choices.parts.length === 0) {
      return;
    }
    ActivePartTracker.choiceLabels(choices.parts).forEach((text, index) => {
      this.partSelect.appendChild(PropertyEditorDialog.option(String(index), text));
    });
    const wanted = preferredPart ?? choices.selected;
    const index = wanted === null
      ? -1
      : choices.parts.findIndex((part) => ActivePartTracker.sameStatement(part.sourceLocation, wanted));
    this.partSelect.value = String(Math.max(index, 0));
  }

  /** The part the dropdown names — null only when the scene has none to name. */
  private chosenPart(): SourceLocation | null {
    if (this.partRow.classList.contains('hidden')) {
      return null;
    }
    return this.partChoices[Number(this.partSelect.value)]?.sourceLocation ?? null;
  }

  /**
   * Offer the variables the value may read: everything in scope at the
   * declaration's own line while editing, else the chosen part's body (its
   * `param()`s included, never another part's).
   */
  private async loadVariables(line: number | null = null): Promise<void> {
    const request = ++this.variablesRequest;
    const part = line === null ? this.chosenPart() : null;
    const variables = await getScopeVariables(line, undefined, part);
    if (request !== this.variablesRequest) {
      return;
    }
    this.valueField.setVariables(variables);
  }

  /** Everything the form describes, or the first reason it describes nothing. */
  private readSpec(): PropertySpec | { error: string } {
    const label = this.labelInput.value.trim();
    if (label === '') {
      return { error: 'Give the property a label.' };
    }
    const name = this.nameInput.value.trim();
    if (!NAME_RE.test(name)) {
      return { error: 'The label gives no usable name — start it with a letter.' };
    }
    const expression = this.valueInput.value.trim();
    if (expression === '') {
      return { error: 'Give the property a value.' };
    }
    return { label, name, expression };
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
      const part = this.chosenPart();
      if (!part) {
        this.setMessage('A property lives inside a part — add a part first.');
        return;
      }
      await this.commit(() => addProperty(spec, part));
      return;
    }
    await this.commit(() => updateProperty(target, spec));
  }

  /**
   * Ask before deleting — or refuse: a read the value cannot replace (one
   * in another part, of a value over this part's own parameters) would
   * leave the model unbuildable, so the server's plan turns the
   * confirmation into an error naming the reads to rewrite first.
   */
  private askToDelete(): void {
    if (!this.target) {
      return;
    }
    this.setMessage(null);
    const wording = PropertyEditorDialog.deletionWording(this.target.name, this.usage);
    if (wording.blocked) {
      this.confirmRow.classList.add('hidden');
      this.setMessage(wording.text);
      return;
    }
    this.confirmText.textContent = wording.text;
    this.confirmRow.classList.remove('hidden');
  }

  /**
   * The delete prompt: from the server's plan when it sent one, else (an
   * older server) the warning that the reads stay behind and break.
   */
  private static deletionWording(name: string, usage: PropertyUsage | null): DeletionWording {
    if (usage?.deletion) {
      return describeDeletionPlan('property', name, usage.deletion);
    }
    const consumers = `Assemblies reading instance.properties.${name} will fail on their next render.`;
    if (usage?.variable && usage.references > 0) {
      const where = usage.referenceLines.length > 0 ? ` (line ${usage.referenceLines.join(', ')})` : '';
      return {
        blocked: false,
        text: `Delete "${name}"? Its variable ${usage.variable} is read ${usage.references} time${usage.references === 1 ? '' : 's'}${where} — those references stay behind. ${consumers}`,
      };
    }
    return { blocked: false, text: `Delete "${name}"? ${consumers}` };
  }

  private async confirmDelete(): Promise<void> {
    const target = this.target;
    if (!target || this.busy) {
      return;
    }
    await this.commit(() => removeProperty(target));
  }

  /** Run one source edit: a success closes, a refusal stays open with the server's reason. */
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
   * Fetch the declaration's source: the value's exact text seeds the field
   * (the render only carries the computed number), and a call the editor
   * cannot rewrite says so up front.
   */
  private async loadUsage(target: PropertyTarget): Promise<void> {
    const usage = await getPropertyUsage(target);
    if (this.target !== target) {
      return;
    }
    this.usage = usage;
    if (usage?.expression !== null && usage?.expression !== undefined) {
      this.valueField.setValue(usage.expression);
    }
    if (usage?.label) {
      this.labelInput.value = usage.label;
    }
    if (usage && !usage.editable) {
      this.setMessage(usage.reason ?? 'This property has to be edited in the code.');
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
