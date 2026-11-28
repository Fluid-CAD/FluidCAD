import { OpTabs, ThinControl } from './panel-controls';
import { FlagControl } from './expression-rows';
import { FeaturePanel } from './feature-panel';
import { SketchProfileOption } from './sketch-profiles';
import { ProfileSlotSelection, SketchSlotControl } from './sketch-slot';
import { EntitySlotControl, EntitySlotSelection } from './entity-slot';
import { ScopeSlotControl } from './scope-slot';
import { ExtrudeFaceTarget, ExtrudeOptionValues, ValueExpr } from '../../api';
import { ExpressionField, collectNewVariables } from '../../ui/expression-field';
import { VariableInfo } from '../../ui/expression-core';
import { PickSlotChip } from '../pick-slot';
import { RegionPickControl } from './region-pick-control';
import { iconUrl } from '../../ui/icon-url';

/**
 * How the extrusion distributes around the sketch plane. The last three end
 * the extrusion on a face instead of a distance: a picked one, or the nearest
 * / farthest face it runs into.
 */
export type ExtrudeDirection = 'one' | 'symmetric' | 'two' | 'to-face' | ExtrudeFaceTarget;

/** Validated form values, or the message to show when a field is invalid. */
export type ExtrudeValues = ExtrudeOptionValues | { error: string };

/**
 * The extrude dialog: an Add / Remove / New tab row (the boolean operation),
 * the profile pick slot (a single chip — filled by clicking a sketch in the
 * timeline or its wires in 3D, or a planar face of a solid, which is swept
 * as it stands and so parks the region, drill, thin and through-all
 * controls), the direction mode (one direction, symmetric,
 * two distances, or up to a face — picked, first or last), the distance
 * fields (through-all on the Remove tab disables them; every up-to-face mode
 * replaces them, the picked one with a face pick slot), a draft angle, an end
 * offset that pulls the far end back, a drill-holes toggle, and a thin()
 * toggle with its thickness. Pure DOM + form state — the service owns scene
 * data, previews, and the apply call.
 */
export class ExtrudePanel extends FeaturePanel {
  /** The face chip's ✕ — the service owns the picked entity. */
  onRemoveFace?: () => void;
  /** The scope chip at `index` was removed — the service owns the choices. */
  onRemoveScope?: (index: number) => void;
  /**
   * A slot took the viewport — the service re-aims its pick channels, and
   * ends region picking unless it was the profile slot (the regions are the
   * profile's own). Fires when a slot is clicked and when the direction
   * enters the picked up-to-face mode, but only when that changes who owns
   * the viewport (another slot, or region picking).
   */
  onArmedPickChange?: () => void;

  /**
   * Which slot face clicks in the viewport land in: the profile (the face
   * to extrude), the up-to-face target, or the scope list (the face's whole
   * solid). The profile slot is the default; entering the picked up-to-face
   * direction hands the clicks to its target, and clicking a slot moves the
   * border.
   */
  private armedSolidSlot: 'profile' | 'face' | 'scope' = 'profile';
  /**
   * Edit mode: the statement's own profile is a face (the sources query
   * resolved it) — the kept chip parks the same controls a picked face does.
   */
  private keptProfileIsFace = false;
  /**
   * Region picking holds the viewport (the service mirrors its picker's
   * state here). The solid slots draw quiet until one of them claims the
   * viewport back — a click, or the direction entering the picked
   * up-to-face mode.
   */
  private regionPickLive = false;

  private tabs: OpTabs;
  private thin: ThinControl;
  private profileSlot: SketchSlotControl;
  private faceSlot: EntitySlotControl;
  private faceSlotWrap: HTMLElement;
  private scopeSlot: ScopeSlotControl;
  private directionSelect: HTMLSelectElement;
  private distanceWrap: HTMLElement;
  private distanceLabel: HTMLElement;
  private distanceInput: HTMLInputElement;
  private distance2Wrap: HTMLElement;
  private throughWrap: HTMLElement;
  private throughCheckbox: HTMLInputElement;
  private drillWrap: HTMLElement;
  private distanceField: ExpressionField;
  private distance2Field: ExpressionField;
  private draftField: ExpressionField;
  private endOffsetInput: HTMLInputElement;
  private endOffsetField: ExpressionField;
  private drill: FlagControl;

  constructor(container: HTMLElement) {
    super(container, {
      id: 'fluidcad-extrude-panel',
      title: 'Extrude',
      icon: iconUrl('extrude'),
      bodyHtml: `
        <div data-role="tabs" class="join w-full"></div>
        <div data-role="profile-slot"></div>
        <label class="flex flex-col gap-1.5"
          title="How the extrusion distributes around the sketch plane, or the face it stops on">
          <span class="text-base-content/70">Direction</span>
          <select data-role="direction" class="select select-sm select-bordered w-full text-xs">
            <option value="one">One direction</option>
            <option value="symmetric">Symmetric</option>
            <option value="two">Two directions</option>
            <option value="to-face">Up to face</option>
            <option value="first-face" title="Stop at the nearest face the extrusion runs into">Up to first face</option>
            <option value="last-face" title="Stop at the farthest face the extrusion runs into">Up to last face</option>
          </select>
        </label>
        <div data-role="face-slot-wrap" class="hidden"><div data-role="face-slot"></div></div>
        <label data-role="distance-wrap" class="flex flex-col gap-1.5">
          <span class="text-base-content/70" data-role="distance-label">Distance</span>
          <input data-role="distance" data-unit="length" type="number" step="0.5" value="25"
            class="input input-sm input-bordered w-full text-xs" />
        </label>
        <label data-role="distance2-wrap" class="hidden flex-col gap-1.5"
          title="Extrusion distance on the opposite side of the sketch plane">
          <span class="text-base-content/70" data-role="distance2-label">Distance 2</span>
          <input data-role="distance2" data-unit="length" type="number" step="0.5" value="25"
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
        <label class="flex flex-col gap-1.5"
          title="Pull the far end back by this much — positive stops short of the distance (or the target face), negative overshoots it">
          <span class="text-base-content/70">End offset</span>
          <input data-role="end-offset" data-unit="length" type="number" step="0.5" placeholder="0"
            class="input input-sm input-bordered w-full text-xs" />
        </label>
        <label data-role="drill-wrap" class="flex items-center justify-between cursor-pointer"
          title="Treat inner closed regions of the profile as holes — off extrudes them solid">
          <span class="text-base-content/70">Drill holes</span>
          <input data-role="drill" type="checkbox" class="toggle toggle-sm toggle-primary" checked />
        </label>
        <div data-role="thin-host" class="contents"></div>
        <div data-role="scope-slot"></div>
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

    this.profileSlot = new SketchSlotControl(this.role('profile-slot'), { regions: true, faces: true });
    this.profileSlot.onChange = () => {
      // The ✕ can swap a picked face back for a sketch — the parked controls return.
      this.syncControls();
      this.onChange?.();
    };
    this.profileSlot.onArm = () => this.armSolidSlot('profile');

    this.faceSlotWrap = this.role('face-slot-wrap');
    this.faceSlot = new EntitySlotControl(this.role('face-slot'), {
      label: 'Up to face',
      prompt: 'Pick a face',
    });
    this.faceSlot.onRemove = () => this.onRemoveFace?.();
    this.faceSlot.onArm = () => this.armSolidSlot('face');

    this.scopeSlot = new ScopeSlotControl(this.role('scope-slot'));
    this.scopeSlot.onRemove = (index) => this.onRemoveScope?.(index);
    this.scopeSlot.onArm = () => this.armSolidSlot('scope');

    this.directionSelect = this.role('direction');
    this.distanceWrap = this.role('distance-wrap');
    this.distanceLabel = this.role('distance-label');
    this.distanceInput = this.role('distance');
    this.distance2Wrap = this.role('distance2-wrap');
    this.throughWrap = this.role('through-wrap');
    this.throughCheckbox = this.role('through');
    this.drillWrap = this.role('drill-wrap');
    this.endOffsetInput = this.role('end-offset');
    // The drill-holes toggle takes an expression (`drill(flag)`) under its ƒ.
    this.drill = new FlagControl(this.role('drill'), { name: 'drill', label: 'Drill holes' });

    this.directionSelect.addEventListener('change', () => {
      // Entering the picked up-to-face mode arms its slot — the next face
      // click is the target, not a scope solid or a region.
      if (this.isToFace()) {
        this.armSolidSlot('face');
      }
      this.syncControls();
      this.onChange?.();
    });
    this.throughCheckbox.addEventListener('change', () => {
      this.syncControls();
      this.onChange?.();
    });
    this.drill.onChange = () => this.onChange?.();
    this.drill.onSubmit = () => this.onApply?.();
    this.distanceField = this.enhance('distance');
    this.distance2Field = this.enhance('distance2');
    this.draftField = this.enhance('draft');
    this.endOffsetField = this.enhance('end-offset');
  }

  /** The variables the fields' dropdowns offer (thin thickness included). */
  setScopeVariables(variables: VariableInfo[]): void {
    this.distanceField.setVariables(variables);
    this.distance2Field.setVariables(variables);
    this.draftField.setVariables(variables);
    this.endOffsetField.setVariables(variables);
    this.drill.setVariables(variables);
    this.thin.setVariables(variables);
  }

  show(options: SketchProfileOption[]): void {
    // A fresh arming starts from defaults — the previous session's choices
    // (its slot picks AND its form values) would otherwise carry over. The
    // slot opens on the first offered sketch (the active one, in sketch mode).
    this.faceSlot.reset();
    this.armedSolidSlot = 'profile';
    this.keptProfileIsFace = false;
    this.scopeSlot.setChips([]);
    this.shell.setTitle(null);
    this.tabs.reset();
    this.directionSelect.value = 'one';
    this.distanceField.setValue(25);
    this.distance2Field.setValue(25);
    this.throughCheckbox.checked = false;
    this.draftField.setValue(0);
    this.endOffsetField.setValue('');
    this.drill.setValue(true);
    this.thin.reset();
    this.profileSlot.reset(options);
    this.syncControls();
    this.shell.show();
  }

  /**
   * Open prefilled from an existing statement (edit mode). The profile slot
   * starts on a "Current: …" chip that keeps the statement's own profile
   * verbatim; picking another sketch — or a face — re-sources it (its ✕
   * reverts to the kept profile). A picked-face statement opens on the "Up to face"
   * direction with its target on the same kind of keep chip — picking a face
   * in 3D re-sources it; a first/last-face statement opens on its own
   * direction, which carries no target to keep. The op tabs, direction,
   * distances, through-all, draft, end offset, drill and thin controls edit
   * in place.
   */
  showEdit(state: ExtrudeOptionValues & {
    thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
    profileLabel: string | null;
    toFaceLabel: string | null;
    toFaceKind: 'selector' | ExtrudeFaceTarget | null;
  }): void {
    // Only a picked face is a keep-able target: switching a first/last-face
    // statement to "Up to face" must ask for a pick, not re-emit the literal.
    this.faceSlot.seedKeep(state.toFaceKind === 'selector' ? state.toFaceLabel : null);
    // A profile argument that is not a bare variable is a face selector
    // (`e.endFaces()`, `select(…)`) — the sources query confirms it.
    this.keptProfileIsFace = false;
    this.profileSlot.seedKeep(state.profileLabel, state.profileLabel !== null && !IDENTIFIER.test(state.profileLabel));
    this.shell.setTitle('Edit extrude');
    this.tabs.setOp(state.op);
    this.directionSelect.value = directionOf(state);
    // A picked-target statement opens on its target slot, as its direction does.
    this.armedSolidSlot = this.isToFace() ? 'face' : 'profile';
    // A distance the statement doesn't carry (up-to-face, through-all,
    // one-direction) seeds the create default — switching the direction
    // mid-edit must not reveal a previous session's value.
    this.distanceField.setValue(state.distance ?? 25);
    this.distance2Field.setValue(state.distance2 ?? 25);
    // An up-to-face statement has no distance, but it is not a through-all.
    this.throughCheckbox.checked = state.distance === null && state.toFaceKind === null;
    this.draftField.setValue(state.draft ?? 0);
    // No chain means no pull-back — an empty field, not a literal 0, so
    // leaving it untouched re-emits the statement without one.
    this.endOffsetField.setValue(state.endOffset ?? '');
    this.drill.setValue(state.drill);
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
    this.syncControls();
  }

  selectedOption(): SketchProfileOption | null {
    return this.profileSlot.selectedOption();
  }

  /** The region row under the profile slot — the service drives it. */
  get regionControl(): RegionPickControl {
    return this.profileSlot.regions!;
  }

  /** The profile slot's state — `keep` (edit mode only) and a picked face included. */
  profileSelection(): ProfileSlotSelection | null {
    return this.profileSlot.profileSelection();
  }

  /** Programmatic profile choice (a timeline pick); no change event fires. */
  selectProfile(index: number): void {
    this.profileSlot.selectIndex(index);
    this.syncControls();
  }

  /**
   * The profile slot's picked-face chip (the service owns the entity); null
   * drops it — back to the sketch it replaced, the statement's own profile
   * (edit mode), or the prompt. No change event fires.
   */
  setProfileFace(label: string | null): void {
    if (label === null) {
      this.profileSlot.clearFace();
    } else {
      this.profileSlot.selectFace(label);
    }
    this.syncControls();
  }

  /**
   * Edit mode: whether the statement's own profile turned out to be a face
   * (the sources query resolved it to face picks, not a sketch).
   */
  setKeptProfileIsFace(isFace: boolean): void {
    if (this.keptProfileIsFace === isFace) {
      return;
    }
    this.keptProfileIsFace = isFace;
    this.syncControls();
  }

  /**
   * The profile is a face — a picked one, or the edited statement's own. A
   * face is swept as it stands: no regions, no inner loops to drill, no thin
   * wall to offset, and no through-all form.
   */
  profileIsFace(): boolean {
    const selection = this.profileSlot.profileSelection();
    return selection?.kind === 'face' || (selection?.kind === 'keep' && this.keptProfileIsFace);
  }

  /** Face clicks in the viewport pick the profile — its slot holds the border. */
  get profilePickArmed(): boolean {
    return this.armedSolidSlot === 'profile';
  }

  /** The picked up-to-face direction mode is selected (the one that picks). */
  isToFace(): boolean {
    return this.direction === 'to-face';
  }

  /**
   * The literal up-to-face target the direction selects, or null — the picked
   * mode and the distance modes both resolve their end elsewhere.
   */
  faceTarget(): ExtrudeFaceTarget | null {
    const direction = this.direction;
    return direction === 'first-face' || direction === 'last-face' ? direction : null;
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

  /** The boolean operation tab — gates the scope section (New writes none). */
  get op(): 'add' | 'remove' | 'new' {
    return this.tabs.op;
  }

  /** The scope chips (the service owns the choices). */
  setScopeChips(chips: PickSlotChip[]): void {
    this.scopeSlot.setChips(chips);
  }

  /** Whole-solid viewport picks land in the scope list, not the face slot. */
  get scopePickArmed(): boolean {
    return this.scopeSlot.visible && this.armedSolidSlot === 'scope';
  }

  /**
   * Region picking turned on or off in the viewport. While it is on, the
   * solid slots wear no armed border — their clicks would go nowhere.
   */
  setRegionPickLive(live: boolean): void {
    if (this.regionPickLive === live) {
      return;
    }
    this.regionPickLive = live;
    this.syncControls();
  }

  /**
   * A slot claims the viewport (a click, or the direction entering the
   * picked up-to-face mode): move the armed border and tell the service to
   * re-aim its pick channels. Nothing fires when the slot already owns the
   * viewport — the same slot, with no region pick in the way.
   */
  private armSolidSlot(slot: 'profile' | 'face' | 'scope'): void {
    // Region picking belongs to the profile slot: a click there (the region
    // row sits inside it) takes nothing back from a live region pick.
    if (this.armedSolidSlot === slot && (slot === 'profile' || !this.regionPickLive)) {
      return;
    }
    this.armedSolidSlot = slot;
    this.syncControls();
    this.onArmedPickChange?.();
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
    } else if (!isFaceBounded(direction) && !throughAll) {
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
    // A through-all cut has no end to pull back — the field is disabled there,
    // and its value stays out of the statement.
    let endOffsetRead: ReturnType<ExpressionField['read']> | null = null;
    let endOffset: ValueExpr = 0;
    if (!throughAll) {
      endOffsetRead = this.endOffsetField.read();
      if ('error' in endOffsetRead && endOffsetRead.error !== 'empty') {
        return { error: `End offset: ${endOffsetRead.error}.` };
      }
      endOffset = 'error' in endOffsetRead ? 0 : endOffsetRead.value;
    }
    const thin = this.thin.values();
    if ('error' in thin) {
      return thin;
    }
    // The drill toggle is parked under a face profile — its value stays out
    // of the statement, whatever the hidden control holds.
    const drill = this.profileIsFace() ? { value: true } : this.drill.read();
    if ('error' in drill) {
      return drill;
    }
    const reads = [distanceRead, distance2Read, draftRead, endOffsetRead, thin];
    return {
      op,
      distance,
      distance2,
      symmetric: direction === 'symmetric',
      draft: draft === 0 ? null : draft,
      endOffset: endOffset === 0 ? null : endOffset,
      drill: drill.value,
      thin: thin.thin,
      newVariables: collectNewVariables(reads.map(r => r && !('error' in r) ? r : null)),
    };
  }

  private get direction(): ExtrudeDirection {
    return this.directionSelect.value as ExtrudeDirection;
  }

  /**
   * Through-all is a Remove option; a two-distance form has explicit depths,
   * and a face profile has no through-all form at all.
   */
  private throughAllOffered(): boolean {
    return this.tabs.op === 'remove' && this.direction !== 'two' && !isFaceBounded(this.direction)
      && !this.profileIsFace();
  }

  private throughAllActive(): boolean {
    return this.throughAllOffered() && this.throughCheckbox.checked;
  }

  /**
   * Per-op and per-direction control states: the second distance belongs to
   * the two-directions mode, through-all to one-direction/symmetric on the
   * Remove tab (where it parks the depth — and the end offset with it, since
   * the cut runs past everything), the up-to-face modes drop every distance
   * control — the picked one for its face pick slot, first/last-face for
   * nothing at all — and labels follow the mode.
   */
  private syncControls(): void {
    const removing = this.tabs.op === 'remove';
    const direction = this.direction;
    const toFace = direction === 'to-face';
    const faceBounded = isFaceBounded(direction);
    const noun = removing ? 'Depth' : 'Distance';
    this.distanceLabel.textContent = direction === 'two'
      ? `${noun} 1`
      : direction === 'symmetric' ? `Total ${noun.toLowerCase()}` : noun;
    this.faceSlotWrap.classList.toggle('hidden', !toFace);
    this.distanceWrap.classList.toggle('hidden', faceBounded);
    this.distanceWrap.classList.toggle('flex', !faceBounded);
    this.distance2Wrap.classList.toggle('hidden', direction !== 'two');
    this.distance2Wrap.classList.toggle('flex', direction === 'two');
    const throughOffered = this.throughAllOffered();
    this.throughWrap.classList.toggle('hidden', !throughOffered);
    this.throughWrap.classList.toggle('flex', throughOffered);
    this.distanceInput.disabled = this.throughAllActive();
    this.endOffsetInput.disabled = this.throughAllActive();
    // A face profile is swept as it stands: nothing to drill, nothing to
    // offset into a thin wall.
    const faceProfile = this.profileIsFace();
    this.drillWrap.classList.toggle('hidden', faceProfile);
    this.drillWrap.classList.toggle('flex', !faceProfile);
    this.thin.setBlocked(faceProfile, 'A face cannot be extruded thin — pick a sketch as the profile.');
    // A separate body has no boolean to scope; a slot that is not shown
    // hands the armed border on — a hidden scope slot to the target slot
    // when that one is up, and either to the profile slot otherwise.
    this.scopeSlot.setVisible(this.tabs.op !== 'new');
    if (!this.scopeSlot.visible && this.armedSolidSlot === 'scope') {
      this.armedSolidSlot = toFace ? 'face' : 'profile';
    }
    if (!toFace && this.armedSolidSlot === 'face') {
      this.armedSolidSlot = 'profile';
    }
    // A live region pick owns the viewport — neither solid slot is armed,
    // and the profile slot wears the border: the regions are its own.
    const solidArmed = !this.regionPickLive;
    this.profileSlot.setArmed(this.regionPickLive || this.armedSolidSlot === 'profile');
    this.faceSlot.setArmed(solidArmed && toFace && this.armedSolidSlot === 'face');
    this.scopeSlot.setArmed(solidArmed && this.scopeSlot.visible && this.armedSolidSlot === 'scope');
  }
}

/** A bare variable name — what a bound sketch profile reads as. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** The extrusion ends on a face, so it carries no distance of its own. */
function isFaceBounded(direction: ExtrudeDirection): boolean {
  return direction === 'to-face' || direction === 'first-face' || direction === 'last-face';
}

/** The direction mode a parsed statement's options imply. */
function directionOf(state: {
  distance2: ValueExpr | null;
  symmetric: boolean;
  toFaceKind: 'selector' | ExtrudeFaceTarget | null;
}): ExtrudeDirection {
  if (state.toFaceKind !== null) {
    return state.toFaceKind === 'selector' ? 'to-face' : state.toFaceKind;
  }
  if (state.distance2 !== null) {
    return 'two';
  }
  return state.symmetric ? 'symmetric' : 'one';
}
