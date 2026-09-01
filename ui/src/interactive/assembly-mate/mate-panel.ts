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
      /** Tangent propagation (contact may slide across the G1 chain); on by default. */
      propagate: boolean;
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
  'tangent': 'Tangent',
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
  propagate?: boolean;
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
  private chips: Record<MateSlotKey, { label: string; pen: boolean } | null> = { a: null, b: null };
  private originAxisRow: HTMLElement;
  private originAxisSelect: HTMLSelectElement;
  private armedSlot: MateSlotKey = 'a';
  private flipInput: HTMLInputElement;
  private rotateInput: HTMLInputElement;
  private offsetInputs: [HTMLInputElement, HTMLInputElement, HTMLInputElement];
  private limitsSection: HTMLElement;
  private limitsEnable: HTMLInputElement;
  private limitsUnit: HTMLSpanElement;
  private limitInputs: [HTMLInputElement, HTMLInputElement];
  private propagateRow: HTMLElement;
  private propagateInput: HTMLInputElement;
  private flipRow: HTMLElement;
  private rotateRow: HTMLElement;
  private offsetRow: HTMLElement;

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
        <label data-role="origin-axis-row" class="hidden flex flex-col gap-1.5"
          title="Which world axis the origin frame's Z points along — the joint's axis for revolute/slider/cylindrical, the plane normal for planar">
          <span class="text-base-content/70">Origin axis</span>
          <select data-role="origin-axis" class="select select-sm select-bordered w-full text-xs">
            <option value="z">Z (up)</option>
            <option value="x">X</option>
            <option value="y">Y</option>
          </select>
        </label>
        <label data-role="propagate-row" class="hidden flex items-center gap-2 cursor-pointer"
          title="Contact may slide across smoothly connected neighbor faces">
          <input data-role="propagate" type="checkbox" class="checkbox checkbox-xs" checked />
          <span class="text-base-content/70">Tangent propagation</span>
        </label>
        <label data-role="flip-row" class="flex items-center gap-2 cursor-pointer"
          title="Turn connector B's frame 180° so its Z axis opposes A's">
          <input data-role="flip" type="checkbox" class="checkbox checkbox-xs" />
          <span class="text-base-content/70">Flip</span>
        </label>
        <label data-role="rotate-row" class="flex flex-col gap-1.5"
          title="Extra rotation of B about the mate's Z axis, in degrees">
          <span class="text-base-content/70">Rotate (°)</span>
          <input data-role="rotate" type="number" step="any" placeholder="0"
            class="input input-sm input-bordered w-full text-xs" />
        </label>
        <div data-role="offset-row" class="flex flex-col gap-1.5"
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

    this.originAxisRow = this.role('origin-axis-row');
    this.originAxisSelect = this.role<HTMLSelectElement>('origin-axis');
    this.originAxisSelect.addEventListener('change', () => this.onChange?.());

    this.flipInput = this.role<HTMLInputElement>('flip');
    this.flipInput.addEventListener('change', () => this.onChange?.());

    this.propagateRow = this.role('propagate-row');
    this.propagateInput = this.role<HTMLInputElement>('propagate');
    this.propagateInput.addEventListener('change', () => this.onChange?.());
    this.flipRow = this.role('flip-row');
    this.rotateRow = this.role('rotate-row');
    this.offsetRow = this.role('offset-row');

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
    this.chips = { a: null, b: null };
    this.setOriginAxisRow(false, 'z');
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
    // Propagation is the tangent default — only an explicit false unchecks.
    this.propagateInput.checked = seed?.propagate !== false;
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
   * back to the pick prompt. `pen: false` drops the chip's property-editor
   * pen — origin chips have no connector statement to edit.
   */
  setSlotChip(slot: MateSlotKey, label: string | null, opts: { pen?: boolean } = {}): void {
    this.chips[slot] = label === null ? null : { label, pen: opts.pen ?? true };
    this.renderSlot(slot);
  }

  /**
   * Show/hide the origin-axis dropdown (visible while a slot holds the
   * origin frame). `axis` seeds the dropdown when provided; the service
   * reads changes back via {@link getOriginAxis} on its onChange refresh.
   */
  setOriginAxisRow(visible: boolean, axis?: 'x' | 'y' | 'z'): void {
    this.originAxisRow.classList.toggle('hidden', !visible);
    if (axis !== undefined) {
      this.originAxisSelect.value = axis;
    }
  }

  getOriginAxis(): 'x' | 'y' | 'z' {
    const v = this.originAxisSelect.value;
    return v === 'x' || v === 'y' ? v : 'z';
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
    if (type === 'tangent') {
      // Tangent has no flip/rotate/offset/limits — the contact side is
      // canonical; the propagation checkbox is the one option.
      return {
        type,
        flip: false,
        rotate: 0,
        offset: [0, 0, 0],
        limits: null,
        propagate: this.propagateInput.checked,
      };
    }
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
      propagate: true,
    };
  }

  /**
   * Apply the kernel's per-type rules to the option rows: X/Y offsets lock
   * (and blank) for the axis/plane mates whose offset must be Z-only, and
   * the limits section only shows for slider (mm) and revolute (deg).
   * Tangent reshapes the panel wholesale: geometry slots instead of
   * connector slots, and the propagation checkbox as the only option.
   */
  private syncTypeConstraints(): void {
    const type = this.getType();
    const tangent = type === 'tangent';
    this.propagateRow.classList.toggle('hidden', !tangent);
    if (tangent) {
      // Origin sides don't exist for tangent; the service re-shows the row
      // (refreshPreview) whenever a non-tangent type has an origin slot.
      this.originAxisRow.classList.add('hidden');
    }
    this.flipRow.classList.toggle('hidden', tangent);
    this.rotateRow.classList.toggle('hidden', tangent);
    this.offsetRow.classList.toggle('hidden', tangent);
    this.slots.a.setLabel(tangent ? 'Face / edge A' : 'Connector A');
    this.slots.b.setLabel(tangent ? 'Face / edge B' : 'Connector B');
    this.renderSlot('a');
    this.renderSlot('b');
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
    const tangent = this.getType() === 'tangent';
    const chip = this.chips[slot];
    if (chip !== null) {
      this.slots[slot].setChips([{
        label: chip.label,
        badge: '●',
        removable: true,
        // Tangent and origin chips carry no pen — a picked face/edge (or
        // the world frame) has no connector-style properties to edit.
        ...(tangent || !chip.pen ? {} : {
          onEdit: () => this.onEditConnector?.(slot),
          editTitle: "Edit this connector's properties",
        }),
      }]);
      this.slots[slot].setPrompt(null);
    } else {
      this.slots[slot].setChips([]);
      this.slots[slot].setPrompt(tangent ? 'Click a face or edge in 3D' : 'Click a connector in 3D');
    }
  }
}

function numberOrBlank(value: number | undefined): string {
  return value !== undefined && value !== 0 ? String(value) : '';
}
