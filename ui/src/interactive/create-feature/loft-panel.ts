import { LoftConditionRef } from '../../api';
import { FeatureOp, OpTabs, PanelShell, ThinControl } from './panel-controls';
import { SketchProfileOption } from './sketch-profiles';

/** Sentinel value for the add-profile dropdown's placeholder row. */
const ADD_PLACEHOLDER = '__add__';

// The profiles hint box mirrors the sweep panel's count box: primary outline
// while more profiles are needed; it disappears once the loft is applicable
// (the numbered chips already carry the order).
const HINT_BOX_BASE = 'flex items-center gap-2 rounded-md px-3 py-2.5 border transition-colors';
const HINT_BOX_ACTIVE = 'bg-primary/10 border-primary text-primary';

/** Validated form values, or the message to show when a field is invalid. */
export type LoftValues =
  | {
      op: FeatureOp;
      thin: [number] | null;
      startCondition: LoftConditionRef | null;
      endCondition: LoftConditionRef | null;
    }
  | { error: string };

/** One rendered chip in the ordered profile list. */
export type LoftProfileChip = { label: string };

/**
 * One takeoff-condition row (start or end): the type select plus a magnitude
 * field shown only while a condition is set. 'none' means "write no chain" —
 * it never reaches the statement.
 */
class ConditionRow {
  onChange?: () => void;
  onSubmit?: () => void;

  private select: HTMLSelectElement;
  private magnitude: HTMLInputElement;

  constructor(host: HTMLElement, label: string, title: string, private which: string) {
    host.className = 'flex flex-col gap-1.5';
    host.innerHTML = `
      <span class="text-base-content/70">${label}</span>
      <div class="flex items-center gap-1.5">
        <select data-role="type" class="select select-sm select-bordered flex-1 text-xs" title="${title}">
          <option value="none">None</option>
          <option value="normal">Normal</option>
          <option value="tangent">Tangent</option>
        </select>
        <input data-role="magnitude" type="number" step="0.5" value="1"
          title="Takeoff strength (default 1)"
          class="input input-sm input-bordered w-16 text-xs hidden" />
      </div>
    `;
    this.select = host.querySelector('[data-role="type"]')!;
    this.magnitude = host.querySelector('[data-role="magnitude"]')!;
    this.select.addEventListener('change', () => {
      this.sync();
      this.onChange?.();
    });
    this.magnitude.addEventListener('input', () => this.onChange?.());
    this.magnitude.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.onSubmit?.();
      }
      e.stopPropagation();
    });
  }

  reset(): void {
    this.select.value = 'none';
    this.magnitude.value = '1';
    this.sync();
  }

  /** The condition to write, null for none, or the blocking message. */
  values(): { condition: LoftConditionRef | null } | { error: string } {
    const type = this.select.value;
    if (type !== 'normal' && type !== 'tangent') {
      return { condition: null };
    }
    const magnitude = parseFloat(this.magnitude.value);
    if (!Number.isFinite(magnitude) || magnitude === 0) {
      return { error: `Enter a nonzero magnitude for the ${this.which} condition.` };
    }
    return { condition: { type, magnitude } };
  }

  private sync(): void {
    this.magnitude.classList.toggle('hidden', this.select.value === 'none');
  }
}

/**
 * The loft dialog: operation tabs, the ordered profile list (numbered,
 * removable chips — chip order is argument order), an add-sketch dropdown,
 * the optional guide list (up to two guide sketches), the start/end takeoff
 * conditions, and the thin toggle (blocked while guides exist — the kernel
 * forbids the combination). Faces are added by picking in the 3D view while
 * the dialog is armed; sketches via the dropdowns or timeline clicks, landing
 * in whichever section was focused last (`armedSection`). Pure DOM + form
 * state — the service owns the profile/guide lists, picks, previews, and the
 * apply call.
 */
export class LoftPanel {
  onChange?: () => void;
  onApply?: () => void;
  onExit?: () => void;
  /** A sketch was chosen in the add-profile dropdown. */
  onAddSketch?: (option: SketchProfileOption) => void;
  /** The chip at `index` (argument order) was removed. */
  onRemoveProfile?: (index: number) => void;
  /** The chip at `from` was dragged to position `to` (argument order). */
  onReorderProfile?: (from: number, to: number) => void;
  /** A sketch was chosen in the add-guide dropdown. */
  onAddGuide?: (option: SketchProfileOption) => void;
  /** The guide chip at `index` was removed. */
  onRemoveGuide?: (index: number) => void;

  /** The section a timeline/viewport sketch pick fills — last focused. */
  armedSection: 'profiles' | 'guides' = 'profiles';

  private shell: PanelShell;
  private tabs: OpTabs;
  private thin: ThinControl;
  private startCondition: ConditionRow;
  private endCondition: ConditionRow;
  private chipList: HTMLElement;
  private guideChipList: HTMLElement;
  private hintBox: HTMLElement;
  private hintText: HTMLElement;
  private addSelect: HTMLSelectElement;
  private addGuideSelect: HTMLSelectElement;
  private applyBtn: HTMLButtonElement;
  private sketchOptions: SketchProfileOption[] = [];
  private guideOptions: SketchProfileOption[] = [];
  /** Chip index a drag started from; null while no drag is live. */
  private dragIndex: number | null = null;

  constructor(container: HTMLElement) {
    this.shell = new PanelShell(container, 'fluidcad-loft-panel', 'Loft mode', '/icons/loft.png');
    this.shell.onEscape = () => this.onExit?.();
    this.shell.body.insertAdjacentHTML('beforeend', `
      <div data-role="tabs" class="join w-full"></div>
      <div class="flex flex-col gap-1.5">
        <span class="text-base-content/70">Profiles — in loft order</span>
        <div data-role="chips" class="flex flex-col gap-1"></div>
        <div data-role="hint" class="${HINT_BOX_BASE} ${HINT_BOX_ACTIVE}">
          <span data-role="hint-text" class="leading-snug">Pick faces in 3D or add sketches</span>
        </div>
        <select data-role="add" class="select select-sm select-bordered w-full text-xs"></select>
      </div>
      <div class="flex flex-col gap-1.5">
        <span class="text-base-content/70">Guides — optional, up to 2</span>
        <div data-role="guide-chips" class="flex flex-col gap-1 hidden"></div>
        <select data-role="add-guide" class="select select-sm select-bordered w-full text-xs"></select>
      </div>
      <div data-role="start-condition"></div>
      <div data-role="end-condition"></div>
      <div data-role="thin-host" class="contents"></div>
      <div class="flex items-center gap-2 pt-1">
        <button data-role="apply" class="btn btn-primary btn-sm flex-1">Apply</button>
        <button data-role="exit" class="btn btn-ghost btn-sm">Exit</button>
      </div>
    `);

    this.tabs = new OpTabs(this.shell.body.querySelector('[data-role="tabs"]')!, [
      { op: 'add', label: 'Add', title: 'Fuse the lofted solid with the model — loft()' },
      { op: 'remove', label: 'Remove', title: 'Cut the lofted solid out of the model — loft().remove()' },
      { op: 'new', label: 'New', title: 'Keep the lofted solid as a separate body — loft().new()' },
    ]);
    this.tabs.onChange = () => this.onChange?.();
    this.thin = new ThinControl(this.shell.body.querySelector('[data-role="thin-host"]')!);
    this.thin.onChange = () => this.onChange?.();
    this.thin.onSubmit = () => this.onApply?.();
    this.startCondition = new ConditionRow(
      this.shell.body.querySelector('[data-role="start-condition"]')!,
      'Start condition', 'How the surface takes off from the first profile', 'start',
    );
    this.endCondition = new ConditionRow(
      this.shell.body.querySelector('[data-role="end-condition"]')!,
      'End condition', 'How the surface arrives at the last profile', 'end',
    );
    for (const row of [this.startCondition, this.endCondition]) {
      row.onChange = () => this.onChange?.();
      row.onSubmit = () => this.onApply?.();
    }

    this.chipList = this.shell.body.querySelector('[data-role="chips"]')!;
    this.guideChipList = this.shell.body.querySelector('[data-role="guide-chips"]')!;
    this.hintBox = this.shell.body.querySelector('[data-role="hint"]')!;
    this.hintText = this.shell.body.querySelector('[data-role="hint-text"]')!;
    this.addSelect = this.shell.body.querySelector('[data-role="add"]')!;
    this.addGuideSelect = this.shell.body.querySelector('[data-role="add-guide"]')!;
    this.applyBtn = this.shell.body.querySelector('[data-role="apply"]')!;

    this.applyBtn.addEventListener('click', () => this.onApply?.());
    this.shell.body.querySelector('[data-role="exit"]')!.addEventListener('click', () => this.onExit?.());
    this.addSelect.addEventListener('focus', () => this.setArmedSection('profiles'));
    this.addGuideSelect.addEventListener('focus', () => this.setArmedSection('guides'));
    this.addSelect.addEventListener('change', () => {
      const option = this.sketchOptions[Number(this.addSelect.value)];
      this.addSelect.value = ADD_PLACEHOLDER;
      if (option) {
        this.onAddSketch?.(option);
      }
    });
    this.addGuideSelect.addEventListener('change', () => {
      const option = this.guideOptions[Number(this.addGuideSelect.value)];
      this.addGuideSelect.value = ADD_PLACEHOLDER;
      if (option) {
        this.onAddGuide?.(option);
      }
    });
  }

  get isVisible(): boolean {
    return this.shell.isVisible;
  }

  show(): void {
    // A fresh arming starts from empty profile/guide lists, no stale options,
    // and unconditioned takeoffs.
    this.sketchOptions = [];
    this.guideOptions = [];
    this.setProfiles([]);
    this.setSketchOptions([]);
    this.setGuides([]);
    this.setGuideOptions([], false);
    this.startCondition.reset();
    this.endCondition.reset();
    this.setThinBlocked(false);
    this.setArmedSection('profiles');
    this.shell.show();
  }

  hide(): void {
    this.shell.hide();
  }

  /**
   * Render the ordered profile chips; chip N is the loft's argument N.
   * Rows reorder by dragging their grip handle — the drop marker shows on
   * the top or bottom edge of the hovered row.
   */
  setProfiles(chips: LoftProfileChip[]): void {
    this.dragIndex = null;
    this.chipList.replaceChildren(...chips.map((chip, index) => {
      const row = document.createElement('div');
      row.className = 'flex items-center gap-1.5 rounded-md pl-1.5 pr-1 py-1 bg-base-200 border border-base-300 border-t-2 border-b-2 border-t-transparent border-b-transparent';

      const handle = document.createElement('span');
      handle.className = 'cursor-grab active:cursor-grabbing text-base-content/40 hover:text-base-content select-none shrink-0 leading-none';
      handle.textContent = '⠿';
      handle.title = 'Drag to reorder';
      handle.draggable = true;
      handle.addEventListener('dragstart', (e) => {
        this.dragIndex = index;
        row.classList.add('opacity-50');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(index));
          e.dataTransfer.setDragImage(row, 16, 12);
        }
      });
      handle.addEventListener('dragend', () => {
        this.dragIndex = null;
        row.classList.remove('opacity-50');
        this.clearDropMarkers();
      });

      row.addEventListener('dragover', (e) => {
        if (this.dragIndex === null || this.dragIndex === index) {
          return;
        }
        e.preventDefault();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'move';
        }
        this.markDrop(row, this.dropsBefore(row, e.clientY));
      });
      row.addEventListener('dragleave', () => this.unmarkDrop(row));
      row.addEventListener('drop', (e) => {
        const from = this.dragIndex;
        this.dragIndex = null;
        this.clearDropMarkers();
        if (from === null || from === index) {
          return;
        }
        e.preventDefault();
        let to = index + (this.dropsBefore(row, e.clientY) ? 0 : 1);
        if (to > from) {
          to -= 1;
        }
        if (to !== from) {
          this.onReorderProfile?.(from, to);
        }
      });

      const badge = document.createElement('span');
      badge.className = 'badge badge-sm badge-primary badge-soft shrink-0';
      badge.textContent = String(index + 1);
      const label = document.createElement('span');
      label.className = 'flex-1 truncate';
      label.textContent = chip.label;
      label.title = chip.label;
      const remove = document.createElement('button');
      remove.className = 'btn btn-ghost btn-xs btn-square text-base-content/50 hover:text-base-content shrink-0 text-[9px]';
      remove.title = 'Remove this profile';
      remove.textContent = '✕';
      remove.addEventListener('click', () => this.onRemoveProfile?.(index));

      row.append(handle, badge, label, remove);
      return row;
    }));
    this.chipList.classList.toggle('hidden', chips.length === 0);
  }

  /** Whether a drop at `clientY` lands before (above) the hovered row. */
  private dropsBefore(row: HTMLElement, clientY: number): boolean {
    const rect = row.getBoundingClientRect();
    return clientY < rect.top + rect.height / 2;
  }

  private markDrop(row: HTMLElement, before: boolean): void {
    this.unmarkDrop(row);
    row.classList.remove(before ? 'border-t-transparent' : 'border-b-transparent');
    row.classList.add(before ? 'border-t-primary' : 'border-b-primary');
  }

  private unmarkDrop(row: HTMLElement): void {
    row.classList.remove('border-t-primary', 'border-b-primary');
    row.classList.add('border-t-transparent', 'border-b-transparent');
  }

  private clearDropMarkers(): void {
    for (const row of this.chipList.children) {
      this.unmarkDrop(row as HTMLElement);
    }
  }

  /** The sketches the dropdown offers (the ones not already in the list). */
  setSketchOptions(options: SketchProfileOption[]): void {
    this.sketchOptions = options;
    const placeholder = document.createElement('option');
    placeholder.value = ADD_PLACEHOLDER;
    placeholder.textContent = options.length > 0 ? 'Add a sketch profile…' : 'No sketches to add';
    this.addSelect.replaceChildren(placeholder, ...options.map((option, i) => {
      const el = document.createElement('option');
      el.value = String(i);
      el.textContent = option.label;
      return el;
    }));
    this.addSelect.value = ADD_PLACEHOLDER;
    this.addSelect.disabled = options.length === 0;
  }

  /** Render the guide chips — plain removable rows, no ordering. */
  setGuides(chips: LoftProfileChip[]): void {
    this.guideChipList.replaceChildren(...chips.map((chip, index) => {
      const row = document.createElement('div');
      row.className = 'flex items-center gap-1.5 rounded-md pl-2 pr-1 py-1 bg-base-200 border border-base-300';
      const badge = document.createElement('span');
      badge.className = 'badge badge-sm badge-soft shrink-0';
      badge.textContent = 'G';
      const label = document.createElement('span');
      label.className = 'flex-1 truncate';
      label.textContent = chip.label;
      label.title = chip.label;
      const remove = document.createElement('button');
      remove.className = 'btn btn-ghost btn-xs btn-square text-base-content/50 hover:text-base-content shrink-0 text-[9px]';
      remove.title = 'Remove this guide';
      remove.textContent = '✕';
      remove.addEventListener('click', () => this.onRemoveGuide?.(index));
      row.append(badge, label, remove);
      return row;
    }));
    this.guideChipList.classList.toggle('hidden', chips.length === 0);
  }

  /** The sketches the guide dropdown offers; `atCapacity` = two guides set. */
  setGuideOptions(options: SketchProfileOption[], atCapacity: boolean): void {
    this.guideOptions = options;
    const placeholder = document.createElement('option');
    placeholder.value = ADD_PLACEHOLDER;
    placeholder.textContent = atCapacity
      ? 'Two guides max'
      : options.length > 0 ? 'Add a guide sketch…' : 'No sketches to add';
    this.addGuideSelect.replaceChildren(placeholder, ...options.map((option, i) => {
      const el = document.createElement('option');
      el.value = String(i);
      el.textContent = option.label;
      return el;
    }));
    this.addGuideSelect.value = ADD_PLACEHOLDER;
    this.addGuideSelect.disabled = atCapacity || options.length === 0;
  }

  /** Guides exclude thin mode — block the toggle while any guide is set. */
  setThinBlocked(blocked: boolean): void {
    this.thin.setBlocked(blocked, 'Guides cannot be combined with thin walls — remove the guides first.');
  }

  values(): LoftValues {
    const thin = this.thin.values();
    if ('error' in thin) {
      return thin;
    }
    const start = this.startCondition.values();
    if ('error' in start) {
      return start;
    }
    const end = this.endCondition.values();
    if ('error' in end) {
      return end;
    }
    return {
      op: this.tabs.op,
      thin: thin.thin,
      startCondition: start.condition,
      endCondition: end.condition,
    };
  }

  private setArmedSection(section: 'profiles' | 'guides'): void {
    this.armedSection = section;
    this.addSelect.classList.toggle('select-primary', section === 'profiles');
    this.addGuideSelect.classList.toggle('select-primary', section === 'guides');
  }

  /** Profile progress prompt while more profiles are needed; null hides it. */
  setHint(text: string | null): void {
    if (text === null) {
      this.hintBox.classList.add('hidden');
      return;
    }
    this.hintText.textContent = text;
    this.hintBox.className = `${HINT_BOX_BASE} ${HINT_BOX_ACTIVE}`;
  }

  setPreview(text: string | null): void {
    this.shell.setPreview(text);
  }

  setMessage(text: string | null): void {
    this.shell.setMessage(text);
  }

  setApplyEnabled(enabled: boolean): void {
    this.applyBtn.disabled = !enabled;
  }
}
