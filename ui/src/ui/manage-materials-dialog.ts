import type { EngineClient } from '../engine-client';
import { DENSITY_UNITS, type DensityUnit, type Material, type ProjectMaterial, type ProjectMaterials } from '../api';
import { ICON_CLOSE, ICON_PENCIL, ICON_TRASH } from './icons';

/**
 * The Manage materials… dialog: the project's own materials — the
 * `materials` map of `fluidcad.json`, the entries `part(...).material(id)`
 * can name beside the built-ins. Lists the project entries with their id,
 * density and unit; a small form adds one (the id auto-slugged from the
 * name until the user edits it) or updates the entry a pencil loaded; the
 * trash drops one. Nothing is written until Save, which posts the whole map
 * and hands the merged list back to whoever opened the dialog.
 *
 * Built-ins are not editable: they are named in a note, and an entry whose
 * id matches a built-in overrides that built-in for this project (the hint
 * under the id field says so). Every value goes through `.value` /
 * `.textContent` — nothing typed is interpolated into markup.
 */
export class ManageMaterialsDialog {
  private overlay: HTMLDivElement;
  private listEl: HTMLDivElement;
  private formTitle: HTMLElement;
  private nameInput: HTMLInputElement;
  private densityInput: HTMLInputElement;
  private unitSelect: HTMLSelectElement;
  private idInput: HTMLInputElement;
  private idHint: HTMLElement;
  private formMessage: HTMLElement;
  private commitBtn: HTMLButtonElement;
  private cancelEditBtn: HTMLButtonElement;
  private saveBtn: HTMLButtonElement;
  private status: HTMLElement;

  /** The project map as edited so far, in the file's order. */
  private draft: ProjectMaterials = {};
  private builtins = new Map<string, Material>();
  /** The id whose entry the form is editing, or null while adding. */
  private editingId: string | null = null;
  /** Once the user types in the id field, the name stops driving it. */
  private idTouched = false;
  private dirty = false;
  private busy = false;

  /** Called with the merged list the server answered after a successful save. */
  onSaved: ((materials: Material[]) => void) | null = null;

  constructor(container: HTMLElement, private client: EngineClient) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'fixed inset-0 z-[300] bg-black/50 flex items-center justify-center hidden';
    this.overlay.innerHTML = ManageMaterialsDialog.shellHtml();
    container.appendChild(this.overlay);

    const ref = <T extends HTMLElement>(name: string): T =>
      this.overlay.querySelector<T>(`[data-ref="${name}"]`)!;
    this.listEl = ref('list');
    this.formTitle = ref('form-title');
    this.nameInput = ref('name');
    this.densityInput = ref('density');
    this.unitSelect = ref('unit');
    this.idInput = ref('id');
    this.idHint = ref('id-hint');
    this.formMessage = ref('form-message');
    this.commitBtn = ref('commit');
    this.cancelEditBtn = ref('cancel-edit');
    this.saveBtn = ref('save');
    this.status = ref('status');

    this.bindEvents();
  }

  get isOpen(): boolean {
    return !this.overlay.classList.contains('hidden');
  }

  /** Open on the current merged list (a fresh read: another dialog may have written since). */
  open(): void {
    this.draft = {};
    this.builtins = new Map();
    this.dirty = false;
    this.setBusy(false);
    this.setStatus('');
    this.resetForm();
    this.renderList();
    this.overlay.classList.remove('hidden');
    void this.load();
  }

  hide(): void {
    this.overlay.classList.add('hidden');
  }

  private async load(): Promise<void> {
    const materials = await this.client.getMaterials();
    if (!materials || !this.isOpen) {
      return;
    }
    this.builtins = new Map(materials.filter((m) => m.source === 'builtin').map((m) => [m.id, m]));
    const draft: ProjectMaterials = {};
    for (const material of materials) {
      if (material.source === 'project') {
        draft[material.id] = ManageMaterialsDialog.entryOf(material);
      }
    }
    this.draft = draft;
    this.renderList();
    this.nameInput.focus();
  }

  // ---------------------------------------------------------------------------
  // Markup
  // ---------------------------------------------------------------------------

  private static shellHtml(): string {
    const field = (label: string, control: string) => `
      <label class="flex flex-col gap-1 min-w-0">
        <span class="text-xs text-base-content/60">${label}</span>
        ${control}
      </label>
    `;
    const units = DENSITY_UNITS.map((u) => `<option value="${u}">${u}</option>`).join('');
    return `
      <div class="w-[460px] max-w-[92vw] max-h-[85vh] bg-base-100 border border-base-content/10 rounded-lg p-5 shadow-[0_4px_24px_rgba(0,0,0,0.5)] flex flex-col">
        <div class="flex items-center justify-between mb-1">
          <h3 class="text-sm font-medium text-base-content/90">Manage materials</h3>
          <button data-ref="close" class="btn btn-ghost btn-square btn-xs text-base-content/60">
            <span class="[&>svg]:size-4">${ICON_CLOSE}</span>
          </button>
        </div>
        <div class="text-[11px] text-base-content/50 mb-3 leading-snug">
          Project materials live in <span class="font-mono">fluidcad.json</span>; a part refers to one with
          <span class="font-mono">.material('id')</span>. Built-in materials cannot be edited — give an entry a
          built-in's id to override it for this project.
        </div>

        <div data-ref="list" class="overflow-y-auto max-h-[32vh] border border-base-content/10 rounded-md mb-3"></div>

        <div class="border border-base-content/10 rounded-md px-3 py-2.5 flex flex-col gap-2.5">
          <span data-ref="form-title" class="text-xs font-medium text-base-content/80">Add material</span>
          ${field('Name', '<input data-ref="name" type="text" class="input input-sm input-bordered w-full" placeholder="Alloy Steel" spellcheck="false" />')}
          <div class="flex gap-2">
            <div class="flex-1 min-w-0">
              ${field('Density', '<input data-ref="density" type="number" min="0" step="any" class="input input-sm input-bordered w-full" placeholder="7.7" />')}
            </div>
            <div class="w-[110px]">
              ${field('Unit', `<select data-ref="unit" class="select select-sm select-bordered w-full">${units}</select>`)}
            </div>
          </div>
          ${field('Id', '<input data-ref="id" type="text" class="input input-sm input-bordered w-full font-mono" placeholder="alloy-steel" spellcheck="false" />')}
          <span data-ref="id-hint" class="text-[11px] text-base-content/50 -mt-1.5 min-h-4"></span>
          <div data-ref="form-message" class="hidden bg-error text-error-content rounded-md px-3 py-2 text-xs leading-snug"></div>
          <div class="flex justify-end gap-2">
            <button data-ref="cancel-edit" class="btn btn-ghost btn-xs hidden">Cancel edit</button>
            <button data-ref="commit" class="btn btn-soft btn-primary btn-xs">Add</button>
          </div>
        </div>

        <div data-ref="status" class="text-xs text-error min-h-4 mt-2"></div>
        <div class="flex items-center justify-end gap-2 pt-1">
          <button data-ref="cancel" class="btn btn-ghost btn-sm">Cancel</button>
          <button data-ref="save" class="btn btn-primary btn-sm" disabled>Save</button>
        </div>
      </div>
    `;
  }

  /** One list row: name, id, density — and the edit / remove buttons. */
  private buildRow(id: string, entry: ProjectMaterial): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'flex items-center gap-2 px-3 py-1.5 border-b border-base-content/[0.07] last:border-b-0';
    row.dataset.materialId = id;

    const text = document.createElement('div');
    text.className = 'flex-1 min-w-0';
    const name = document.createElement('div');
    name.className = 'text-xs font-medium text-base-content/90 truncate';
    name.textContent = entry.name;
    const meta = document.createElement('div');
    meta.className = 'text-[11px] text-base-content/50 truncate';
    const idSpan = document.createElement('span');
    idSpan.className = 'font-mono';
    idSpan.textContent = id;
    meta.appendChild(idSpan);
    meta.appendChild(document.createTextNode(` · ${entry.density} ${entry.densityUnit ?? 'g/cm³'}`));
    if (this.builtins.has(id)) {
      meta.appendChild(document.createTextNode(` · overrides built-in ${this.builtins.get(id)!.name}`));
    }
    text.appendChild(name);
    text.appendChild(meta);
    row.appendChild(text);

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'btn btn-ghost btn-square btn-xs text-base-content/60';
    edit.title = 'Edit';
    edit.dataset.action = 'edit';
    edit.innerHTML = `<span class="[&>svg]:size-3.5">${ICON_PENCIL}</span>`;
    edit.addEventListener('click', () => this.startEdit(id));
    row.appendChild(edit);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-ghost btn-square btn-xs text-error/80';
    remove.title = 'Remove';
    remove.dataset.action = 'remove';
    remove.innerHTML = `<span class="[&>svg]:size-3.5">${ICON_TRASH}</span>`;
    remove.addEventListener('click', () => this.removeEntry(id));
    row.appendChild(remove);
    return row;
  }

  private renderList(): void {
    this.listEl.innerHTML = '';
    const ids = Object.keys(this.draft);
    if (ids.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'text-[11px] text-base-content/40 text-center py-3';
      empty.dataset.ref = 'empty';
      empty.textContent = 'No project materials yet.';
      this.listEl.appendChild(empty);
      return;
    }
    for (const id of ids) {
      this.listEl.appendChild(this.buildRow(id, this.draft[id]));
    }
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
        this.commitForm();
      }
    });

    this.nameInput.addEventListener('input', () => {
      if (!this.idTouched) {
        this.idInput.value = ManageMaterialsDialog.slugOf(this.nameInput.value);
      }
      this.renderIdHint();
    });
    this.idInput.addEventListener('input', () => {
      this.idTouched = this.idInput.value !== '';
      this.renderIdHint();
    });
    this.commitBtn.addEventListener('click', () => this.commitForm());
    this.cancelEditBtn.addEventListener('click', () => this.resetForm());
    this.saveBtn.addEventListener('click', () => void this.save());
  }

  // ---------------------------------------------------------------------------
  // Form
  // ---------------------------------------------------------------------------

  private resetForm(): void {
    this.editingId = null;
    this.idTouched = false;
    this.nameInput.value = '';
    this.densityInput.value = '';
    this.unitSelect.value = 'g/cm³';
    this.idInput.value = '';
    this.formTitle.textContent = 'Add material';
    this.commitBtn.textContent = 'Add';
    this.cancelEditBtn.classList.add('hidden');
    this.setFormMessage(null);
    this.renderIdHint();
  }

  private startEdit(id: string): void {
    const entry = this.draft[id];
    if (!entry) {
      return;
    }
    this.editingId = id;
    // An existing id is the user's: the name no longer drives it.
    this.idTouched = true;
    this.nameInput.value = entry.name;
    this.densityInput.value = String(entry.density);
    this.unitSelect.value = entry.densityUnit ?? 'g/cm³';
    this.idInput.value = id;
    this.formTitle.textContent = 'Edit material';
    this.commitBtn.textContent = 'Update';
    this.cancelEditBtn.classList.remove('hidden');
    this.setFormMessage(null);
    this.renderIdHint();
    this.nameInput.focus();
    this.nameInput.select();
  }

  private renderIdHint(): void {
    const id = this.idInput.value.trim();
    const builtin = this.builtins.get(id);
    if (builtin) {
      this.idHint.textContent = `Overrides the built-in ${builtin.name} for this project.`;
    } else if (!this.idTouched) {
      this.idHint.textContent = 'Filled from the name; edit it to choose your own.';
    } else {
      this.idHint.textContent = '';
    }
  }

  /** Validate the form and put its entry into the draft (add, or replace the one under edit). */
  private commitForm(): void {
    const name = this.nameInput.value.trim();
    const density = Number(this.densityInput.value);
    const unit = this.unitSelect.value as DensityUnit;
    const id = this.idInput.value.trim();
    if (name === '') {
      this.setFormMessage('Name is required.');
      return;
    }
    if (this.densityInput.value.trim() === '' || !Number.isFinite(density) || density <= 0) {
      this.setFormMessage('Density must be a positive number.');
      return;
    }
    if (!DENSITY_UNITS.includes(unit)) {
      this.setFormMessage('Pick a density unit.');
      return;
    }
    if (id === '') {
      this.setFormMessage('Id is required.');
      return;
    }
    if (id !== this.editingId && Object.prototype.hasOwnProperty.call(this.draft, id)) {
      this.setFormMessage(`Id "${id}" is already used by "${this.draft[id].name}" in this project.`);
      return;
    }
    const entry: ProjectMaterial = { name, density, ...(unit === 'g/cm³' ? {} : { densityUnit: unit }) };
    this.draft = ManageMaterialsDialog.withEntry(this.draft, this.editingId, id, entry);
    this.markDirty();
    this.renderList();
    this.resetForm();
    this.nameInput.focus();
  }

  private removeEntry(id: string): void {
    if (!Object.prototype.hasOwnProperty.call(this.draft, id)) {
      return;
    }
    this.draft = Object.fromEntries(Object.entries(this.draft).filter(([key]) => key !== id));
    if (this.editingId === id) {
      this.resetForm();
    }
    this.markDirty();
    this.renderList();
  }

  private markDirty(): void {
    this.dirty = true;
    this.saveBtn.disabled = this.busy;
    this.setStatus('');
  }

  private setFormMessage(text: string | null): void {
    this.formMessage.textContent = text ?? '';
    this.formMessage.classList.toggle('hidden', text === null);
  }

  private setStatus(text: string): void {
    this.status.textContent = text;
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.saveBtn.disabled = busy || !this.dirty;
    this.commitBtn.disabled = busy;
  }

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------

  private async save(): Promise<void> {
    if (this.busy || !this.dirty) {
      return;
    }
    const editor = this.client.editor;
    if (!editor) {
      this.setStatus('This host cannot write fluidcad.json.');
      return;
    }
    this.setBusy(true);
    const result = await editor.saveProjectMaterials(this.draft);
    if (!this.isOpen) {
      return;
    }
    this.setBusy(false);
    if (result.success === false) {
      this.setStatus(result.reason || 'Saving failed.');
      return;
    }
    this.dirty = false;
    this.hide();
    this.onSaved?.(result.materials);
  }

  // ---------------------------------------------------------------------------
  // Pure helpers
  // ---------------------------------------------------------------------------

  /** `Alloy Steel (AISI 4140)` → `alloy-steel-aisi-4140`. */
  static slugOf(name: string): string {
    return name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /** The `fluidcad.json` entry a merged-list material stands for (g/cm³ stays implicit). */
  private static entryOf(material: Material): ProjectMaterial {
    const unit = DENSITY_UNITS.find((u) => u === material.densityUnit) ?? 'g/cm³';
    return { name: material.name, density: material.density, ...(unit === 'g/cm³' ? {} : { densityUnit: unit }) };
  }

  /**
   * The draft with `entry` at `id`: replacing `editingId`'s entry in place
   * (a renamed id keeps its position in the file), or appended when adding.
   */
  private static withEntry(
    draft: ProjectMaterials,
    editingId: string | null,
    id: string,
    entry: ProjectMaterial,
  ): ProjectMaterials {
    const next: ProjectMaterials = {};
    let placed = false;
    for (const [key, value] of Object.entries(draft)) {
      if (key === editingId) {
        next[id] = entry;
        placed = true;
      } else {
        next[key] = value;
      }
    }
    if (!placed) {
      next[id] = entry;
    }
    return next;
  }
}
