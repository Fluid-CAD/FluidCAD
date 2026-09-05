import { FeaturePanel } from './create-feature/feature-panel';
import { AxisSelection, AxisSlotControl } from './create-feature/axis-slot';
import { PickSlot, PickSlotChip } from './pick-slot';

/** The slot picks land in — the one last clicked (the 2D copy's idiom). */
export type SketchMirrorArmedSlot = 'targets' | 'axis';

/**
 * The mirror-line slot's state: one of the sketch's own axes (a viewport
 * click on the X or Y datum line, the `standard` kind), a picked sketch line
 * (the service owns the entity), or — edit mode only — the statement's own
 * axis expression kept verbatim. The axis-statement kind is never offered
 * here (a top-level `axis()` cannot bind into a sketch body).
 */
export type SketchMirrorAxisSelection = Exclude<AxisSelection, { kind: 'axis' }>;

/** How a kept `xAxis()` / `yAxis()` axis text reads back as its button. */
const LOCAL_KEEP_MATCHER = /^([xy])Axis\(\s*\)$/;

/**
 * The in-sketch mirror dialog: the geometry slot — filled from the sketch
 * selection, one chip per picked edge, any pick standing for its whole
 * producing primitive — and the Mirror line slot. No numbers and no quick
 * buttons: a mirror is its line and its targets, and the line is picked in
 * the viewport — a sketch line (a `.guide()` included) or one of the
 * sketch's own datum axes, the latter emitted as `xAxis()` / `yAxis()`.
 * Exactly one slot is ARMED at a time — clicked to activate, marked by the
 * primary border — and the sketch picks land in it: the Geometry slot
 * collects targets, the armed line slot takes ONE pick to reflect across.
 * Pure DOM + form state — the service owns the selection, the picked
 * entity, previews, and the apply call.
 */
export class SketchMirrorPanel extends FeaturePanel {
  /** The target chip at `index` was removed. */
  onRemoveTarget?: (index: number) => void;
  /** The line slot left edge mode (✕, a local-axis pick) — drop its entity. */
  onAxisModeChange?: () => void;
  /** The armed slot changed — the service re-aims the picking. */
  onArmedSlotChange?: () => void;

  /** The slot picks land in — the one last clicked. */
  armedSlot: SketchMirrorArmedSlot = 'targets';

  private targetsSlot: PickSlot;
  private axisSlot: AxisSlotControl;

  constructor(container: HTMLElement) {
    super(container, {
      id: 'fluidcad-sketch-mirror-panel',
      title: 'Mirror',
      icon: '/icons/mirror2d.png',
      exitLabel: 'Cancel',
      bodyHtml: `
        <div data-role="targets-slot"></div>
        <div data-role="axis-slot"></div>
        <div data-role="axis-buttons"></div>
      `,
    });

    this.targetsSlot = new PickSlot(this.role('targets-slot'), { label: 'Geometry', multiple: true });
    this.targetsSlot.onArm = () => this.armSlot('targets');
    this.targetsSlot.onRemove = (index) => this.onRemoveTarget?.(index);

    // No quick buttons: the sketch's own axes are picked in the viewport
    // like any line, and land on the slot's standard chip.
    this.axisSlot = new AxisSlotControl(
      this.role('axis-slot'),
      this.role('axis-buttons'),
      {
        label: 'Mirror line',
        axes: [],
        keepAxes: ['x', 'y'],
        chipLabel: (axis) => `Sketch ${axis.toUpperCase()} axis`,
        buttonTitle: () => '',
        keepMatcher: LOCAL_KEEP_MATCHER,
        prompt: 'Pick a sketch line or axis to mirror across',
      },
    );
    this.axisSlot.onArm = () => this.armSlot('axis');
    this.axisSlot.onModeChange = () => this.onAxisModeChange?.();
    this.axisSlot.onChange = () => this.onChange?.();
  }

  show(): void {
    // A fresh arming starts from an empty geometry list and an empty line slot.
    this.shell.setTitle(null);
    this.axisSlot.reset();
    this.setTargets([], null);
    // The empty geometry list is the first thing to fill — its slot opens
    // armed, taking sketch picks right away.
    this.armSlot('targets');
    this.shell.show();
  }

  /**
   * Open prefilled from an existing statement (edit mode). The line slot
   * starts on a "Current: …" chip keeping the statement's own expression
   * verbatim (an `xAxis()` reads as its Sketch X chip). The targets slot is
   * seeded by the service.
   */
  showEdit(state: {
    /** Keep-chip label: the statement's own axis text. */
    axisLabel: string;
  }): void {
    this.shell.setTitle('Edit mirror');
    this.axisSlot.seedKeep(state.axisLabel);
    this.setTargets([], null);
    // The targets list is the seeded statement's — its slot opens armed like
    // create mode, ready to re-pick geometry.
    this.armSlot('targets');
    this.shell.show();
  }

  /**
   * Render the target chips — numbered, the mirror's argument order — or,
   * with none, the keep chip / prompt the service passes.
   */
  setTargets(chips: PickSlotChip[], prompt: string | null): void {
    this.targetsSlot.setChips(chips);
    this.targetsSlot.setPrompt(prompt);
  }

  axisSelection(): SketchMirrorAxisSelection | null {
    const selection = this.axisSlot.selection;
    // The axis-statement kind is never offered, so it never reads back.
    return selection?.kind === 'axis' ? null : selection;
  }

  /**
   * The picked-line chip (the service owns the entity); null clears it —
   * back to the statement's own axis (edit mode), else the prompt.
   */
  setAxisEdgeChip(label: string | null): void {
    this.axisSlot.setEdgeChip(label);
  }

  /** A viewport click on the sketch's X or Y datum axis; no events fire. */
  selectDatumAxis(axis: 'x' | 'y'): void {
    this.axisSlot.selectStandard(axis);
  }

  /**
   * Arm one slot: it wears the primary border and the sketch picks land in
   * it — the armed Geometry slot collects targets, the armed line slot takes
   * one sketch line. The service re-aims on every actual change.
   */
  armSlot(slot: SketchMirrorArmedSlot): void {
    const changed = this.armedSlot !== slot;
    this.armedSlot = slot;
    this.targetsSlot.setArmed(slot === 'targets');
    this.axisSlot.setArmed(slot === 'axis');
    if (changed) {
      this.onArmedSlotChange?.();
    }
  }
}
