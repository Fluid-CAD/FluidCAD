import { PanelShell } from './panel-controls';
import { PickSlot, PickSlotChip } from '../pick-slot';
import { NewVariable, ValueExpr } from '../../api';
import { ExpressionField, collectNewVariables } from '../../ui/expression-field';
import { VariableInfo } from '../../ui/expression-core';

export type PlaneType = 'offset' | 'mid' | 'edge';

/** Validated form values, or the message to show when a field is invalid. */
export type PlaneValues =
  | {
      type: PlaneType;
      offset: ValueExpr | null;
      rotateX: ValueExpr | null;
      rotateY: ValueExpr | null;
      rotateZ: ValueExpr | null;
      position: ValueExpr | null;
      newVariables?: NewVariable[];
    }
  | { error: string };

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
  private offsetField: ExpressionField;
  private positionRow: HTMLElement;
  private positionField: ExpressionField;
  private rotationRow: HTMLElement;
  private rotationFields: ExpressionField[] = [];
  private applyBtn: HTMLButtonElement;

  constructor(container: HTMLElement) {
    this.shell = new PanelShell(container, 'fluidcad-plane-panel', 'Plane', '/icons/plane.png');
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
    this.positionRow = this.shell.body.querySelector('[data-role="position-row"]')!;
    this.rotationRow = this.shell.body.querySelector('[data-role="rotation-row"]')!;
    this.applyBtn = this.shell.body.querySelector('[data-role="apply"]')!;

    this.typeSelect.addEventListener('change', () => {
      this.syncType();
      this.onTypeChange?.();
      this.onChange?.();
    });

    // Expression fields own the inputs' keyboard handling (variable dropdown,
    // Enter-to-apply) and flip them to type="text" for identifiers.
    this.offsetField = new ExpressionField(
      this.shell.body.querySelector<HTMLInputElement>('[data-role="offset"]')!);
    this.positionField = new ExpressionField(
      this.shell.body.querySelector<HTMLInputElement>('[data-role="position"]')!);
    this.rotationFields = ['x', 'y', 'z'].map(axis => new ExpressionField(
      this.shell.body.querySelector<HTMLInputElement>(`[data-role="rotate-${axis}"]`)!));
    for (const field of [this.offsetField, this.positionField, ...this.rotationFields]) {
      field.onSubmit = () => this.onApply?.();
      field.element.addEventListener('input', () => this.onChange?.());
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
    this.offsetField.setValue(10);
    this.positionField.setValue(0.5);
    for (const field of this.rotationFields) {
      field.setValue(0);
    }
    this.setBases([]);
    this.syncType();
    this.shell.show();
  }

  /** The variables the fields' dropdowns offer. */
  setScopeVariables(variables: VariableInfo[]): void {
    for (const field of [this.offsetField, this.positionField, ...this.rotationFields]) {
      field.setVariables(variables);
    }
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
  setBases(chips: PickSlotChip[]): void {
    const numbered = this.capacity > 1;
    this.basesSlot.setChips(chips.map((chip, index) => ({
      ...chip,
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
      const read = this.positionField.read();
      if ('error' in read
        || (typeof read.value === 'number' && (read.value < 0 || read.value > 1))) {
        return { error: 'Enter a position between 0 (edge start) and 1 (edge end).' };
      }
      return {
        type, offset: null, rotateX: null, rotateY: null, rotateZ: null,
        position: read.value,
        newVariables: collectNewVariables([read]),
      };
    }
    const numbers: (ValueExpr | null)[] = [];
    const reads: ({ newVariable?: NewVariable } | null)[] = [];
    const fields: [string, ExpressionField][] = [
      ['offset', this.offsetField],
      ['X rotation', this.rotationFields[0]],
      ['Y rotation', this.rotationFields[1]],
      ['Z rotation', this.rotationFields[2]],
    ];
    for (const [label, field] of fields) {
      const read = field.read();
      if ('error' in read) {
        if (read.error === 'empty') {
          numbers.push(null);
          continue;
        }
        return { error: `Enter a valid number for the ${label}. ${read.error}.` };
      }
      reads.push(read);
      numbers.push(read.value === 0 ? null : read.value);
    }
    return {
      type,
      offset: type === 'offset' ? numbers[0] : null,
      rotateX: numbers[1],
      rotateY: numbers[2],
      rotateZ: numbers[3],
      position: null,
      newVariables: collectNewVariables(reads),
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
