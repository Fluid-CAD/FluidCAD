import { FeaturePanel } from '../create-feature/feature-panel';
import { PickSlot } from '../pick-slot';
import type { AssemblyMateType } from '../../api';

/** Which of the two connector slots picks land in. */
export type MateSlotKey = 'a' | 'b';

/** Validated option values, or the message to show when a field is invalid. */
export type MateOptionValues =
  | {
      type: AssemblyMateType;
      flip: boolean;
      rotate: number;
      /** Frame-local offset [x, y, z]; blank fields read as 0. */
      offset: [number, number, number];
      /** Motion limits (slider mm / revolute deg); null when unset. */
      limits: [number, number] | null;
    }
  | { error: string };

const MATE_TYPE_LABELS: Record<AssemblyMateType, string> = {
  'fastened': 'Fastened',
  'revolute': 'Revolute',
  'slider': 'Slider',
  'cylindrical': 'Cylindrical',
  'planar': 'Planar',
  'parallel': 'Parallel',
  'pin-slot': 'Pin-slot',
};

/** Types whose offset must stay on the Z axis (mirrors the kernel's MateBuilder). */
const Z_ONLY_OFFSET = new Set<AssemblyMateType>(['slider', 'cylindrical', 'planar']);
/** Types that support `.limits(min, max)`. */
const LIMIT_TYPES = new Set<AssemblyMateType>(['slider', 'revolute']);

/**
 * An existing mate's option values seeding the edit dialog — the serialized
 * record's `options` shape, absent fields meaning the source omits the call.
 */
export type MateSeedOptions = {
  flip?: boolean;
  rotate?: number;
  offset?: [number, number, number];
  limits?: [number, number];
};

/**
 * The mate dialog: the mate-type dropdown (seeded from the toolbar button
 * that opened it), the two connector slots — filled by clicking connector
 * gizmos in the viewport, each picked chip carrying a pen that opens the
 * connector's own property editor — and the option rows (flip, rotate,
 * offset, limits) with the kernel's per-type rules applied live. Pure DOM +
 * form state — the service owns the picks, the solver preview, and the
 * apply call.
 */
export class MatePanel extends FeaturePanel {
  /** A picked chip's ✕ — the service drops that side's connector. */
  onRemoveConnector?: (slot: MateSlotKey) => void;
  /** A picked chip's pen — the service opens the connector property editor. */
  onEditConnector?: (slot: MateSlotKey) => void;

  private typeSelect: HTMLSelectElement;
  private slots: Record<MateSlotKey, PickSlot>;
  private chipLabels: Record<MateSlotKey, string | null> = { a: null, b: null };
  private armedSlot: MateSlotKey = 'a';
  private flipInput: HTMLInputElement;
  private rotateInput: HTMLInputElement;
  private offsetInputs: [HTMLInputElement, HTMLInputElement, HTMLInputElement];
  private limitsSection: HTMLElement;
  private limitsEnable: HTMLInputElement;
  private limitsUnit: HTMLSpanElement;
  private limitInputs: [HTMLInputElement, HTMLInputElement];

  constructor(container: HTMLElement) {
    super(container, {
      id: 'fluidcad-mate-panel',
      title: 'Mate',
      icon: '/icons/joint-fastened.png',
      bodyHtml: `
        <label class="flex flex-col gap-1.5" title="The joint type — how the two connectors constrain each other">
          <span class="text-base-content/70">Type</span>
          <select data-role="mate-type" class="select select-sm select-bordered w-full text-xs">
            ${(Object.keys(MATE_TYPE_LABELS) as AssemblyMateType[])
              .map(t => `<option value="${t}">${MATE_TYPE_LABELS[t]}</option>`)
              .join('')}
          </select>
        </label>
        <div data-role="slot-a"></div>
        <div data-role="slot-b"></div>
        <label class="flex items-center gap-2 cursor-pointer"
          title="Turn connector B's frame 180° so its Z axis opposes A's">
          <input data-role="flip" type="checkbox" class="checkbox checkbox-xs" />
          <span class="text-base-content/70">Flip</span>
        </label>
        <label class="flex flex-col gap-1.5"
          title="Extra rotation of B about the mate's Z axis, in degrees">
          <span class="text-base-content/70">Rotate (°)</span>
          <input data-role="rotate" type="number" step="any" placeholder="0"
            class="input input-sm input-bordered w-full text-xs" />
        </label>
        <div class="flex flex-col gap-1.5"
          title="Offset between the connector frames — for slider, cylindrical and planar mates only Z is free">
          <span class="text-base-content/70">Offset (X, Y, Z)</span>
          <div class="flex gap-1.5">
            <input data-role="offset-x" type="number" step="any" placeholder="0" title="Along the mate's X axis"
              class="input input-sm input-bordered w-full text-xs" />
            <input data-role="offset-y" type="number" step="any" placeholder="0" title="Along the mate's Y axis"
              class="input input-sm input-bordered w-full text-xs" />
            <input data-role="offset-z" type="number" step="any" placeholder="0" title="Along the mate's Z axis"
              class="input input-sm input-bordered w-full text-xs" />
          </div>
        </div>
        <div data-role="limits-section" class="flex flex-col gap-1.5">
          <label class="flex items-center gap-2 cursor-pointer">
            <input data-role="limits-enable" type="checkbox" class="checkbox checkbox-xs" />
            <span class="text-base-content/70">Limits</span>
            <span data-role="limits-unit" class="text-base-content/40"></span>
          </label>
          <div class="flex gap-1.5">
            <input data-role="limit-min" type="number" step="any" placeholder="min" disabled
              class="input input-sm input-bordered w-full text-xs" />
            <input data-role="limit-max" type="number" step="any" placeholder="max" disabled
              class="input input-sm input-bordered w-full text-xs" />
          </div>
        </div>
      `,
    });

    this.typeSelect = this.role<HTMLSelectElement>('mate-type');
    this.typeSelect.addEventListener('change', () => {
      this.syncTypeConstraints();
      this.onChange?.();
    });

    this.slots = {
      a: new PickSlot(this.role('slot-a'), { label: 'Connector A', multiple: false }),
      b: new PickSlot(this.role('slot-b'), { label: 'Connector B', multiple: false }),
    };
    for (const key of ['a', 'b'] as const) {
      this.slots[key].onArm = () => this.armSlot(key);
      this.slots[key].onRemove = () => this.onRemoveConnector?.(key);
    }

    this.flipInput = this.role<HTMLInputElement>('flip');
    this.flipInput.addEventListener('change', () => this.onChange?.());

    this.rotateInput = this.role<HTMLInputElement>('rotate');
    this.offsetInputs = [
      this.role<HTMLInputElement>('offset-x'),
      this.role<HTMLInputElement>('offset-y'),
      this.role<HTMLInputElement>('offset-z'),
    ];
    for (const input of [this.rotateInput, ...this.offsetInputs]) {
      input.addEventListener('input', () => this.onChange?.());
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.onApply?.();
        }
      });
    }

    this.limitsSection = this.role('limits-section');
    this.limitsEnable = this.role<HTMLInputElement>('limits-enable');
    this.limitsUnit = this.role<HTMLSpanElement>('limits-unit');
    this.limitInputs = [
      this.role<HTMLInputElement>('limit-min'),
      this.role<HTMLInputElement>('limit-max'),
    ];
    this.limitsEnable.addEventListener('change', () => {
      for (const input of this.limitInputs) {
        input.disabled = !this.limitsEnable.checked;
      }
      this.onChange?.();
    });
    for (const input of this.limitInputs) {
      input.addEventListener('input', () => this.onChange?.());
    }
  }

  /**
   * Fresh arming: empty slots (A armed) and the given type. Without a seed
   * the option rows zero out (create mode); with one they take an existing
   * mate's values and the title flips to edit (the service seeds the slot
   * chips itself, after this returns).
   */
  show(type: AssemblyMateType, seed?: MateSeedOptions): void {
    this.shell.setTitle(seed ? 'Edit mate' : `${MATE_TYPE_LABELS[type]} mate`);
    this.typeSelect.value = type;
    this.chipLabels = { a: null, b: null };
    this.renderSlot('a');
    this.renderSlot('b');
    this.armSlot('a');
    this.flipInput.checked = seed?.flip ?? false;
    // Zero is every number row's placeholder value — seed it as the blank
    // field it would re-render as, not a literal '0'.
    this.rotateInput.value = numberOrBlank(seed?.rotate);
    this.offsetInputs.forEach((input, i) => {
      input.value = numberOrBlank(seed?.offset?.[i]);
    });
    const limits = seed?.limits ?? null;
    this.limitsEnable.checked = limits !== null;
    this.limitInputs.forEach((input, i) => {
      input.value = limits ? String(limits[i]) : '';
      input.disabled = limits === null;
    });
    this.syncTypeConstraints();
    this.shell.show();
  }

  /** The dropdown's current mate type. */
  getType(): AssemblyMateType {
    return this.typeSelect.value as AssemblyMateType;
  }

  /** Switch the dropdown (a second toolbar button clicked while open). */
  setType(type: AssemblyMateType): void {
    if (this.typeSelect.value === type) return;
    this.typeSelect.value = type;
    this.shell.setTitle(`${MATE_TYPE_LABELS[type]} mate`);
    this.syncTypeConstraints();
  }

  /**
   * The picked chip for one slot (the service owns the pick); null clears
   * back to the pick prompt.
   */
  setSlotChip(slot: MateSlotKey, label: string | null): void {
    this.chipLabels[slot] = label;
    this.renderSlot(slot);
  }

  /** Aim picks at a slot: the armed border moves, the other slot relaxes. */
  armSlot(slot: MateSlotKey): void {
    this.armedSlot = slot;
    this.slots.a.setArmed(slot === 'a');
    this.slots.b.setArmed(slot === 'b');
  }

  getArmedSlot(): MateSlotKey {
    return this.armedSlot;
  }

  values(): MateOptionValues {
    const type = this.getType();
    const rotateRaw = this.rotateInput.value.trim();
    const rotate = rotateRaw === '' ? 0 : Number(rotateRaw);
    if (!Number.isFinite(rotate)) {
      return { error: 'Rotate must be a number of degrees.' };
    }
    const offset: number[] = [];
    for (const input of this.offsetInputs) {
      const raw = input.value.trim();
      const value = raw === '' || input.disabled ? 0 : Number(raw);
      if (!Number.isFinite(value)) {
        return { error: 'Offsets must be numbers.' };
      }
      offset.push(value);
    }
    let limits: [number, number] | null = null;
    if (LIMIT_TYPES.has(type) && this.limitsEnable.checked) {
      const min = Number(this.limitInputs[0].value.trim());
      const max = Number(this.limitInputs[1].value.trim());
      if (!Number.isFinite(min) || !Number.isFinite(max)) {
        return { error: 'Both limits must be numbers.' };
      }
      if (min >= max) {
        return { error: 'The limits minimum must be less than the maximum.' };
      }
      limits = [min, max];
    }
    return {
      type,
      flip: this.flipInput.checked,
      rotate,
      offset: offset as [number, number, number],
      limits,
    };
  }

  /**
   * Apply the kernel's per-type rules to the option rows: X/Y offsets lock
   * (and blank) for the axis/plane mates whose offset must be Z-only, and
   * the limits section only shows for slider (mm) and revolute (deg).
   */
  private syncTypeConstraints(): void {
    const type = this.getType();
    const zOnly = Z_ONLY_OFFSET.has(type);
    for (const input of [this.offsetInputs[0], this.offsetInputs[1]]) {
      input.disabled = zOnly;
      input.title = zOnly
        ? `${MATE_TYPE_LABELS[type]} offsets must be along Z`
        : input === this.offsetInputs[0] ? "Along the mate's X axis" : "Along the mate's Y axis";
      if (zOnly) {
        input.value = '';
      }
    }
    const limitsAvailable = LIMIT_TYPES.has(type);
    this.limitsSection.classList.toggle('hidden', !limitsAvailable);
    this.limitsUnit.textContent = type === 'slider' ? '(mm along Z)' : type === 'revolute' ? '(° about Z)' : '';
  }

  private renderSlot(slot: MateSlotKey): void {
    const label = this.chipLabels[slot];
    if (label !== null) {
      this.slots[slot].setChips([{
        label,
        badge: '●',
        removable: true,
        onEdit: () => this.onEditConnector?.(slot),
        editTitle: "Edit this connector's properties",
      }]);
      this.slots[slot].setPrompt(null);
    } else {
      this.slots[slot].setChips([]);
      this.slots[slot].setPrompt('Click a connector in 3D');
    }
  }
}

function numberOrBlank(value: number | undefined): string {
  return value !== undefined && value !== 0 ? String(value) : '';
}
