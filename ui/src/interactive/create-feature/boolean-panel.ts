import { FeaturePanel } from './feature-panel';
import { ChoiceTabs } from './panel-controls';
import { PickSlot, PickSlotChip } from '../pick-slot';
import { BooleanKind } from '../../api';

/** The slot picks land in — subtract splits into base and tool. */
export type BooleanArmedSlot = 'targets' | 'base' | 'tool';

/**
 * The boolean dialog: a Fuse / Subtract / Common tab row (the operation —
 * each writes its own callee) over the solid slots. Fuse and Common show one
 * multi-chip Solids slot, filled from whole-solid viewport picks (any face
 * or edge click selects the owning solid) or timeline rows, one numbered
 * chip per solid in argument order. Subtract shows a Base and a Tool slot —
 * one solid each, `subtract(base, tool)`. Exactly one slot is ARMED at a
 * time — clicked to activate, marked by the primary border (the sweep/loft
 * idiom) — and picks land there. Pure DOM state — the service owns scene
 * data, the chosen targets, and the apply call.
 */
export class BooleanPanel extends FeaturePanel {
  /** The operation tab changed — the service re-shapes its target list. */
  onKindChange?: () => void;
  /** The chip at `index` was removed (base = 0, tool = 1 on subtract). */
  onRemoveTarget?: (index: number) => void;
  /** The armed slot changed — the service repaints the armed highlight. */
  onArmedSlotChange?: () => void;

  /** The slot picks land in — the one last clicked. */
  armedSlot: BooleanArmedSlot = 'targets';

  private tabs: ChoiceTabs<BooleanKind>;
  private targetsSlot: PickSlot;
  private baseSlot: PickSlot;
  private toolSlot: PickSlot;
  private baseWrap: HTMLElement;
  private toolWrap: HTMLElement;
  private targetsWrap: HTMLElement;
  /** The last chip list the service handed over (re-rendered on tab switch). */
  private chips: (PickSlotChip | null)[] = [];

  constructor(container: HTMLElement) {
    super(container, {
      id: 'fluidcad-boolean-panel',
      title: 'Boolean',
      icon: '/icons/fuse.png',
      bodyHtml: `
        <div data-role="tabs" class="join w-full"></div>
        <div data-role="targets-slot"></div>
        <div data-role="base-slot" class="hidden"></div>
        <div data-role="tool-slot" class="hidden"></div>
      `,
    });

    this.tabs = new ChoiceTabs<BooleanKind>(this.role('tabs'), [
      { key: 'fuse', label: 'Fuse', title: "Merge the solids into one — fuse(a, b)" },
      { key: 'subtract', label: 'Subtract', title: "Remove the tool from the base — subtract(base, tool)" },
      { key: 'common', label: 'Common', title: "Keep only the shared volume — common(a, b)" },
    ], 'fuse');
    this.tabs.onChange = () => {
      this.syncKind();
      this.onKindChange?.();
      this.onChange?.();
    };

    this.targetsWrap = this.role('targets-slot');
    this.targetsSlot = new PickSlot(this.targetsWrap, { label: 'Solids', multiple: true });
    this.targetsSlot.onArm = () => this.armSlot('targets');
    this.targetsSlot.onRemove = (index) => this.onRemoveTarget?.(index);

    this.baseWrap = this.role('base-slot');
    this.baseSlot = new PickSlot(this.baseWrap, { label: 'Base', multiple: false });
    this.baseSlot.onArm = () => this.armSlot('base');
    this.baseSlot.onRemove = () => this.onRemoveTarget?.(0);

    this.toolWrap = this.role('tool-slot');
    this.toolSlot = new PickSlot(this.toolWrap, { label: 'Tool', multiple: false });
    this.toolSlot.onArm = () => this.armSlot('tool');
    this.toolSlot.onRemove = () => this.onRemoveTarget?.(1);
  }

  get kind(): BooleanKind {
    return this.tabs.value;
  }

  show(): void {
    // A fresh arming starts from the fuse tab and empty slots.
    this.shell.setTitle(null);
    this.tabs.setValue('fuse');
    this.setTargets([]);
    // The empty solids list is the first thing to fill — its slot opens
    // armed, taking whole-shape picks right away.
    this.armSlot('targets');
    this.syncKind();
    this.shell.show();
  }

  /**
   * Open prefilled from an existing statement (edit mode). The tab is the
   * statement's own callee; the target chips are seeded by the service (one
   * kept chip per statement target), toggled and re-picked like create mode.
   */
  showEdit(kind: BooleanKind): void {
    this.shell.setTitle(`Edit ${kind}`);
    this.tabs.setValue(kind);
    this.setTargets([]);
    this.armSlot(kind === 'subtract' ? 'base' : 'targets');
    this.syncKind();
    this.shell.show();
  }

  /**
   * Render the target chips — the operation's argument order. Fuse/Common
   * number them into the one Solids slot; Subtract routes index 0 to Base
   * and index 1 to Tool (either may be an empty hole mid-composition).
   */
  setTargets(chips: (PickSlotChip | null)[]): void {
    this.chips = chips;
    const dense = chips.filter((chip): chip is PickSlotChip => chip !== null);
    this.targetsSlot.setChips(dense.map((chip, index) => ({
      ...chip,
      badge: String(index + 1),
      removable: true,
    })));
    this.targetsSlot.setPrompt(dense.length > 0 ? null : 'Pick solids in the viewport');
    const base = chips[0] ?? null;
    const tool = chips[1] ?? null;
    this.baseSlot.setChips(base ? [{ ...base, removable: true }] : []);
    this.baseSlot.setPrompt(base ? null : 'Pick the base solid');
    this.toolSlot.setChips(tool ? [{ ...tool, removable: true }] : []);
    this.toolSlot.setPrompt(tool ? null : 'Pick the solid to subtract');
  }

  /**
   * Arm one slot: it wears the primary border and the next whole-solid pick
   * lands there. Subtract slots are addressed; the fuse/common Solids slot
   * toggles membership instead.
   */
  armSlot(slot: BooleanArmedSlot): void {
    const changed = this.armedSlot !== slot;
    this.armedSlot = slot;
    this.targetsSlot.setArmed(slot === 'targets');
    this.baseSlot.setArmed(slot === 'base');
    this.toolSlot.setArmed(slot === 'tool');
    if (changed) {
      this.onArmedSlotChange?.();
    }
  }

  /** Show the slots the current operation takes; keep the armed slot valid. */
  private syncKind(): void {
    const subtract = this.kind === 'subtract';
    this.targetsWrap.classList.toggle('hidden', subtract);
    this.baseWrap.classList.toggle('hidden', !subtract);
    this.toolWrap.classList.toggle('hidden', !subtract);
    if (subtract && this.armedSlot === 'targets') {
      // Entering subtract: the next pick fills the first empty slot.
      this.armSlot(this.chips[0] ? (this.chips[1] ? 'base' : 'tool') : 'base');
    } else if (!subtract && this.armedSlot !== 'targets') {
      this.armSlot('targets');
    }
  }
}
