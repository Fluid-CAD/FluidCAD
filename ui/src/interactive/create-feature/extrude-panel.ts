import { OpTabs, ThinControl } from './panel-controls';
import { FeaturePanel } from './feature-panel';
import { SketchProfileOption } from './sketch-profiles';
import { SketchSlotControl, SketchSlotSelection } from './sketch-slot';
import { EntitySlotControl, EntitySlotSelection } from './entity-slot';
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
export class ExtrudePanel extends FeaturePanel {
  /** The face chip's ✕ — the service owns the picked entity. */
  onRemoveFace?: () => void;

  private tabs: OpTabs;
  private thin: ThinControl;
  private profileSlot: SketchSlotControl;
  private faceSlot: EntitySlotControl;
  private faceSlotWrap: HTMLElement;
  private directionSelect: HTMLSelectElement;
  private distanceWrap: HTMLElement;
  private distanceLabel: HTMLElement;
  private distanceInput: HTMLInputElement;
  private distance2Wrap: HTMLElement;
  private throughWrap: HTMLElement;
  private throughCheckbox: HTMLInputElement;
  private distanceField: ExpressionField;
  private distance2Field: ExpressionField;
  private draftField: ExpressionField;
  private drillCheckbox: HTMLInputElement;

  constructor(container: HTMLElement) {
    super(container, {
      id: 'fluidcad-extrude-panel',
      title: 'Extrude',
      icon: '/icons/extrude.png',
      bodyHtml: `
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
      `,
    });

    this.tabs = new OpTabs(this.role('tabs'), [
      { op: 'add', label: 'Add', title: 'Fuse the extrusion with the model — extrude()' },
      { op: 'remove', label: 'Remove', title: 'Cut the extrusion out of the model — cut()' },
      { op: 'new', label: 'New', title: 'Keep the extrusion as a separate body — extrude().new()' },
    ]);
    this.tabs.onChange = () => {
      this.syncControls();
      this.onChange?.();
    };
    this.thin = new ThinControl(this.role('thin-host'));
    this.thin.onChange = () => this.onChange?.();
    this.thin.onSubmit = () => this.onApply?.();

    this.profileSlot = new SketchSlotControl(this.role('profile-slot'));
    this.profileSlot.onChange = () => this.onChange?.();

    this.faceSlotWrap = this.role('face-slot-wrap');
    this.faceSlot = new EntitySlotControl(this.role('face-slot'), {
      label: 'Up to face',
      prompt: 'Pick a face',
    });
    // The slot is the live pick target the whole time it is shown.
    this.faceSlot.setArmed(true);
    this.faceSlot.onRemove = () => this.onRemoveFace?.();

    this.directionSelect = this.role('direction');
    this.distanceWrap = this.role('distance-wrap');
    this.distanceLabel = this.role('distance-label');
    this.distanceInput = this.role('distance');
    this.distance2Wrap = this.role('distance2-wrap');
    this.throughWrap = this.role('through-wrap');
    this.throughCheckbox = this.role('through');
    this.drillCheckbox = this.role('drill');

    this.directionSelect.addEventListener('change', () => {
      this.syncControls();
      this.onChange?.();
    });
    this.throughCheckbox.addEventListener('change', () => {
      this.syncControls();
      this.onChange?.();
    });
    this.drillCheckbox.addEventListener('change', () => this.onChange?.());
    this.distanceField = this.enhance('distance');
    this.distance2Field = this.enhance('distance2');
    this.draftField = this.enhance('draft');
  }

  /** The variables the fields' dropdowns offer (thin thickness included). */
  setScopeVariables(variables: VariableInfo[]): void {
    this.distanceField.setVariables(variables);
    this.distance2Field.setVariables(variables);
    this.draftField.setVariables(variables);
    this.thin.setVariables(variables);
  }

  show(options: SketchProfileOption[]): void {
    // A fresh arming starts from defaults — the previous session's choice
    // would otherwise be revived by source-line matching. The slot opens on
    // the first offered sketch (the active one, in sketch mode).
    this.faceSlot.reset();
    this.shell.setTitle(null);
    this.profileSlot.reset(options);
    this.syncProfileArmed();
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
    profileLabel: string | null;
    toFaceLabel: string | null;
  }): void {
    this.faceSlot.seedKeep(state.toFaceLabel);
    this.profileSlot.seedKeep(state.profileLabel);
    this.syncProfileArmed();
    this.shell.setTitle('Edit extrude');
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

  /**
   * Refresh the offered sketches after a re-render, keeping the current
   * choice when the same sketch is still offered (matched by kind + source
   * location — scene ids change every render). A choice that vanished falls
   * back to the "Current: …" chip in edit mode, or to the pick prompt.
   */
  setOptions(options: SketchProfileOption[]): void {
    this.profileSlot.setOptions(options);
    this.syncProfileArmed();
  }

  selectedOption(): SketchProfileOption | null {
    return this.profileSlot.selectedOption();
  }

  /** The profile slot's state, `keep` included (edit mode only). */
  profileSelection(): SketchSlotSelection | null {
    return this.profileSlot.selection();
  }

  /** Programmatic profile choice (a timeline pick); no change event fires. */
  selectProfile(index: number): void {
    this.profileSlot.selectIndex(index);
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
    this.faceSlot.setChip(label);
  }

  /** The face slot's state, `keep` included (edit mode only). */
  faceSelection(): EntitySlotSelection | null {
    return this.faceSlot.selection();
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

  private get direction(): ExtrudeDirection {
    return this.directionSelect.value as ExtrudeDirection;
  }

  /** The slot is the live pick target whenever there is anything to pick. */
  private syncProfileArmed(): void {
    this.profileSlot.setArmed(this.profileSlot.editMode || this.profileSlot.options.length > 0);
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
