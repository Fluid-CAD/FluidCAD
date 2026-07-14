// The unified selection UI every pick-driven dialog shares: a labeled slot
// holding the current picks as chips. Single-pick slots (an extrude profile)
// render one bare chip; multi-pick slots (loft profiles, fillet edges, sweep
// path edges) wrap their chips in a bordered container. An empty slot shows
// its prompt ("Pick edges in 3D") instead. Picking itself happens in the 3D
// view / timeline — the slot only renders state and reports gestures.

/** One rendered chip in a {@link PickSlot}. */
export type PickSlotChip = {
  label: string;
  /** Badge text — a number for ordered lists, '●' for single slots, 'G' for guides. */
  badge?: string;
  /** Neutral badge tint instead of primary (loft guides). */
  badgeMuted?: boolean;
  /** Offer the ✕ button; chips with nothing to revert to opt out. */
  removable?: boolean;
  /** Hover tooltip; defaults to the label. */
  title?: string;
};

// The empty-slot prompt. Standalone (single slots) it is the classic count
// box: primary outline while it awaits picks, neutral fill when picking is
// not available. Inside a multi-slot container it is a plain text row — the
// container border already carries the armed signal.
const PROMPT_BARE_BASE = 'flex items-center gap-2 rounded-md px-3 py-2.5 border transition-colors';
const PROMPT_BARE_IDLE = 'bg-base-200 border-base-300 text-base-content/70';
const PROMPT_BARE_ARMED = 'bg-primary/10 border-primary text-primary';
const PROMPT_LISTED_BASE = 'flex items-center gap-2 rounded px-2 py-1.5 transition-colors';
const PROMPT_LISTED_IDLE = 'text-base-content/60';
const PROMPT_LISTED_ARMED = 'text-primary';

// The multi-pick container; the primary border marks the slot picks land in.
const LIST_BASE = 'flex flex-col gap-1 rounded-md border p-1 transition-colors';
const LIST_IDLE = 'border-base-300';
const LIST_ARMED = 'border-primary';

const ROW_BASE = 'flex items-center gap-1.5 rounded-md pr-1 py-1 bg-base-200 border';
const ROW_IDLE = 'border-base-300';
const ROW_ARMED = 'border-primary';
/** Reorderable rows carry 2px top/bottom borders that become drop markers. */
const ROW_DRAG_EXTRA = 'border-t-2 border-b-2 border-t-transparent border-b-transparent';

/**
 * A pick slot: header label, the picked chips, and a prompt while (more)
 * picks are wanted. `multiple` wraps the chips in a bordered container;
 * `reorderable` adds drag grips (chip order is argument order). `setArmed`
 * marks the slot as the live pick target — the container/chip wears the
 * primary border and the prompt its active tint. Clicking anywhere in the
 * slot fires `onArm` so dialogs with competing slots can re-aim picks.
 */
export class PickSlot {
  /** The slot was clicked — the dialog arms it as the pick target. */
  onArm?: () => void;
  /** The chip at `index` asked to be removed. */
  onRemove?: (index: number) => void;
  /** The chip at `from` was dragged to position `to` (reorderable slots). */
  onReorder?: (from: number, to: number) => void;
  /** A chip row is hovered (its index) or left (null) — viewport previews. */
  onChipHover?: (index: number | null) => void;

  private labelEl: HTMLSpanElement;
  private listEl: HTMLDivElement;
  private chips: PickSlotChip[] = [];
  private prompt: string | null = null;
  private armed = false;
  private multiple: boolean;
  /** Opt a single-pick slot into the bordered container box (heights then
   * match a sibling multi slot — the sweep dialog's profile beside its path);
   * defaults to following `multiple`. */
  private readonly forceBoxed?: boolean;
  private readonly reorderable: boolean;
  /** Chip index a drag started from; null while no drag is live. */
  private dragIndex: number | null = null;
  private rows: HTMLElement[] = [];

  constructor(host: HTMLElement, opts: { label: string; multiple: boolean; reorderable?: boolean; boxed?: boolean }) {
    this.multiple = opts.multiple;
    this.forceBoxed = opts.boxed;
    this.reorderable = opts.reorderable ?? false;
    host.classList.add('flex', 'flex-col', 'gap-1.5');
    this.labelEl = document.createElement('span');
    this.labelEl.className = 'text-base-content/70';
    this.labelEl.textContent = opts.label;
    this.listEl = document.createElement('div');
    host.append(this.labelEl, this.listEl);
    host.addEventListener('click', () => this.onArm?.());
    this.render();
  }

  setLabel(text: string): void {
    this.labelEl.textContent = text;
  }

  /** Switch container mode (the plane dialog's type flips its base count). */
  setMultiple(multiple: boolean): void {
    if (this.multiple === multiple) {
      return;
    }
    this.multiple = multiple;
    this.render();
  }

  setChips(chips: PickSlotChip[]): void {
    this.chips = chips;
    this.dragIndex = null;
    this.render();
  }

  /** Prompt shown while the slot wants (more) picks; null hides it. */
  setPrompt(text: string | null): void {
    if (this.prompt === text) {
      return;
    }
    this.prompt = text;
    this.render();
  }

  /** Mark the slot as the live pick target. */
  setArmed(armed: boolean): void {
    if (this.armed === armed) {
      return;
    }
    this.armed = armed;
    this.render();
  }

  /** Whether the chips sit inside the bordered container box. */
  private get boxed(): boolean {
    return this.forceBoxed ?? this.multiple;
  }

  private render(): void {
    this.rows = this.chips.map((chip, index) => this.renderChip(chip, index));
    // A single slot never shows chip and prompt together; a container keeps
    // the prompt under its chips while more picks are wanted.
    const promptWanted = this.prompt !== null && (this.multiple || this.rows.length === 0);
    const promptEl = promptWanted ? this.renderPrompt() : null;
    if (this.boxed) {
      this.listEl.className = `${LIST_BASE} ${this.armed ? LIST_ARMED : LIST_IDLE}`;
    } else {
      this.listEl.className = 'flex flex-col gap-1';
    }
    this.listEl.replaceChildren(...this.rows, ...(promptEl ? [promptEl] : []));
    this.listEl.classList.toggle('hidden', this.rows.length === 0 && !promptEl);
  }

  private renderPrompt(): HTMLElement {
    const el = document.createElement('div');
    el.className = this.boxed
      ? `${PROMPT_LISTED_BASE} ${this.armed ? PROMPT_LISTED_ARMED : PROMPT_LISTED_IDLE}`
      : `${PROMPT_BARE_BASE} ${this.armed ? PROMPT_BARE_ARMED : PROMPT_BARE_IDLE}`;
    const text = document.createElement('span');
    text.className = 'leading-snug';
    text.textContent = this.prompt ?? '';
    el.appendChild(text);
    return el;
  }

  private renderChip(chip: PickSlotChip, index: number): HTMLElement {
    const row = document.createElement('div');
    // A bare single chip carries the armed border itself; inside a container
    // the container border does.
    const outline = !this.boxed && this.armed ? ROW_ARMED : ROW_IDLE;
    row.className = `${ROW_BASE} ${outline} ${this.reorderable ? `pl-1.5 ${ROW_DRAG_EXTRA}` : 'pl-2'}`;

    if (this.reorderable) {
      row.appendChild(this.renderGrip(row, index));
      this.wireDropTarget(row, index);
    }

    if (chip.badge === '●') {
      // The single-pick indicator is a compact dot, not a padded pill badge —
      // a pill's inline padding floats the dot far off the chip's left edge.
      const dot = document.createElement('span');
      dot.className = `w-2 h-2 rounded-full shrink-0 ${chip.badgeMuted ? 'bg-base-content/40' : 'bg-primary'}`;
      row.appendChild(dot);
    } else if (chip.badge) {
      const badge = document.createElement('span');
      badge.className = `badge badge-sm badge-soft shrink-0${chip.badgeMuted ? '' : ' badge-primary'}`;
      badge.textContent = chip.badge;
      row.appendChild(badge);
    }

    const label = document.createElement('span');
    label.className = 'flex-1 truncate';
    label.textContent = chip.label;
    label.title = chip.title ?? chip.label;
    row.appendChild(label);

    if (chip.removable) {
      const remove = document.createElement('button');
      remove.className = 'btn btn-ghost btn-xs btn-square text-base-content/50 hover:text-base-content shrink-0 text-[9px]';
      remove.title = 'Remove this selection';
      remove.textContent = '✕';
      remove.addEventListener('click', () => this.onRemove?.(index));
      row.appendChild(remove);
    }

    row.addEventListener('mouseenter', () => this.onChipHover?.(index));
    row.addEventListener('mouseleave', () => this.onChipHover?.(null));
    return row;
  }

  /** The drag grip; dragging a row's grip reorders it within the slot. */
  private renderGrip(row: HTMLElement, index: number): HTMLElement {
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
    return handle;
  }

  private wireDropTarget(row: HTMLElement, index: number): void {
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
        this.onReorder?.(from, to);
      }
    });
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
    for (const row of this.rows) {
      this.unmarkDrop(row);
    }
  }
}
