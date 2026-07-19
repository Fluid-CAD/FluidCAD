import { OpTabs, PanelShell, ThinControl } from './panel-controls';
import { SketchProfileOption, sourceChip } from './sketch-profiles';
import { PickSlot } from '../pick-slot';
import { ExtrudeOptionValues, ValueExpr } from '../../api';
import { ExpressionField, collectNewVariables } from '../../ui/expression-field';
import { VariableInfo } from '../../ui/expression-core';

/** How the extrusion distributes around the sketch plane. */
export type ExtrudeDirection = 'one' | 'symmetric' | 'two' | 'to-face';

/** Validated form values, or the message to show when a field is invalid. */
export type ExtrudeValues = ExtrudeOptionValues | { error: string };

/**
 * The extrude dialog: an Add / Remove / New tab row (the boolean operation),
 * the profile pick slot (a single chip — filled by clicking a sketch in the
 * timeline or its wires in 3D), the direction mode (one direction, symmetric,
 * two distances, or up to a face), the distance fields (through-all on the
 * Remove tab disables them; the up-to-face mode replaces them with a face
 * pick slot), a draft angle, a drill-holes toggle, and a thin() toggle
 * with its thickness. Pure DOM + form state — the service owns scene data,
 * previews, and the apply call.
 */
export class ExtrudePanel {
  onChange?: () => void;
  onApply?: () => void;
  onExit?: () => void;
  /** The face chip's ✕ — the service owns the picked entity. */
  onRemoveFace?: () => void;

  private shell: PanelShell;
  private tabs: OpTabs;
  private thin: ThinControl;
  private profileSlot: PickSlot;
  private faceSlot: PickSlot;
  private faceSlotWrap: HTMLElement;
  private directionSelect: HTMLSelectElement;
  private distanceWrap: HTMLElement;
  private distanceLabel: HTMLElement;
  private distanceInput: HTMLInputElement;
  private distance2Wrap: HTMLElement;
  private distance2Input: HTMLInputElement;
  private throughWrap: HTMLElement;
  private throughCheckbox: HTMLInputElement;
  private draftInput: HTMLInputElement;
  private distanceField: ExpressionField;
  private distance2Field: ExpressionField;
  private draftField: ExpressionField;
  private drillCheckbox: HTMLInputElement;
  private applyBtn: HTMLButtonElement;
  /** Picked-face chip label (the service owns the entity), or null. */
  private pickedFaceLabel: string | null = null;
  /** Edit mode: the statement's own target text — the face slot's keep chip. */
  private keepFaceLabel = '';
  private options: SketchProfileOption[] = [];
  /** The profile slot's state: an option index, the keep entry, or empty. */
  private selection: number | 'keep' | null = null;
  /** Edit mode: the slot starts on a "Current: …" chip that keeps the statement's profile. */
  private editMode = false;
  private keepProfileLabel = '';

  constructor(container: HTMLElement) {
    this.shell = new PanelShell(container, 'fluidcad-extrude-panel', 'Extrude mode', '/icons/extrude.png');
    this.shell.onEscape = () => this.onExit?.();
    this.shell.body.insertAdjacentHTML('beforeend', `
      <div data-role="tabs" class="join w-full"></div>
      <div data-role="profile-slot"></div>
      <label class="flex flex-col gap-1.5" title="How the extrusion distributes around the sketch plane">
        <span class="text-base-content/70">Direction</span>
        <select data-role="direction" class="select select-sm select-bordered w-full text-xs">
          <option value="one">One direction</option>
          <option value="symmetric">Symmetric</option>
          <option value="two">Two directions</option>
          <option value="to-face">Up to face</option>
        </select>
      </label>
      <div data-role="face-slot-wrap" class="hidden"><div data-role="face-slot"></div></div>
      <label data-role="distance-wrap" class="flex flex-col gap-1.5">
        <span class="text-base-content/70" data-role="distance-label">Distance</span>
        <input data-role="distance" type="number" step="0.5" value="25"
          class="input input-sm input-bordered w-full text-xs" />
      </label>
      <label data-role="distance2-wrap" class="hidden flex-col gap-1.5"
        title="Extrusion distance on the opposite side of the sketch plane">
        <span class="text-base-content/70" data-role="distance2-label">Distance 2</span>
        <input data-role="distance2" type="number" step="0.5" value="25"
          class="input input-sm input-bordered w-full text-xs" />
      </label>
      <label data-role="through-wrap" class="hidden items-center justify-between cursor-pointer">
        <span class="text-base-content/70">Through all</span>
        <input data-role="through" type="checkbox" class="toggle toggle-sm toggle-primary" />
      </label>
      <label class="flex flex-col gap-1.5"
        title="Taper the side walls — positive expands outward, negative tapers inward; 0 is straight">
        <span class="text-base-content/70">Draft angle (°)</span>
        <input data-role="draft" type="number" step="0.5" value="0"
          class="input input-sm input-bordered w-full text-xs" />
      </label>
      <label class="flex items-center justify-between cursor-pointer"
        title="Treat inner closed regions of the profile as holes — off extrudes them solid">
        <span class="text-base-content/70">Drill holes</span>
        <input data-role="drill" type="checkbox" class="toggle toggle-sm toggle-primary" checked />
      </label>
      <div data-role="thin-host" class="contents"></div>
      <div class="flex items-center gap-2 pt-1">
        <button data-role="apply" class="btn btn-primary btn-sm flex-1">Apply</button>
        <button data-role="exit" class="btn btn-ghost btn-sm">Exit</button>
      </div>
    `);

    this.tabs = new OpTabs(this.shell.body.querySelector('[data-role="tabs"]')!, [
      { op: 'add', label: 'Add', title: 'Fuse the extrusion with the model — extrude()' },
      { op: 'remove', label: 'Remove', title: 'Cut the extrusion out of the model — cut()' },
      { op: 'new', label: 'New', title: 'Keep the extrusion as a separate body — extrude().new()' },
    ]);
    this.tabs.onChange = () => {
      this.syncControls();
      this.onChange?.();
    };
    this.thin = new ThinControl(this.shell.body.querySelector('[data-role="thin-host"]')!);
    this.thin.onChange = () => this.onChange?.();
    this.thin.onSubmit = () => this.onApply?.();

    this.profileSlot = new PickSlot(
      this.shell.body.querySelector('[data-role="profile-slot"]')!,
      { label: 'Sketch', multiple: false },
    );
    this.profileSlot.onRemove = () => {
      // Create mode: back to the prompt; edit mode: back to the statement's
      // own profile (a re-pick is undone, never the profile itself).
      this.selection = this.editMode ? 'keep' : null;
      this.renderProfile();
      this.onChange?.();
    };

    this.faceSlotWrap = this.shell.body.querySelector('[data-role="face-slot-wrap"]')!;
    this.faceSlot = new PickSlot(
      this.shell.body.querySelector('[data-role="face-slot"]')!,
      { label: 'Up to face', multiple: false },
    );
    this.faceSlot.onRemove = () => this.onRemoveFace?.();

    this.directionSelect = this.shell.body.querySelector('[data-role="direction"]')!;
    this.distanceWrap = this.shell.body.querySelector('[data-role="distance-wrap"]')!;
    this.distanceLabel = this.shell.body.querySelector('[data-role="distance-label"]')!;
    this.distanceInput = this.shell.body.querySelector('[data-role="distance"]')!;
    this.distance2Wrap = this.shell.body.querySelector('[data-role="distance2-wrap"]')!;
    this.distance2Input = this.shell.body.querySelector('[data-role="distance2"]')!;
    this.throughWrap = this.shell.body.querySelector('[data-role="through-wrap"]')!;
    this.throughCheckbox = this.shell.body.querySelector('[data-role="through"]')!;
    this.draftInput = this.shell.body.querySelector('[data-role="draft"]')!;
    this.drillCheckbox = this.shell.body.querySelector('[data-role="drill"]')!;
    this.applyBtn = this.shell.body.querySelector('[data-role="apply"]')!;

    this.applyBtn.addEventListener('click', () => this.onApply?.());
    this.shell.body.querySelector('[data-role="exit"]')!.addEventListener('click', () => this.onExit?.());
    this.directionSelect.addEventListener('change', () => {
      this.syncControls();
      this.onChange?.();
    });
    this.throughCheckbox.addEventListener('change', () => {
      this.syncControls();
      this.onChange?.();
    });
    this.drillCheckbox.addEventListener('change', () => this.onChange?.());
    // Expression fields own the inputs' keyboard handling (variable dropdown,
    // Enter-to-apply) and flip them to type="text" for identifiers.
    this.distanceField = new ExpressionField(this.distanceInput);
    this.distance2Field = new ExpressionField(this.distance2Input);
    this.draftField = new ExpressionField(this.draftInput);
    for (const field of [this.distanceField, this.distance2Field, this.draftField]) {
      field.onSubmit = () => this.onApply?.();
      field.element.addEventListener('input', () => this.onChange?.());
    }
  }

  /** The variables the fields' dropdowns offer (thin thickness included). */
  setScopeVariables(variables: VariableInfo[]): void {
    this.distanceField.setVariables(variables);
    this.distance2Field.setVariables(variables);
    this.draftField.setVariables(variables);
    this.thin.setVariables(variables);
  }

  get isVisible(): boolean {
    return this.shell.isVisible;
  }

  show(options: SketchProfileOption[]): void {
    // A fresh arming starts from defaults — the previous session's choice
    // would otherwise be revived by source-line matching. The slot opens on
    // the first offered sketch (the active one, in sketch mode).
    this.options = [];
    this.selection = null;
    this.editMode = false;
    this.keepFaceLabel = '';
    this.setFaceChip(null);
    this.shell.setTitle(null);
    this.setOptions(options);
    if (this.selection === null && options.length > 0) {
      this.selection = 0;
      this.renderProfile();
    }
    this.syncControls();
    this.shell.show();
  }

  /**
   * Open prefilled from an existing statement (edit mode). The profile slot
   * starts on a "Current: …" chip that keeps the statement's own profile
   * verbatim; picking another sketch re-sources it (its ✕ reverts to the
   * kept profile). A to-face statement opens on the "Up to face" direction
   * with its target on the same kind of keep chip — picking a face in 3D
   * re-sources it. The op tabs, direction, distances, through-all, draft,
   * drill and thin controls edit in place.
   */
  showEdit(state: ExtrudeOptionValues & {
    thin: [ValueExpr] | null;
    profileLabel: string;
    toFaceLabel: string | null;
  }): void {
    this.options = [];
    this.selection = 'keep';
    this.editMode = true;
    this.keepFaceLabel = state.toFaceLabel ?? '';
    this.setFaceChip(null);
    this.keepProfileLabel = state.profileLabel;
    this.shell.setTitle('Edit extrude');
    this.setOptions([]);
    this.tabs.setOp(state.op);
    this.directionSelect.value = directionOf(state);
    if (state.distance !== null) {
      this.distanceField.setValue(state.distance);
    }
    if (state.distance2 !== null) {
      this.distance2Field.setValue(state.distance2);
    }
    // A to-face statement has no distance, but it is not a through-all.
    this.throughCheckbox.checked = state.distance === null && state.toFaceLabel === null;
    this.draftField.setValue(state.draft ?? 0);
    this.drillCheckbox.checked = state.drill;
    this.thin.setValues(state.thin);
    this.syncControls();
    this.shell.show();
  }

  hide(): void {
    this.shell.hide();
  }

  /**
   * Refresh the offered sketches after a re-render, keeping the current
   * choice when the same sketch is still offered (matched by kind + source
   * location — scene ids change every render). A choice that vanished falls
   * back to the "Current: …" chip in edit mode, or to the pick prompt.
   */
  setOptions(options: SketchProfileOption[]): void {
    const previous = this.profileSelection();
    this.options = options;
    if (previous?.kind === 'sketch') {
      const prev = previous.option;
      const match = options.findIndex(o => o.kind === prev.kind
        && (o.kind === 'active' || (o.filePath === prev.filePath && o.line === prev.line)));
      this.selection = match >= 0 ? match : this.editMode ? 'keep' : null;
    } else if (previous?.kind === 'keep') {
      this.selection = 'keep';
    } else {
      this.selection = null;
    }
    this.renderProfile();
  }

  selectedOption(): SketchProfileOption | null {
    const selection = this.profileSelection();
    return selection?.kind === 'sketch' ? selection.option : null;
  }

  /** The profile slot's state, `keep` included (edit mode only). */
  profileSelection(): { kind: 'keep' } | { kind: 'sketch'; option: SketchProfileOption } | null {
    if (this.selection === 'keep') {
      return this.editMode ? { kind: 'keep' } : null;
    }
    const option = this.selection !== null ? this.options[this.selection] : undefined;
    return option ? { kind: 'sketch', option } : null;
  }

  /** Programmatic profile choice (a timeline pick); no change event fires. */
  selectProfile(index: number): void {
    if (this.options[index]) {
      this.selection = index;
      this.renderProfile();
    }
  }

  /** The up-to-face direction mode is selected. */
  isToFace(): boolean {
    return this.direction === 'to-face';
  }

  /**
   * The face slot's picked chip (the service owns the entity); null clears
   * it — back to the statement's own target (edit mode), else the prompt.
   */
  setFaceChip(label: string | null): void {
    this.pickedFaceLabel = label;
    if (label !== null) {
      this.faceSlot.setChips([{ label, badge: '●', removable: true }]);
      this.faceSlot.setPrompt(null);
    } else if (this.editMode && this.keepFaceLabel) {
      // Edit mode: the statement's own target — a re-pick is undone by ✕,
      // never the target itself (the profile keep-chip contract).
      this.faceSlot.setChips([{
        label: `Current: ${this.keepFaceLabel}`,
        badge: '●',
        removable: false,
      }]);
      this.faceSlot.setPrompt(null);
    } else {
      this.faceSlot.setChips([]);
      this.faceSlot.setPrompt('Pick a face');
    }
    this.faceSlot.setArmed(true);
  }

  /** The face slot's state, `keep` included (edit mode only). */
  faceSelection(): { kind: 'picked' } | { kind: 'keep' } | null {
    if (this.pickedFaceLabel !== null) {
      return { kind: 'picked' };
    }
    if (this.editMode && this.keepFaceLabel) {
      return { kind: 'keep' };
    }
    return null;
  }

  /** The profile slot: one chip (the chosen sketch), or the pick prompt. */
  private renderProfile(): void {
    if (this.selection === 'keep') {
      this.profileSlot.setChips([{
        label: `Last Sketch: ${this.keepProfileLabel}`,
        badge: '●',
        removable: false,
      }]);
      this.profileSlot.setPrompt(null);
    } else {
      const option = this.selection !== null ? this.options[this.selection] : undefined;
      this.profileSlot.setChips(option
        ? [sourceChip(option, { badge: '●', removable: true })]
        : []);
      this.profileSlot.setPrompt(option
        ? null
        : this.options.length > 0 || this.editMode
          ? 'Pick a sketch'
          : 'No sketch — create one first');
    }
    // The slot is the live pick target whenever there is anything to pick.
    this.profileSlot.setArmed(this.editMode || this.options.length > 0);
  }

  values(): ExtrudeValues {
    const op = this.tabs.op;
    const direction = this.direction;
    const throughAll = this.throughAllActive();
    let distance: ValueExpr | null = null;
    let distanceRead: ReturnType<ExpressionField['read']> | null = null;
    if (direction === 'to-face') {
      if (this.faceSelection() === null) {
        return { error: 'Pick the face to extrude up to.' };
      }
    } else if (!throughAll) {
      distanceRead = this.distanceField.read();
      if ('error' in distanceRead || (typeof distanceRead.value === 'number' && distanceRead.value === 0)) {
        const detail = 'error' in distanceRead && distanceRead.error !== 'empty' ? ` ${distanceRead.error}.` : '';
        return { error: `Enter a nonzero ${op === 'remove' ? 'depth' : 'distance'}.${detail}` };
      }
      distance = distanceRead.value;
    }
    let distance2: ValueExpr | null = null;
    let distance2Read: ReturnType<ExpressionField['read']> | null = null;
    if (direction === 'two') {
      distance2Read = this.distance2Field.read();
      if ('error' in distance2Read || (typeof distance2Read.value === 'number' && distance2Read.value === 0)) {
        const detail = 'error' in distance2Read && distance2Read.error !== 'empty' ? ` ${distance2Read.error}.` : '';
        return { error: `Enter a nonzero second distance.${detail}` };
      }
      distance2 = distance2Read.value;
    }
    const draftRead = this.draftField.read();
    if ('error' in draftRead && draftRead.error !== 'empty') {
      return { error: `Draft angle: ${draftRead.error}.` };
    }
    const draft = 'error' in draftRead ? 0 : draftRead.value;
    const thin = this.thin.values();
    if ('error' in thin) {
      return thin;
    }
    const reads = [distanceRead, distance2Read, draftRead, thin];
    return {
      op,
      distance,
      distance2,
      symmetric: direction === 'symmetric',
      draft: draft === 0 ? null : draft,
      drill: this.drillCheckbox.checked,
      thin: thin.thin,
      newVariables: collectNewVariables(reads.map(r => r && !('error' in r) ? r : null)),
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

  private get direction(): ExtrudeDirection {
    return this.directionSelect.value as ExtrudeDirection;
  }

  /** Through-all is a Remove option; a two-distance form has explicit depths. */
  private throughAllActive(): boolean {
    return this.tabs.op === 'remove' && this.direction !== 'two' && this.direction !== 'to-face'
      && this.throughCheckbox.checked;
  }

  /**
   * Per-op and per-direction control states: the second distance belongs to
   * the two-directions mode, through-all to one-direction/symmetric on the
   * Remove tab (where it parks the depth), the up-to-face mode swaps every
   * distance control for its face pick slot, and labels follow the mode.
   */
  private syncControls(): void {
    const removing = this.tabs.op === 'remove';
    const direction = this.direction;
    const toFace = direction === 'to-face';
    const noun = removing ? 'Depth' : 'Distance';
    this.distanceLabel.textContent = direction === 'two'
      ? `${noun} 1`
      : direction === 'symmetric' ? `Total ${noun.toLowerCase()}` : noun;
    this.faceSlotWrap.classList.toggle('hidden', !toFace);
    this.distanceWrap.classList.toggle('hidden', toFace);
    this.distanceWrap.classList.toggle('flex', !toFace);
    this.distance2Wrap.classList.toggle('hidden', direction !== 'two');
    this.distance2Wrap.classList.toggle('flex', direction === 'two');
    const throughOffered = removing && direction !== 'two' && !toFace;
    this.throughWrap.classList.toggle('hidden', !throughOffered);
    this.throughWrap.classList.toggle('flex', throughOffered);
    this.distanceInput.disabled = this.throughAllActive();
  }
}

/** The direction mode a parsed statement's options imply. */
function directionOf(state: {
  distance2: ValueExpr | null;
  symmetric: boolean;
  toFaceLabel: string | null;
}): ExtrudeDirection {
  if (state.toFaceLabel !== null) {
    return 'to-face';
  }
  if (state.distance2 !== null) {
    return 'two';
  }
  return state.symmetric ? 'symmetric' : 'one';
}
