import { FeaturePanel } from '../create-feature/feature-panel';
import { PickSlot } from '../pick-slot';
import type { AssemblyRelationType } from '../../api';
import { iconUrl } from '../../ui/icon-url';
import { sceneUnit } from '../../units/scene-unit';

/** Which of the two mate slots picks land in. */
export type RelationSlotKey = 'a' | 'b';

/** Validated field values, or the message to show when a field is invalid. */
export type RelationValues =
  | { type: AssemblyRelationType; ratio: number; reverse: boolean }
  | { error: string };

export const RELATION_TYPE_LABELS: Record<AssemblyRelationType, string> = {
  'gear': 'Gear',
  'rack-and-pinion': 'Rack and pinion',
};

/** An existing relation's values seeding the edit dialog. */
export type RelationSeed = { ratio: number; reverse: boolean };

/**
 * The relation dialog: the type dropdown (Gear / Rack and pinion), the two
 * mate slots — filled from the Joints panel's rows or by clicking a part in
 * the viewport — the ratio field (turns per turn, or travel per revolution)
 * and the Reverse checkbox. Pure DOM + form state — the service owns the
 * picks, the solver preview and the apply call.
 */
export class RelationPanel extends FeaturePanel {
  /** A picked chip's ✕ — the service drops that side's mate. */
  onRemoveMate?: (slot: RelationSlotKey) => void;

  private typeSelect: HTMLSelectElement;
  private slots: Record<RelationSlotKey, PickSlot>;
  private chips: Record<RelationSlotKey, string | null> = { a: null, b: null };
  private armedSlot: RelationSlotKey = 'a';
  private ratioLabel: HTMLSpanElement;
  private ratioInput: HTMLInputElement;
  private ratioUnit: HTMLSpanElement;
  private reverseInput: HTMLInputElement;

  constructor(container: HTMLElement) {
    super(container, {
      id: 'fluidcad-relation-panel',
      title: 'Gear relation',
      icon: iconUrl('relation-gear'),
      bodyHtml: `
        <label class="flex flex-col gap-1.5" title="What the relation couples: two rotations, or a rotation and a slide">
          <span class="text-base-content/70">Type</span>
          <select data-role="relation-type" class="select select-sm select-bordered w-full text-xs">
            ${(Object.keys(RELATION_TYPE_LABELS) as AssemblyRelationType[])
              .map(t => `<option value="${t}">${RELATION_TYPE_LABELS[t]}</option>`)
              .join('')}
          </select>
        </label>
        <div data-role="slot-a"></div>
        <div data-role="slot-b"></div>
        <label class="flex flex-col gap-1.5" data-role="ratio-row">
          <span class="text-base-content/70"><span data-role="ratio-label">Ratio</span> <span data-role="ratio-unit" class="text-base-content/40"></span></span>
          <input data-role="ratio" type="number" step="any" min="0" placeholder="1"
            class="input input-sm input-bordered w-full text-xs" />
        </label>
        <label class="flex items-center gap-2 cursor-pointer"
          title="Run the second mate against the first's sense — two external gears on parallel axes counter-rotate">
          <input data-role="reverse" type="checkbox" class="checkbox checkbox-xs" />
          <span class="text-base-content/70">Reverse</span>
        </label>
      `,
    });

    this.typeSelect = this.role<HTMLSelectElement>('relation-type');
    this.typeSelect.addEventListener('change', () => {
      this.syncType();
      this.onChange?.();
    });
    this.slots = {
      a: new PickSlot(this.role('slot-a'), { label: 'Mate A', multiple: false }),
      b: new PickSlot(this.role('slot-b'), { label: 'Mate B', multiple: false }),
    };
    for (const key of ['a', 'b'] as const) {
      this.slots[key].onArm = () => this.armSlot(key);
      this.slots[key].onRemove = () => this.onRemoveMate?.(key);
    }
    this.ratioLabel = this.role<HTMLSpanElement>('ratio-label');
    this.ratioUnit = this.role<HTMLSpanElement>('ratio-unit');
    this.ratioInput = this.role<HTMLInputElement>('ratio');
    this.ratioInput.addEventListener('input', () => this.onChange?.());
    this.ratioInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.onApply?.();
      }
    });
    this.reverseInput = this.role<HTMLInputElement>('reverse');
    this.reverseInput.addEventListener('change', () => this.onChange?.());
  }

  /**
   * Fresh arming: empty slots (A armed) and the given type. Without a seed
   * the fields reset (create mode); with one they take an existing
   * relation's values and the title flips to edit (the service seeds the
   * slot chips itself, after this returns).
   */
  show(type: AssemblyRelationType, seed?: RelationSeed): void {
    this.shell.setTitle(seed ? 'Edit relation' : `${RELATION_TYPE_LABELS[type]} relation`);
    this.typeSelect.value = type;
    this.chips = { a: null, b: null };
    this.ratioInput.value = seed ? String(seed.ratio) : '';
    this.reverseInput.checked = seed?.reverse ?? false;
    this.syncType();
    this.armSlot('a');
    this.shell.show();
  }

  getType(): AssemblyRelationType {
    return this.typeSelect.value as AssemblyRelationType;
  }

  /** Switch the dropdown (a second toolbar button clicked while open). */
  setType(type: AssemblyRelationType): void {
    if (this.typeSelect.value === type) {
      return;
    }
    this.typeSelect.value = type;
    this.shell.setTitle(`${RELATION_TYPE_LABELS[type]} relation`);
    this.syncType();
  }

  /** The picked chip for one slot (the service owns the pick); null clears back to the prompt. */
  setSlotChip(slot: RelationSlotKey, label: string | null): void {
    this.chips[slot] = label;
    this.renderSlot(slot);
  }

  /** Aim picks at a slot: the armed border moves, the other slot relaxes. */
  armSlot(slot: RelationSlotKey): void {
    this.armedSlot = slot;
    this.slots.a.setArmed(slot === 'a');
    this.slots.b.setArmed(slot === 'b');
  }

  getArmedSlot(): RelationSlotKey {
    return this.armedSlot;
  }

  values(): RelationValues {
    const type = this.getType();
    const raw = this.ratioInput.value.trim();
    const ratio = raw === '' ? 1 : Number(raw);
    if (!Number.isFinite(ratio)) {
      return { error: type === 'gear' ? 'The ratio must be a number.' : 'The travel per revolution must be a number.' };
    }
    if (ratio <= 0) {
      return {
        error: type === 'gear'
          ? 'The ratio must be positive — tick Reverse to turn the second gear the other way.'
          : 'The travel per revolution must be positive — tick Reverse to run the rack the other way.',
      };
    }
    return { type, ratio, reverse: this.reverseInput.checked };
  }

  /** Per-type labels: what each slot takes and what the number means. */
  private syncType(): void {
    const gear = this.getType() === 'gear';
    this.slots.a.setLabel(gear ? 'Mate A (revolute or cylindrical)' : 'Pinion mate (revolute or cylindrical)');
    this.slots.b.setLabel(gear ? 'Mate B (revolute or cylindrical)' : 'Rack mate (slider or cylindrical)');
    this.ratioLabel.textContent = gear ? 'Ratio' : 'Travel per revolution';
    this.ratioUnit.textContent = gear ? '(turns of B per turn of A)' : `(${sceneUnit.current} along the rack)`;
    this.ratioInput.title = gear
      ? 'How many turns mate B makes for each turn of mate A — the tooth count of A over the tooth count of B'
      : 'How far the rack travels for one full turn of the pinion — the pinion\'s pitch circumference';
    this.renderSlot('a');
    this.renderSlot('b');
  }

  private renderSlot(slot: RelationSlotKey): void {
    const chip = this.chips[slot];
    if (chip !== null) {
      this.slots[slot].setChips([{ label: chip, badge: '●', removable: true }]);
      this.slots[slot].setPrompt(null);
    } else {
      this.slots[slot].setChips([]);
      this.slots[slot].setPrompt('Click a joint in the Joints panel, or a part in 3D');
    }
  }
}
