import { FeaturePanel } from './feature-panel';
import { FeatureOp, OpTabs } from './panel-controls';
import { PlaneOption } from './plane-bases';
import { PlaneSelection, PlaneSlotControl } from './plane-slot';
import { PickSlot, PickSlotChip } from '../pick-slot';

/** The slot picks land in — the one last clicked (the sweep/loft idiom). */
export type MirrorArmedSlot = 'targets' | 'plane';

/** Validated form values — the mirror carries no numeric fields at all. */
export type MirrorValues = {
  op: FeatureOp;
};

/**
 * The mirror dialog: an Add / Remove / New tab row (how the reflected bodies
 * land — fused, cut, or standalone), the solids slot — filled from
 * whole-solid viewport picks (any face or edge click selects the owning
 * solid) or timeline rows, one numbered chip per solid being mirrored — and
 * the plane slot (an origin-plane quad, a plane feature, or a picked face —
 * the repeat mirror's exact picker). Exactly one slot is ARMED at a time —
 * clicked to activate, marked by the primary border — and the viewer's pick
 * channels follow it: the armed Solids slot takes whole-shape picks, the
 * armed Plane slot takes faces, plane quads and the origin planes shown as
 * pick targets. Pure DOM + form state — the service owns scene data, the
 * picked entities, previews, and the apply call.
 */
export class MirrorPanel extends FeaturePanel {
  /** The target chip at `index` was removed. */
  onRemoveTarget?: (index: number) => void;
  /** The plane slot left face mode (✕, a standard/plane pick) — drop the entity. */
  onPlaneModeChange?: () => void;
  /** The armed slot changed — the service re-aims the viewer pick channels. */
  onArmedSlotChange?: () => void;

  /** The slot picks land in — the one last clicked. */
  armedSlot: MirrorArmedSlot = 'targets';

  private tabs: OpTabs;
  private targetsSlot: PickSlot;
  private planeSlot: PlaneSlotControl;

  constructor(container: HTMLElement) {
    super(container, {
      id: 'fluidcad-mirror-panel',
      title: 'Mirror',
      icon: '/icons/mirror.png',
      bodyHtml: `
        <div data-role="tabs" class="join w-full"></div>
        <div data-role="targets-slot"></div>
        <div data-role="plane-slot"></div>
      `,
    });

    this.tabs = new OpTabs(this.role('tabs'), [
      { op: 'add', label: 'Add', title: 'Fuse the mirrored bodies with the scene — mirror()' },
      { op: 'remove', label: 'Remove', title: 'Cut the mirrored bodies out of the scene — mirror().remove()' },
      { op: 'new', label: 'New', title: 'Keep the mirrored bodies as separate solids — mirror().new()' },
    ]);
    this.tabs.onChange = () => this.onChange?.();

    this.targetsSlot = new PickSlot(this.role('targets-slot'), { label: 'Solids', multiple: true });
    this.targetsSlot.onArm = () => this.armSlot('targets');
    this.targetsSlot.onRemove = (index) => this.onRemoveTarget?.(index);

    this.planeSlot = new PlaneSlotControl(this.role('plane-slot'));
    this.planeSlot.onArm = () => this.armSlot('plane');
    this.planeSlot.onModeChange = () => this.onPlaneModeChange?.();
    this.planeSlot.onChange = () => this.onChange?.();
  }

  show(): void {
    // A fresh arming starts from defaults and empty slots — the previous
    // session's choices would otherwise be revived by source-line matching.
    this.shell.setTitle(null);
    this.tabs.setOp('add');
    this.planeSlot.reset();
    this.setTargets([]);
    // The empty solids list is the first thing to fill — its slot opens
    // armed, taking whole-shape picks right away.
    this.armSlot('targets');
    this.shell.show();
  }

  /**
   * Open prefilled from an existing statement (edit mode). The plane slot
   * starts on a "Current: …" chip keeping the statement's own expression
   * verbatim (an origin-plane literal reads as the standard selection
   * itself); re-sourcing is live and a re-picked chip's ✕ reverts to the
   * kept expression. The targets slot is seeded by the service.
   */
  showEdit(state: {
    op: FeatureOp;
    /** Keep-chip label for the statement's mirror plane. */
    planeLabel: string;
  }): void {
    this.shell.setTitle('Edit mirror');
    this.tabs.setOp(state.op);
    this.planeSlot.seedKeep(state.planeLabel);
    this.setTargets([]);
    // The targets list is the seeded statement's — its slot opens armed like
    // create mode, ready to toggle solids in the viewport.
    this.armSlot('targets');
    this.shell.show();
  }

  /**
   * Refresh the offered plane statements after a re-render, keeping the
   * current choice when the same statement is still offered (matched by
   * source location — scene ids change every render). A choice that vanished
   * falls back to the statement's own plane in edit mode, or the prompt.
   */
  setOptions(planes: PlaneOption[]): void {
    this.planeSlot.setOptions(planes);
  }

  /** Render the target chips — numbered, the mirror's argument order. */
  setTargets(chips: PickSlotChip[]): void {
    this.targetsSlot.setChips(chips.map((chip, index) => ({
      ...chip,
      badge: String(index + 1),
      removable: true,
    })));
    this.targetsSlot.setPrompt(chips.length > 0 ? null : 'Pick solids in the viewport');
  }

  planeSelection(): PlaneSelection | null {
    return this.planeSlot.selection;
  }

  /**
   * A plane feature picked in 3D or the timeline; arms the plane slot so the
   * border tracks where the pick landed. No change event fires.
   */
  selectPlane(option: PlaneOption): void {
    this.planeSlot.selectOption(option);
    this.armSlot('plane');
  }

  /** An origin-plane quad picked in the viewport. No change event fires. */
  selectStandardPlane(plane: 'xy' | 'xz' | 'yz'): void {
    this.planeSlot.selectStandard(plane);
    this.armSlot('plane');
  }

  /**
   * The plane slot's picked-face chip (the service owns the entity); null
   * clears it — back to the statement's own plane (edit mode), else the
   * prompt.
   */
  setPlaneFaceChip(label: string | null): void {
    this.planeSlot.setFaceChip(label);
  }

  values(): MirrorValues {
    return { op: this.tabs.op };
  }

  /**
   * Arm one slot: it wears the primary border and the viewer's pick channels
   * follow it. The service re-aims the channels on every actual change.
   */
  armSlot(slot: MirrorArmedSlot): void {
    const changed = this.armedSlot !== slot;
    this.armedSlot = slot;
    this.targetsSlot.setArmed(slot === 'targets');
    this.planeSlot.setArmed(slot === 'plane');
    if (changed) {
      this.onArmedSlotChange?.();
    }
  }
}
