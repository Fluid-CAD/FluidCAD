import { ChamferKind, ModifyFeatureKind, featureIconImg } from './feature-config';
import { ExpressionRow } from './expression-row';
import { PickSlot, PickSlotChip } from '../pick-slot';
import { ExpressionField } from '../../ui/expression-field';
import { ShellJoinType } from '../../api';
import { viewportChrome } from '../../ui/viewport-chrome';

/**
 * The fillet/chamfer/shell dialog: the title row, the multi-pick selection
 * slot, the value row (radius/distance/thickness), shell's join-type
 * dropdown, Apply/Exit, the expression-transparency row, and the error
 * message. Pure DOM — the service owns the pick set, synthesis, and the
 * apply calls. Docked like the create dialogs (the settings/fit-to-view
 * stack steps aside while it is up).
 */
export class ModifyPanel {
  onApply?: () => void;
  onExit?: () => void;
  /** The value input changed — the service persists it and syncs the prefix. */
  onValueInput?: () => void;
  /** The second-value input changed — the service persists it and syncs the prefix. */
  onValue2Input?: () => void;
  /** The chamfer-type dropdown changed — the service reconfigures the rows. */
  onChamferTypeChange?: () => void;
  /** The join dropdown changed — the service persists it and syncs the suffix. */
  onJoinChange?: () => void;
  /** The chip at `index` asked to be removed. */
  onRemoveChip?: (index: number) => void;
  /** A chip row is hovered (its index) or left (null) — viewport previews. */
  onChipHover?: (index: number | null) => void;

  readonly expression: ExpressionRow;
  readonly valueField: ExpressionField;
  readonly value2Field: ExpressionField;

  private readonly root: HTMLDivElement;
  private readonly titleIcon: HTMLElement;
  private readonly titleText: HTMLElement;
  private readonly valueWrap: HTMLElement;
  private readonly valueLabel: HTMLElement;
  private readonly valueInput: HTMLInputElement;
  private readonly chamferTypeWrap: HTMLElement;
  private readonly chamferTypeSelect: HTMLSelectElement;
  private readonly value2Wrap: HTMLElement;
  private readonly value2Label: HTMLElement;
  private readonly value2Input: HTMLInputElement;
  private readonly joinWrap: HTMLElement;
  private readonly joinSelect: HTMLSelectElement;
  private readonly selectionSlot: PickSlot;
  private readonly applyBtn: HTMLButtonElement;
  private readonly message: HTMLDivElement;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'fluidcad-modify-pick-active';
    // top-[196px] right-4 matches the create-feature dialog: just below the
    // viewport gizmo, in the spot the settings/fit-to-view button stack vacates
    // while a dialog is open (see viewportChrome).
    this.root.className = 'absolute top-[196px] right-4 z-[999] pointer-events-auto hidden';
    this.root.innerHTML = `
      <div data-role="column" class="flex flex-col items-end gap-1.5">
        <div class="flex flex-col items-stretch gap-3.5 w-60 max-h-[calc(100vh-260px)] overflow-y-auto bg-base-100 border border-base-300 text-base-content rounded-lg px-4 py-4 text-xs select-none shadow-md">
          <div class="flex items-center gap-2.5">
            <span class="flex items-center [&>svg]:size-4" data-role="icon"></span>
            <span data-role="title" class="font-medium text-sm">Fillet</span>
          </div>
          <div data-role="selection-slot"></div>
          <label data-role="chamfer-type-wrap" class="flex flex-col gap-1.5 hidden">
            <span class="text-base-content/70">Chamfer type</span>
            <select data-role="chamfer-type" class="select select-sm select-bordered w-full text-xs">
              <option value="equal">Equal distance</option>
              <option value="distances">Two distances</option>
              <option value="angle">Distance + angle</option>
            </select>
          </label>
          <label data-role="value-wrap" class="flex flex-col gap-1.5">
            <span class="text-base-content/70" data-role="value-label">Radius</span>
            <input data-role="value" type="number" step="0.5"
              class="input input-sm input-bordered w-full text-xs" />
          </label>
          <label data-role="value2-wrap" class="flex flex-col gap-1.5 hidden">
            <span class="text-base-content/70" data-role="value2-label">Distance 2</span>
            <input data-role="value2" type="number" step="0.5"
              class="input input-sm input-bordered w-full text-xs" />
          </label>
          <label data-role="join-wrap" class="flex flex-col gap-1.5 hidden">
            <span class="text-base-content/70">Join type</span>
            <select data-role="join" class="select select-sm select-bordered w-full text-xs">
              <option value="arc">Arc</option>
              <option value="intersection">Intersection</option>
              <option value="tangent">Tangent</option>
            </select>
          </label>
          <div class="flex items-center gap-2 pt-1">
            <button data-role="apply" class="btn btn-primary btn-sm flex-1">Apply</button>
            <button data-role="exit" class="btn btn-ghost btn-sm">Exit</button>
          </div>
        </div>
      </div>
    `;
    container.appendChild(this.root);

    const column = this.root.querySelector<HTMLElement>('[data-role="column"]')!;
    this.titleIcon = this.root.querySelector('[data-role="icon"]')!;
    this.titleText = this.root.querySelector('[data-role="title"]')!;
    this.valueWrap = this.root.querySelector('[data-role="value-wrap"]')!;
    this.valueLabel = this.root.querySelector('[data-role="value-label"]')!;
    this.valueInput = this.root.querySelector('[data-role="value"]')!;
    this.chamferTypeWrap = this.root.querySelector('[data-role="chamfer-type-wrap"]')!;
    this.chamferTypeSelect = this.root.querySelector('[data-role="chamfer-type"]')!;
    this.value2Wrap = this.root.querySelector('[data-role="value2-wrap"]')!;
    this.value2Label = this.root.querySelector('[data-role="value2-label"]')!;
    this.value2Input = this.root.querySelector('[data-role="value2"]')!;
    this.joinWrap = this.root.querySelector('[data-role="join-wrap"]')!;
    this.joinSelect = this.root.querySelector('[data-role="join"]')!;
    this.selectionSlot = new PickSlot(
      this.root.querySelector('[data-role="selection-slot"]')!,
      { label: 'Selection', multiple: true },
    );
    // Picking is live the whole time a mode is armed — the slot always wears
    // the pick-target styling.
    this.selectionSlot.setArmed(true);
    this.selectionSlot.onRemove = (index) => this.onRemoveChip?.(index);
    this.selectionSlot.onChipHover = (index) => this.onChipHover?.(index);
    this.applyBtn = this.root.querySelector('[data-role="apply"]')!;

    // The expression row and the message dock under the dialog body.
    this.expression = new ExpressionRow(column);
    this.message = document.createElement('div');
    this.message.className = 'hidden max-w-[380px] bg-error text-error-content rounded-lg px-3 py-2 text-xs leading-snug shadow-md';
    column.appendChild(this.message);

    this.applyBtn.addEventListener('click', () => this.onApply?.());
    this.root.querySelector('[data-role="exit"]')!.addEventListener('click', () => this.onExit?.());
    // The field owns the value input's keyboard handling (variable dropdown,
    // Enter-to-apply) and flips it to type="text" for identifiers.
    this.valueField = new ExpressionField(this.valueInput);
    this.valueField.onSubmit = () => this.onApply?.();
    this.valueInput.addEventListener('input', () => this.onValueInput?.());
    this.value2Field = new ExpressionField(this.value2Input);
    this.value2Field.onSubmit = () => this.onApply?.();
    this.value2Input.addEventListener('input', () => this.onValue2Input?.());
    this.chamferTypeSelect.addEventListener('change', () => this.onChamferTypeChange?.());
    this.joinSelect.addEventListener('change', () => this.onJoinChange?.());
  }

  /**
   * Show/hide the dialog. While it is up the settings/fit-to-view/params
   * button stack steps aside so the dialog can dock under the gizmo.
   */
  setVisible(visible: boolean): void {
    this.root.classList.toggle('hidden', !visible);
    viewportChrome.setDialogOpen(this.root.id, visible);
  }

  setTitle(kind: ModifyFeatureKind, text: string): void {
    this.titleIcon.innerHTML = featureIconImg(kind);
    this.titleText.textContent = text;
  }

  /** The value row's label and range; the row is always shown for pick features. */
  configureValue(label: string, sign: 'positive' | 'nonzero' | null): void {
    this.valueWrap.classList.remove('hidden');
    this.valueLabel.textContent = label;
    if (sign === 'positive') {
      this.valueInput.min = '0.05';
    } else {
      this.valueInput.removeAttribute('min');
    }
  }

  /** The value input's raw text (the expression-prefix mirror). */
  get valueText(): string {
    return this.valueInput.value;
  }

  /** The second-value input's raw text (the expression-prefix mirror). */
  get value2Text(): string {
    return this.value2Input.value;
  }

  /**
   * The chamfer rows: hidden for every other feature (`null`); for chamfer
   * the type dropdown shows `kind`, and the second value row appears for the
   * two-value kinds with its label matching what the slot holds.
   */
  setChamferControls(kind: ChamferKind | null): void {
    this.chamferTypeWrap.classList.toggle('hidden', kind === null);
    this.value2Wrap.classList.toggle('hidden', kind === null || kind === 'equal');
    if (kind === null) {
      return;
    }
    this.chamferTypeSelect.value = kind;
    this.value2Label.textContent = kind === 'angle' ? 'Angle (°)' : 'Distance 2';
    this.value2Input.min = '0.05';
    if (kind === 'angle') {
      this.value2Input.max = '89.9';
    } else {
      this.value2Input.removeAttribute('max');
    }
  }

  /** The chamfer-type dropdown's value while a chamfer dialog is up. */
  get chamferType(): ChamferKind {
    return this.chamferTypeSelect.value as ChamferKind;
  }

  /** Whether the value or args input owns the keyboard (Enter-to-apply). */
  ownsFocus(target: Element | null): boolean {
    return target === this.valueInput || target === this.value2Input
      || target === this.expression.inputElement;
  }

  setJoinVisible(visible: boolean): void {
    this.joinWrap.classList.toggle('hidden', !visible);
  }

  get joinValue(): ShellJoinType {
    return this.joinSelect.value as ShellJoinType;
  }

  set joinValue(value: ShellJoinType) {
    this.joinSelect.value = value;
  }

  setChips(chips: PickSlotChip[]): void {
    this.selectionSlot.setChips(chips);
  }

  setPrompt(text: string | null): void {
    this.selectionSlot.setPrompt(text);
  }

  setApplyEnabled(enabled: boolean): void {
    this.applyBtn.disabled = !enabled;
  }

  setMessage(text: string | null): void {
    if (text) {
      this.message.textContent = text;
      this.message.classList.remove('hidden');
    } else {
      this.message.textContent = '';
      this.message.classList.add('hidden');
    }
  }
}
