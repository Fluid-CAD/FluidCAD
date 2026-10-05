import { DENSITY_UNITS, type DensityUnit, type Material, type ProjectMaterial, type ProjectMaterials } from '../../api';
import { ICON_PENCIL, ICON_TRASH } from '../icons';
import { GlobalMaterialsStore, globalMaterials } from './global-materials';
import { FIELD_HINT, SELECT, type PersistPreference, type SettingsContext, type SettingsTab } from './settings-tab';

const INPUT = 'input input-sm input-bordered w-full';

/**
 * Settings → Materials: the user's own materials, kept on this machine in
 * the preferences file. The list shows each entry's name, id, density and
 * unit with edit and remove buttons; a small form adds one (the id slugged
 * from the name until the user edits it) or updates the entry a pencil
 * loaded. Like every tab it edits a draft: nothing reaches the store or the
 * file until the dialog's Save, and Cancel drops it.
 *
 * Built-ins are not listed — they cannot be edited — but an entry may reuse
 * a built-in's id: picked for a part, it overrides that built-in in the
 * project the pick copies it into. Every value goes through `.value` /
 * `.textContent`; nothing typed is interpolated into markup.
 */
export class MaterialsTab implements SettingsTab {
  readonly id = 'materials';
  readonly label = 'Materials';
  private ctx!: SettingsContext;
  private listEl!: HTMLDivElement;
  private formTitle!: HTMLElement;
  private nameInput!: HTMLInputElement;
  private densityInput!: HTMLInputElement;
  private unitSelect!: HTMLSelectElement;
  private idInput!: HTMLInputElement;
  private idHint!: HTMLElement;
  private formMessage!: HTMLElement;
  private commitBtn!: HTMLButtonElement;
  private cancelEditBtn!: HTMLButtonElement;

  private draft: ProjectMaterials = {};
  private builtins = new Map<string, Material>();
  private builtinsLoaded = false;
  /** The id whose entry the form is editing, or null while adding. */
  private editingId: string | null = null;
  /** Once the user types in the id field, the name stops driving it. */
  private idTouched = false;

  /** `loadMaterials` answers the merged list; only its built-ins are kept, for the override hint. */
  constructor(private readonly loadMaterials: (() => Promise<Material[] | null>) | null = null) {}

  mount(root: HTMLElement, ctx: SettingsContext): void {
    this.ctx = ctx;
    root.innerHTML = MaterialsTab.html();
    const ref = <T extends HTMLElement>(name: string): T => root.querySelector<T>(`[data-ref="${name}"]`)!;
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

    this.nameInput.addEventListener('input', () => {
      if (!this.idTouched) {
        this.idInput.value = MaterialsTab.slugOf(this.nameInput.value);
      }
      this.renderIdHint();
    });
    this.idInput.addEventListener('input', () => {
      this.idTouched = this.idInput.value !== '';
      this.renderIdHint();
    });
    this.commitBtn.addEventListener('click', () => this.commitForm());
    this.cancelEditBtn.addEventListener('click', () => this.resetForm());
    // Enter in a field adds / updates the entry; the dialog's own Save is
    // a separate step, so the key never reaches the overlay.
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target instanceof HTMLElement && e.target.matches('input, select')) {
        e.preventDefault();
        e.stopPropagation();
        this.commitForm();
      }
    });

    this.sync();
  }

  sync(): void {
    this.draft = GlobalMaterialsStore.copyOf(globalMaterials.current);
    this.resetForm();
    this.renderList();
    if (!this.builtinsLoaded) {
      void this.loadBuiltins();
    }
  }

  isDirty(): boolean {
    return !GlobalMaterialsStore.equal(this.draft, globalMaterials.current);
  }

  save(persist: PersistPreference): void {
    if (!this.isDirty()) {
      return;
    }
    const materials = GlobalMaterialsStore.copyOf(this.draft);
    globalMaterials.update(materials);
    persist('materials', materials);
  }

  // ---------------------------------------------------------------------------
  // Markup
  // ---------------------------------------------------------------------------

  private static html(): string {
    const field = (label: string, control: string) => `
      <label class="flex flex-col gap-1 min-w-0">
        <span class="text-xs text-base-content/70">${label}</span>
        ${control}
      </label>`;
    const units = DENSITY_UNITS.map((u) => `<option value="${u}">${u}</option>`).join('');
    return `
      <p class="${FIELD_HINT} mb-3 leading-snug">
        Your own materials, kept on this machine. Setting one on a part copies it into that project's
        <span class="font-mono">fluidcad.json</span>, so the model never depends on this list.
      </p>
      <div data-ref="list" class="overflow-y-auto max-h-[180px] border border-base-content/10 rounded-md mb-3"></div>
      <div class="border border-base-content/10 rounded-md px-3 py-2.5 flex flex-col gap-2.5">
        <span data-ref="form-title" class="text-xs font-medium text-base-content/80">Add material</span>
        ${field('Name', `<input data-ref="name" type="text" class="${INPUT}" placeholder="Alloy Steel" spellcheck="false" />`)}
        <div class="flex gap-2">
          <div class="flex-1 min-w-0">
            ${field('Density', `<input data-ref="density" type="number" min="0" step="any" class="${INPUT}" placeholder="7.7" />`)}
          </div>
          <div class="w-[110px]">
            ${field('Unit', `<select data-ref="unit" class="${SELECT}">${units}</select>`)}
          </div>
        </div>
        ${field('Id', `<input data-ref="id" type="text" class="${INPUT} font-mono" placeholder="alloy-steel" spellcheck="false" />`)}
        <span data-ref="id-hint" class="${FIELD_HINT} -mt-1.5 min-h-4"></span>
        <div data-ref="form-message" class="hidden bg-error text-error-content rounded-md px-3 py-2 text-xs leading-snug"></div>
        <div class="flex justify-end gap-2">
          <button data-ref="cancel-edit" type="button" class="btn btn-ghost btn-xs hidden">Cancel edit</button>
          <button data-ref="commit" type="button" class="btn btn-soft btn-primary btn-xs">Add</button>
        </div>
      </div>`;
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
      empty.textContent = 'No materials of your own yet.';
      this.listEl.appendChild(empty);
      return;
    }
    for (const id of ids) {
      this.listEl.appendChild(this.buildRow(id, this.draft[id]));
    }
  }

  private async loadBuiltins(): Promise<void> {
    if (!this.loadMaterials) {
      return;
    }
    const materials = await this.loadMaterials();
    if (!materials) {
      return;
    }
    this.builtinsLoaded = true;
    this.builtins = new Map(materials.filter((m) => m.source === 'builtin').map((m) => [m.id, m]));
    this.renderList();
    this.renderIdHint();
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
      this.idHint.textContent = `Overrides the built-in ${builtin.name} in any project it is set in.`;
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
      this.setFormMessage(`Id "${id}" is already used by "${this.draft[id].name}".`);
      return;
    }
    const entry: ProjectMaterial = { name, density, ...(unit === 'g/cm³' ? {} : { densityUnit: unit }) };
    this.draft = MaterialsTab.withEntry(this.draft, this.editingId, id, entry);
    this.renderList();
    this.resetForm();
    this.nameInput.focus();
    this.ctx.changed();
  }

  private removeEntry(id: string): void {
    if (!Object.prototype.hasOwnProperty.call(this.draft, id)) {
      return;
    }
    this.draft = Object.fromEntries(Object.entries(this.draft).filter(([key]) => key !== id));
    if (this.editingId === id) {
      this.resetForm();
    }
    this.renderList();
    this.ctx.changed();
  }

  private setFormMessage(text: string | null): void {
    this.formMessage.textContent = text ?? '';
    this.formMessage.classList.toggle('hidden', text === null);
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

  /**
   * The draft with `entry` at `id`: replacing `editingId`'s entry in place
   * (a renamed id keeps its position), or appended when adding.
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
