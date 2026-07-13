import { PanelShell } from './panel-controls';
import { PickSlot } from '../pick-slot';

export type PlaneType = 'offset' | 'mid' | 'edge';

/** Validated form values, or the message to show when a field is invalid. */
export type PlaneValues =
  | {
      type: PlaneType;
      offset: number | null;
      rotateX: number | null;
      rotateY: number | null;
      rotateZ: number | null;
      position: number | null;
    }
  | { error: string };

/** One rendered chip in the base list. */
export type PlaneBaseChip = { label: string };

/**
 * The plane dialog: the type dropdown (Offset / Mid plane / From edge), the
 * base pick slot — filled entirely from the scene: faces are picked in the
 * 3D view while the dialog is armed (edges for the edge type), standard
 * origin planes by clicking their viewport quads, existing plane features
 * via timeline clicks — plus the offset distance (offset type), the 0–1
 * edge position (edge type) and the per-axis rotation row (offset/mid — the
 * edge form's argument slot is taken by the position). The mid type takes
 * two bases, so its chips wrap in a container. Pure DOM + form state — the
 * service owns the base list, picks, previews, and the apply call.
 */
export class PlanePanel {
  onChange?: () => void;
  onApply?: () => void;
  onExit?: () => void;
  /** The type dropdown changed — the service re-validates its base list. */
  onTypeChange?: () => void;
  /** The chip at `index` was removed. */
  onRemoveBase?: (index: number) => void;

  private shell: PanelShell;
  private typeSelect: HTMLSelectElement;
  private basesSlot: PickSlot;
  private offsetRow: HTMLElement;
  private offsetInput: HTMLInputElement;
  private positionRow: HTMLElement;
  private positionInput: HTMLInputElement;
  private rotationRow: HTMLElement;
  private rotationInputs: HTMLInputElement[] = [];
  private applyBtn: HTMLButtonElement;

  constructor(container: HTMLElement) {
    this.shell = new PanelShell(container, 'fluidcad-plane-panel', 'Plane mode', '/icons/plane.png');
    this.shell.onEscape = () => this.onExit?.();
    this.shell.body.insertAdjacentHTML('beforeend', `
      <label class="flex flex-col gap-1.5">
        <span class="text-base-content/70">Type</span>
        <select data-role="type" class="select select-sm select-bordered w-full text-xs">
          <option value="offset" title="A plane offset from one base — plane(base, distance)">Offset</option>
          <option value="mid" title="A plane midway between two bases — plane(base1, base2)">Mid plane</option>
          <option value="edge" title="A plane normal to an edge at a position along it — plane(edge, 0.5)">From edge</option>
        </select>
      </label>
      <div data-role="bases-slot"></div>
      <label data-role="offset-row" class="flex flex-col gap-1.5">
        <span class="text-base-content/70">Offset</span>
        <input data-role="offset" type="number" step="1" value="10"
          class="input input-sm input-bordered w-full text-xs" />
      </label>
      <label data-role="position-row" class="hidden flex-col gap-1.5">
        <span class="text-base-content/70">Position along edge (0 = start, 1 = end)</span>
        <input data-role="position" type="number" step="0.1" min="0" max="1" value="0.5"
          class="input input-sm input-bordered w-full text-xs" />
      </label>
      <div data-role="rotation-row" class="flex flex-col gap-1.5">
        <span class="text-base-content/70">Rotation (degrees)</span>
        <div class="flex items-center gap-1.5">
          <input data-role="rotate-x" type="number" step="5" value="0" title="Rotation around the plane's X axis"
            class="input input-sm input-bordered w-full min-w-0 text-xs" />
          <input data-role="rotate-y" type="number" step="5" value="0" title="Rotation around the plane's Y axis"
            class="input input-sm input-bordered w-full min-w-0 text-xs" />
          <input data-role="rotate-z" type="number" step="5" value="0" title="Rotation around the plane's normal"
            class="input input-sm input-bordered w-full min-w-0 text-xs" />
        </div>
      </div>
      <div class="flex items-center gap-2 pt-1">
        <button data-role="apply" class="btn btn-primary btn-sm flex-1">Apply</button>
        <button data-role="exit" class="btn btn-ghost btn-sm">Exit</button>
      </div>
    `);

    this.typeSelect = this.shell.body.querySelector('[data-role="type"]')!;
    this.basesSlot = new PickSlot(
      this.shell.body.querySelector('[data-role="bases-slot"]')!,
      { label: 'Base', multiple: false },
    );
    // The slot is the live pick target the whole time the dialog is armed.
    this.basesSlot.setArmed(true);
    this.basesSlot.onRemove = (index) => this.onRemoveBase?.(index);
    this.offsetRow = this.shell.body.querySelector('[data-role="offset-row"]')!;
    this.offsetInput = this.shell.body.querySelector('[data-role="offset"]')!;
    this.positionRow = this.shell.body.querySelector('[data-role="position-row"]')!;
    this.positionInput = this.shell.body.querySelector('[data-role="position"]')!;
    this.rotationRow = this.shell.body.querySelector('[data-role="rotation-row"]')!;
    this.applyBtn = this.shell.body.querySelector('[data-role="apply"]')!;

    this.typeSelect.addEventListener('change', () => {
      this.syncType();
      this.onTypeChange?.();
      this.onChange?.();
    });

    this.rotationInputs = ['x', 'y', 'z'].map(axis =>
      this.shell.body.querySelector<HTMLInputElement>(`[data-role="rotate-${axis}"]`)!);
    for (const input of [this.offsetInput, this.positionInput, ...this.rotationInputs]) {
      input.addEventListener('input', () => this.onChange?.());
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.onApply?.();
        }
        e.stopPropagation();
      });
    }

    this.applyBtn.addEventListener('click', () => this.onApply?.());
    this.shell.body.querySelector('[data-role="exit"]')!.addEventListener('click', () => this.onExit?.());
  }

  get isVisible(): boolean {
    return this.shell.isVisible;
  }

  get planeType(): PlaneType {
    const value = this.typeSelect.value;
    return value === 'mid' || value === 'edge' ? value : 'offset';
  }

  /** How many bases the current type takes: 2 for mid, 1 otherwise. */
  get capacity(): 1 | 2 {
    return this.planeType === 'mid' ? 2 : 1;
  }

  show(): void {
    // A fresh arming starts from defaults and an empty base list.
    this.typeSelect.value = 'offset';
    this.offsetInput.value = '10';
    this.positionInput.value = '0.5';
    for (const input of this.rotationInputs) {
      input.value = '0';
    }
    this.setBases([]);
    this.syncType();
    this.shell.show();
  }

  /** Programmatic type choice (selection seeding); no change event fires. */
  setType(type: PlaneType): void {
    this.typeSelect.value = type;
    this.syncType();
  }

  hide(): void {
    this.shell.hide();
  }

  /** Render the base chips (numbered for a mid plane — argument order). */
  setBases(chips: PlaneBaseChip[]): void {
    const numbered = this.capacity > 1;
    this.basesSlot.setChips(chips.map((chip, index) => ({
      label: chip.label,
      badge: numbered ? String(index + 1) : '●',
      removable: true,
    })));
  }

  /** Base progress prompt while more bases are needed; null hides it. */
  setHint(text: string | null): void {
    this.basesSlot.setPrompt(text);
  }

  values(): PlaneValues {
    const type = this.planeType;
    if (type === 'edge') {
      const position = parseFloat(this.positionInput.value);
      if (!Number.isFinite(position) || position < 0 || position > 1) {
        return { error: 'Enter a position between 0 (edge start) and 1 (edge end).' };
      }
      return { type, offset: null, rotateX: null, rotateY: null, rotateZ: null, position };
    }
    const numbers: (number | null)[] = [];
    const fields: [string, HTMLInputElement][] = [
      ['offset', this.offsetInput],
      ['X rotation', this.rotationInputs[0]],
      ['Y rotation', this.rotationInputs[1]],
      ['Z rotation', this.rotationInputs[2]],
    ];
    for (const [label, input] of fields) {
      const text = input.value.trim();
      if (text === '') {
        numbers.push(null);
        continue;
      }
      const value = parseFloat(text);
      if (!Number.isFinite(value)) {
        return { error: `Enter a valid number for the ${label}.` };
      }
      numbers.push(value === 0 ? null : value);
    }
    return {
      type,
      offset: type === 'offset' ? numbers[0] : null,
      rotateX: numbers[1],
      rotateY: numbers[2],
      rotateZ: numbers[3],
      position: null,
    };
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

  private syncType(): void {
    const type = this.planeType;
    this.basesSlot.setLabel(type === 'mid' ? 'Bases' : type === 'edge' ? 'Edge' : 'Base');
    this.basesSlot.setMultiple(type === 'mid');
    this.offsetRow.classList.toggle('hidden', type !== 'offset');
    this.offsetRow.classList.toggle('flex', type === 'offset');
    this.positionRow.classList.toggle('hidden', type !== 'edge');
    this.positionRow.classList.toggle('flex', type === 'edge');
    this.rotationRow.classList.toggle('hidden', type === 'edge');
  }
}
