import { FeatureOp, OpTabs, PanelShell, ThinControl } from './panel-controls';
import { SketchProfileOption } from './sketch-profiles';

/** Sentinel value for the add-profile dropdown's placeholder row. */
const ADD_PLACEHOLDER = '__add__';

// The profiles hint box mirrors the sweep panel's count box: primary outline
// while more profiles are needed, neutral fill once the loft is applicable.
const HINT_BOX_BASE = 'flex items-center gap-2 rounded-md px-3 py-2.5 border transition-colors';
const HINT_BOX_IDLE = 'bg-base-200 border-base-300 text-base-content/70';
const HINT_BOX_ACTIVE = 'bg-primary/10 border-primary text-primary';

/** Validated form values, or the message to show when a field is invalid. */
export type LoftValues =
  | { op: FeatureOp; thin: [number] | null }
  | { error: string };

/** One rendered chip in the ordered profile list. */
export type LoftProfileChip = { label: string };

/**
 * The loft dialog: operation tabs, the ordered profile list (numbered,
 * removable chips — chip order is argument order), an add-sketch dropdown,
 * and the thin toggle. Faces are added by picking in the 3D view while the
 * dialog is armed; sketches via the dropdown or timeline clicks. Pure DOM +
 * form state — the service owns the profile list, picks, previews, and the
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

  private shell: PanelShell;
  private tabs: OpTabs;
  private thin: ThinControl;
  private chipList: HTMLElement;
  private hintBox: HTMLElement;
  private hintText: HTMLElement;
  private addSelect: HTMLSelectElement;
  private applyBtn: HTMLButtonElement;
  private sketchOptions: SketchProfileOption[] = [];
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

    this.chipList = this.shell.body.querySelector('[data-role="chips"]')!;
    this.hintBox = this.shell.body.querySelector('[data-role="hint"]')!;
    this.hintText = this.shell.body.querySelector('[data-role="hint-text"]')!;
    this.addSelect = this.shell.body.querySelector('[data-role="add"]')!;
    this.applyBtn = this.shell.body.querySelector('[data-role="apply"]')!;

    this.applyBtn.addEventListener('click', () => this.onApply?.());
    this.shell.body.querySelector('[data-role="exit"]')!.addEventListener('click', () => this.onExit?.());
    this.addSelect.addEventListener('change', () => {
      const option = this.sketchOptions[Number(this.addSelect.value)];
      this.addSelect.value = ADD_PLACEHOLDER;
      if (option) {
        this.onAddSketch?.(option);
      }
    });
  }

  get isVisible(): boolean {
    return this.shell.isVisible;
  }

  show(): void {
    // A fresh arming starts from an empty profile list and no stale options.
    this.sketchOptions = [];
    this.setProfiles([]);
    this.setSketchOptions([]);
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

  values(): LoftValues {
    const thin = this.thin.values();
    if ('error' in thin) {
      return thin;
    }
    return { op: this.tabs.op, thin: thin.thin };
  }

  /** Profile progress: the hint line, wearing the armed outline while short. */
  setHint(text: string, needsMore: boolean): void {
    this.hintText.textContent = text;
    this.hintBox.className = `${HINT_BOX_BASE} ${needsMore ? HINT_BOX_ACTIVE : HINT_BOX_IDLE}`;
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
