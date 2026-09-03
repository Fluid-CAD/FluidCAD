import { FeaturePanel } from '../create-feature/feature-panel';
import { PickSlot } from '../pick-slot';
import { escapeHtml } from '../../ui/expression-core';

/**
 * One of the original's mates as the panel shows it: the mate kind
 * ("Slider"), the connector it is attached to now ("c1 (assembly)"),
 * whether it takes exposed geometry (tangent) rather than a connector, and
 * whether each copy re-attaches it (ON) or keeps the same connector (OFF).
 */
export type ReplicateColumnView = { mate: string; target: string; geometry: boolean; on: boolean };

/** One copy as the panel shows it: cells aligned with EVERY column (OFF columns unused). */
export type ReplicateRowView = {
  /** The copy's number: "2" for the first copy (the original is 1) — it becomes "<name> (2)". */
  number: number;
  cells: ({ label: string } | null)[];
};

export type ReplicateArmedCell = { row: number; col: number } | null;

const PROMPT_CONNECTOR = 'Click a connector in 3D';
const PROMPT_GEOMETRY = 'Click an exposed face or edge in 3D';

/**
 * The replicate dialog. Reads top to bottom as the task: what the dialog
 * does (intro), what to do right now (hint), which mates each copy
 * re-attaches (checkboxes), then one block per copy with a labelled pick
 * slot per re-attached mate. Pure DOM + view state — the service owns the
 * picks, the preview and the apply call; it hands the panel column and row
 * views to render and receives cell/row gestures back.
 */
export class ReplicatePanel extends FeaturePanel {
  onToggleColumn?: (col: number, on: boolean) => void;
  onAddRow?: () => void;
  onRemoveRow?: (row: number) => void;
  /** A cell was clicked — the service aims picks at it. */
  onArmCell?: (row: number, col: number) => void;
  /** A cell's chip ✕ — the service empties it. */
  onClearCell?: (row: number, col: number) => void;
  onFillSiblings?: () => void;

  private introEl: HTMLElement;
  private seedPrompt: HTMLElement;
  private hintEl: HTMLElement;
  private targetsSection: HTMLElement;
  private targetsEl: HTMLElement;
  private targetsNote: HTMLElement;
  private rowsSection: HTMLElement;
  private rowsEl: HTMLElement;
  private fillBtn: HTMLButtonElement;
  private seedName = '';
  private columns: ReplicateColumnView[] = [];
  private rows: ReplicateRowView[] = [];
  private armed: ReplicateArmedCell = null;

  constructor(container: HTMLElement) {
    super(container, {
      id: 'fluidcad-replicate-panel',
      title: 'Replicate',
      icon: '/icons/replicate.png',
      exitLabel: 'Cancel',
      bodyHtml: `
        <p data-role="intro" class="text-base-content/60 leading-snug m-0"></p>
        <div data-role="seed-prompt" class="hidden rounded-md px-3 py-2.5 border bg-primary/10 border-primary text-primary leading-snug">
          Click the part or sub-assembly to copy. It needs at least one mate.
        </div>
        <div data-role="hint" class="hidden rounded-md px-3 py-2.5 border bg-primary/10 border-primary text-primary leading-snug"></div>
        <div data-role="targets-section" class="flex flex-col gap-1.5">
          <span class="text-base-content/70">Mates to re-attach</span>
          <div data-role="targets" class="flex flex-col gap-1"></div>
          <span data-role="targets-note" class="hidden text-[11px] text-base-content/50 leading-snug">Unchecked mates keep the same connector on every copy.</span>
        </div>
        <div data-role="rows-section" class="flex flex-col gap-2">
          <span class="text-base-content/70">Copies</span>
          <div data-role="rows" class="flex flex-col gap-2"></div>
          <div class="flex items-center gap-1.5">
            <button data-role="add-row" type="button" class="btn btn-ghost btn-xs">+ Add copy</button>
            <button data-role="fill-siblings" type="button" class="btn btn-ghost btn-xs hidden"
              title="Adds one copy per unused connector on the same part (or per other assembly connector)">Suggest copies</button>
          </div>
        </div>
      `,
    });
    // A little wider than the shared w-60 body: each copy holds a full
    // label + slot per mate, and connector names run long.
    this.shell.body.classList.replace('sm:w-60', 'sm:w-72');
    this.introEl = this.role('intro');
    this.seedPrompt = this.role('seed-prompt');
    this.hintEl = this.role('hint');
    this.targetsSection = this.role('targets-section');
    this.targetsEl = this.role('targets');
    this.targetsNote = this.role('targets-note');
    this.rowsSection = this.role('rows-section');
    this.rowsEl = this.role('rows');
    this.fillBtn = this.role<HTMLButtonElement>('fill-siblings');
    this.role<HTMLButtonElement>('add-row').addEventListener('click', () => this.onAddRow?.());
    this.fillBtn.addEventListener('click', () => this.onFillSiblings?.());
  }

  /**
   * Open the dialog. With a seed, the title names it (and edit mode says
   * so); without one the body is the seed-pick prompt until the service
   * resolves a click into a seed.
   */
  show(seed: { name: string; edit: boolean } | null): void {
    this.applySeed(seed);
    this.columns = [];
    this.rows = [];
    this.armed = null;
    this.setHint(null);
    this.setSeedPending(seed === null);
    this.renderTargets();
    this.renderRows();
    this.setFillAvailable(false);
    this.shell.show();
  }

  /** Toggle between the seed-pick prompt and the mates/copies sections. */
  setSeedPending(pending: boolean): void {
    this.seedPrompt.classList.toggle('hidden', !pending);
    this.hintEl.classList.toggle('hidden', pending || this.hintEl.textContent === '');
    this.targetsSection.classList.toggle('hidden', pending);
    this.rowsSection.classList.toggle('hidden', pending);
  }

  setTitleSeed(seed: { name: string; edit: boolean }): void {
    this.applySeed(seed);
    this.renderRows();
  }

  /** The "what to do now" line; null hides it. */
  setHint(text: string | null): void {
    this.hintEl.textContent = text ?? '';
    this.hintEl.classList.toggle('hidden', text === null || this.seedPrompt.classList.contains('hidden') === false);
  }

  setColumns(columns: ReplicateColumnView[]): void {
    this.columns = columns;
    this.renderTargets();
    this.renderRows();
  }

  setRows(rows: ReplicateRowView[], armed: ReplicateArmedCell): void {
    this.rows = rows;
    this.armed = armed;
    this.renderRows();
  }

  setFillAvailable(available: boolean): void {
    this.fillBtn.classList.toggle('hidden', !available);
  }

  getArmedCell(): ReplicateArmedCell {
    return this.armed;
  }

  private applySeed(seed: { name: string; edit: boolean } | null): void {
    this.seedName = seed?.name ?? '';
    this.shell.setTitle(seed ? `${seed.edit ? 'Edit replicate' : 'Replicate'} · ${seed.name}` : 'Replicate');
    this.introEl.textContent = seed
      ? `Makes copies of ${seed.name} that keep its mates, each attached to connectors you pick.`
      : 'Makes copies of a mated part or sub-assembly, each attached to connectors you pick.';
  }

  private renderTargets(): void {
    this.targetsEl.innerHTML = this.columns.map((column, j) => `
      <label class="flex items-center gap-2 cursor-pointer" data-target="${j}"
        title="${escapeHtml(`${column.mate} mate, attached to ${column.target} on ${this.seedName}`)}">
        <input type="checkbox" class="checkbox checkbox-xs" data-target-toggle="${j}" ${column.on ? 'checked' : ''} />
        <span class="truncate">${escapeHtml(column.mate)} · on ${escapeHtml(column.target)}</span>
      </label>
    `).join('');
    if (this.columns.length === 0) {
      this.targetsEl.innerHTML = `<span class="text-base-content/50">${escapeHtml(this.seedName || 'The original')} has no mates to copy.</span>`;
    }
    this.targetsNote.classList.toggle('hidden', this.columns.length === 0);
    this.targetsEl.querySelectorAll<HTMLInputElement>('[data-target-toggle]').forEach((input) => {
      input.addEventListener('change', () => {
        this.onToggleColumn?.(Number(input.dataset.targetToggle), input.checked);
      });
    });
  }

  /** Column indices that vary per copy, in column order. */
  private onColumns(): number[] {
    return this.columns.map((c, j) => (c.on ? j : -1)).filter(j => j >= 0);
  }

  /**
   * One bordered box per copy (the multi-pick container idiom: neutral
   * border, primary while it holds the armed slot): its resulting name and
   * ✕ on a header line, then a pick slot per re-attached mate labelled by
   * the mate ("Slider mate") with what it replaces as a muted sub-line.
   */
  private renderRows(): void {
    const on = this.onColumns();
    this.rowsEl.replaceChildren();
    this.rows.forEach((row, k) => {
      const holdsArmed = this.armed !== null && this.armed.row === k;
      const rowEl = document.createElement('div');
      rowEl.className = `flex flex-col gap-1.5 rounded-md border p-2 ${holdsArmed ? 'border-primary' : 'border-base-300'}`;
      rowEl.dataset.replicaRow = String(k);

      const header = document.createElement('div');
      header.className = 'flex items-center gap-1.5';
      const name = document.createElement('span');
      name.className = 'flex-1 min-w-0 truncate text-base-content/80 font-medium';
      name.textContent = `${this.seedName} (${row.number})`;
      name.title = `Copy ${row.number} will be named "${this.seedName} (${row.number})"`;
      header.appendChild(name);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-ghost btn-xs btn-square text-base-content/50 hover:text-base-content shrink-0 text-[9px]';
      remove.title = 'Remove this copy';
      remove.textContent = '✕';
      remove.dataset.removeRow = String(k);
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onRemoveRow?.(k);
      });
      header.appendChild(remove);
      rowEl.appendChild(header);

      for (const j of on) {
        const column = this.columns[j];
        const host = document.createElement('div');
        host.dataset.replicaCell = `${k}:${j}`;
        rowEl.appendChild(host);
        const slot = new PickSlot(host, {
          label: `${column.mate} mate`,
          sublabel: `replaces ${column.target}`,
          multiple: false,
        });
        const cell = row.cells[j];
        if (cell) {
          slot.setChips([{ label: cell.label, badge: '●', removable: true }]);
          slot.setPrompt(null);
        } else {
          slot.setChips([]);
          slot.setPrompt(column.geometry ? PROMPT_GEOMETRY : PROMPT_CONNECTOR);
        }
        slot.setArmed(this.armed !== null && this.armed.row === k && this.armed.col === j);
        slot.onArm = () => this.onArmCell?.(k, j);
        slot.onRemove = () => this.onClearCell?.(k, j);
      }
      this.rowsEl.appendChild(rowEl);
    });
  }
}
