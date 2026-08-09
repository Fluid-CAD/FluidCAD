import { FeaturePanel } from './feature-panel';
import { EntitySlotControl } from './entity-slot';
import { ConnectorRotateAxis } from '../../api';

/** Validated form values, or the message to show when a field is invalid. */
export type ConnectorValues =
  | {
      name: string;
      /** Rotation around one of the connector's local axes, 90° steps: 0/90/180/270. */
      rotate: { axis: ConnectorRotateAxis; angle: number };
      /** Frame-local offset [x, y, z]; blank fields read as 0. */
      offset: [number, number, number];
    }
  | { error: string };

const NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** The two-chasing-arrows rotate glyph on the rotation stepper. */
const ROTATE_ICON = `
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M20.5 9.5A8.5 8.5 0 0 0 5.2 6.2"/>
    <polyline points="5.2 2.2 5.2 6.2 9.2 6.2"/>
    <path d="M3.5 14.5a8.5 8.5 0 0 0 15.3 3.3"/>
    <polyline points="18.8 21.8 18.8 17.8 14.8 17.8"/>
  </svg>`;

/**
 * The connector dialog: the source slot — filled by clicking a suggested
 * anchor in the viewport (hovering faces/edges floats the nearest candidate
 * as a translucent gizmo) — the name the connector registers under
 * (prefilled with a free `c1`-style default), the frame-local offset triple,
 * and the rotation stepper: each click turns the connector 90° around its
 * own Z. Pure DOM + form state — the service owns the picked anchor, the
 * ghost, and the apply call.
 */
export class ConnectorPanel extends FeaturePanel {
  /** The source chip's ✕ — the service drops the locked anchor. */
  onRemoveSource?: () => void;

  private sourceSlot: EntitySlotControl;
  private nameInput: HTMLInputElement;
  private offsetInputs: [HTMLInputElement, HTMLInputElement, HTMLInputElement];
  private rotateAxisSelect: HTMLSelectElement;
  private rotationValue: HTMLSpanElement;
  private rotateAngle = 0;
  /** True once the user typed a name — defaults stop overwriting it. */
  private nameTouched = false;

  constructor(container: HTMLElement) {
    super(container, {
      id: 'fluidcad-connector-panel',
      title: 'Connector',
      icon: '/icons/mate-connector.png',
      bodyHtml: `
        <div data-role="source-slot"></div>
        <label class="flex flex-col gap-1.5"
          title="The identifier the connector registers under — assemblies reference it as instance.connectors.<name>">
          <span class="text-base-content/70">Name</span>
          <input data-role="name" type="text" spellcheck="false" autocomplete="off"
            class="input input-sm input-bordered w-full text-xs font-mono" />
        </label>
        <div class="flex flex-col gap-1.5"
          title="Move the connector along its own axes — X and Y in the frame plane, Z along the frame normal — measured before the rotation">
          <span class="text-base-content/70">Offset (X, Y, Z)</span>
          <div class="flex gap-1.5">
            <input data-role="offset-x" type="number" step="any" placeholder="0" title="Along the connector's X axis"
              class="input input-sm input-bordered w-full text-xs" />
            <input data-role="offset-y" type="number" step="any" placeholder="0" title="Along the connector's Y axis"
              class="input input-sm input-bordered w-full text-xs" />
            <input data-role="offset-z" type="number" step="any" placeholder="0" title="Along the connector's Z axis (the frame normal)"
              class="input input-sm input-bordered w-full text-xs" />
          </div>
        </div>
        <div class="flex flex-col gap-1.5"
          title="Turn the connector around one of its own axes, 90° per click — it pivots where the offset put it">
          <span class="text-base-content/70">Rotation</span>
          <div class="flex items-center gap-1.5">
            <select data-role="rotate-axis" class="select select-sm select-bordered flex-1 text-xs"
              title="The connector's own axis to rotate around">
              <option value="z" selected>Around Z</option>
              <option value="x">Around X</option>
              <option value="y">Around Y</option>
            </select>
            <button data-role="rotate" type="button" class="btn btn-ghost btn-sm gap-1.5 shrink-0">
              ${ROTATE_ICON}
              <span data-role="rotation-value" class="font-mono">0°</span>
            </button>
          </div>
        </div>
      `,
    });

    this.sourceSlot = new EntitySlotControl(this.role('source-slot'), {
      label: 'Source',
      prompt: 'Hover a face or edge, click the suggested connector',
    });
    this.sourceSlot.onRemove = () => this.onRemoveSource?.();

    this.nameInput = this.role<HTMLInputElement>('name');
    this.nameInput.addEventListener('input', () => {
      this.nameTouched = true;
      this.onChange?.();
    });
    this.nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.onApply?.();
      }
    });

    this.offsetInputs = [
      this.role<HTMLInputElement>('offset-x'),
      this.role<HTMLInputElement>('offset-y'),
      this.role<HTMLInputElement>('offset-z'),
    ];
    for (const input of this.offsetInputs) {
      input.addEventListener('input', () => this.onChange?.());
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.onApply?.();
        }
      });
    }

    this.rotateAxisSelect = this.role<HTMLSelectElement>('rotate-axis');
    this.rotateAxisSelect.addEventListener('change', () => this.onChange?.());

    this.rotationValue = this.role<HTMLSpanElement>('rotation-value');
    this.role<HTMLButtonElement>('rotate').addEventListener('click', () => {
      this.rotateAngle = (this.rotateAngle + 90) % 360;
      this.rotationValue.textContent = `${this.rotateAngle}°`;
      this.onChange?.();
    });
  }

  /** Fresh arming: empty slot armed for picks, zeroed adjustments. */
  show(): void {
    this.shell.setTitle(null);
    this.sourceSlot.reset();
    this.sourceSlot.setArmed(true);
    this.nameInput.value = '';
    this.nameTouched = false;
    this.setAdjustments(null, null);
    this.shell.show();
  }

  /**
   * Edit mode (timeline double-click): the statement's own values seed every
   * field, and its source expression stands as the slot's un-removable
   * "Current: …" chip — the slot stays armed, so one viewport click re-points
   * the connector at fresh geometry.
   */
  showEdit(seed: {
    name: string;
    sourceText: string;
    rotate: { axis: ConnectorRotateAxis; angle: number } | null;
    offset: [number, number, number] | null;
  }): void {
    this.shell.setTitle('Edit connector');
    this.sourceSlot.reset();
    this.sourceSlot.seedKeep(seed.sourceText);
    this.sourceSlot.setArmed(true);
    this.nameInput.value = seed.name;
    // The statement's name is the user's own — a re-pick's default suggestion
    // must not overwrite it.
    this.nameTouched = true;
    this.setAdjustments(seed.rotate, seed.offset);
    this.shell.show();
  }

  /** Seed (or clear) the rotation stepper and the offset triple. */
  private setAdjustments(
    rotate: { axis: ConnectorRotateAxis; angle: number } | null,
    offset: [number, number, number] | null,
  ): void {
    this.offsetInputs.forEach((input, index) => {
      const value = offset?.[index] ?? 0;
      // A blank field reads as 0 — a zero component shows as the placeholder.
      input.value = value === 0 ? '' : String(value);
    });
    this.rotateAxisSelect.value = rotate?.axis ?? 'z';
    // A hand-written angle keeps its value and steps 90° from there; a
    // negative or over-full turn normalizes to the equivalent 0–359.
    this.rotateAngle = (((rotate?.angle ?? 0) % 360) + 360) % 360;
    this.rotationValue.textContent = `${this.rotateAngle}°`;
  }

  /**
   * The locked anchor's chip (the service owns the pick); null clears back
   * to the hover prompt.
   */
  setSourceChip(label: string | null): void {
    this.sourceSlot.setChip(label);
  }

  /**
   * Prefill the name with the part's free default (`c1`, …). A name the
   * user already typed stays put.
   */
  suggestName(name: string): void {
    if (!this.nameTouched || this.nameInput.value.trim() === '') {
      this.nameInput.value = name;
      this.nameTouched = false;
    }
  }

  values(): ConnectorValues {
    const name = this.nameInput.value.trim();
    if (name === '' || name.length > 64 || !NAME_PATTERN.test(name)) {
      return { error: "Enter a connector name — a plain identifier like 'mountTop'." };
    }
    const offset: number[] = [];
    for (const input of this.offsetInputs) {
      const raw = input.value.trim();
      const value = raw === '' ? 0 : Number(raw);
      if (!Number.isFinite(value)) {
        return { error: 'Offsets must be numbers.' };
      }
      offset.push(value);
    }
    return {
      name,
      rotate: {
        axis: this.rotateAxisSelect.value as ConnectorRotateAxis,
        angle: this.rotateAngle,
      },
      offset: offset as [number, number, number],
    };
  }
}
