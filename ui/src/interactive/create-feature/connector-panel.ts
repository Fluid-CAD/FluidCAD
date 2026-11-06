import { FeaturePanel } from './feature-panel';
import { EntitySlotControl } from './entity-slot';
import { SelectControl } from './expression-rows';
import {
  ConnectorOffsetSpec, ConnectorRotateAxis, ConnectorRotateSpec, FeatureExprValue, FeatureRefValue, NewVariable, ValueExpr,
} from '../../api';
import { ExpressionField, collectNewVariables, type ExpressionFieldResult } from '../../ui/expression-field';
import { resolveExpressionValue, type VariableInfo } from '../../ui/expression-core';
import { LiteralExpressions } from '../../ui/literal-expressions';
import { iconUrl } from '../../ui/icon-url';

/** Validated form values, or the message to show when a field is invalid. */
export type ConnectorValues =
  | {
      name: string;
      /**
       * Rotation around one of the connector's local axes: the axis a name or
       * the expression computing it, the angle in degrees — a number (0 for a
       * blank field; the stepper writes 0/90/180/270) or an expression.
       */
      rotate: ConnectorRotateSpec;
      /** Frame-local offset [x, y, z], each a number (0 for a blank field) or an expression. */
      offset: ConnectorOffsetSpec;
      /** Declarations the angle or offset fields committed (`ang = 45`), to land with the statement. */
      newVariables?: NewVariable[];
    }
  | { error: string };

/**
 * A connector statement's adjustments as the dialog seeds and resolves them:
 * the parsed statement's own shapes — the axis a name, a variable's `{ ref }`
 * or an expression, the numbers literals or bare expression text.
 */
export type ConnectorAdjustments = {
  rotate: { axis: ConnectorRotateAxis | FeatureRefValue | FeatureExprValue; angle: ValueExpr } | null;
  offset: ConnectorOffsetSpec | null;
};

/** The adjustments as numbers the ghost can draw: the literals, or what the expressions come to. */
export type ConnectorResolvedAdjustments = {
  rotate: { axis: ConnectorRotateAxis; angle: number };
  offset: [number, number, number];
};

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

/** A choice slot's seed for a control with one expression mode: a variable's `{ ref }` opens as the expression of its name. */
function seedOf<T>(value: T | FeatureRefValue | FeatureExprValue): T | FeatureExprValue {
  if (typeof value === 'object' && value !== null && 'ref' in value) {
    return { expr: (value as FeatureRefValue).ref };
  }
  return value as T | FeatureExprValue;
}

/**
 * The connector dialog: the source slot — filled by clicking a suggested
 * anchor in the viewport (hovering faces/edges floats the nearest candidate
 * as a translucent gizmo) — the name the connector registers under
 * (prefilled with a free `c1`-style default), the frame-local offset triple,
 * and the rotation row: the axis, the angle in degrees and a stepper that
 * turns a number 90° per click. The offsets and the angle are expression
 * fields (`gap`, `h / 2`); the axis takes an expression under its ƒ toggle
 * (`flipped ? 'x' : 'y'`). Pure DOM + form state — the service owns the
 * picked anchor, the ghost, and the apply call, drawing the ghost from
 * {@link resolvedAdjustments}: what the fields hold, or what their
 * expressions come to, and nothing while one cannot be told.
 */
export class ConnectorPanel extends FeaturePanel {
  /** The source chip's ✕ — the service drops the locked anchor. */
  onRemoveSource?: () => void;

  private sourceSlot: EntitySlotControl;
  private nameInput: HTMLInputElement;
  private offsetFields: [ExpressionField, ExpressionField, ExpressionField];
  private axisControl: SelectControl<ConnectorRotateAxis>;
  private angleField: ExpressionField;
  private rotateBtn: HTMLButtonElement;
  /** True once the user typed a name — defaults stop overwriting it. */
  private nameTouched = false;
  /** The variables in scope, as last pushed — the number fields resolve their expressions by them. */
  private variables: VariableInfo[] = [];

  constructor(container: HTMLElement) {
    super(container, {
      id: 'fluidcad-connector-panel',
      title: 'Connector',
      icon: iconUrl('mate-connector'),
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
            <input data-role="offset-x" data-unit="length" type="number" step="any" placeholder="0" title="Along the connector's X axis"
              class="input input-sm input-bordered w-full text-xs" />
            <input data-role="offset-y" data-unit="length" type="number" step="any" placeholder="0" title="Along the connector's Y axis"
              class="input input-sm input-bordered w-full text-xs" />
            <input data-role="offset-z" data-unit="length" type="number" step="any" placeholder="0" title="Along the connector's Z axis (the frame normal)"
              class="input input-sm input-bordered w-full text-xs" />
          </div>
        </div>
        <div class="flex flex-col gap-1.5"
          title="Turn the connector around one of its own axes — it pivots where the offset put it">
          <span data-role="rotate-label" class="text-base-content/70">Rotation</span>
          <div class="flex items-start gap-1.5">
            <select data-role="rotate-axis" class="select select-sm select-bordered flex-1 min-w-0 text-xs"
              title="The connector's own axis to rotate around">
              <option value="z" selected>Around Z</option>
              <option value="x">Around X</option>
              <option value="y">Around Y</option>
            </select>
            <input data-role="rotate-angle" type="number" step="90" placeholder="0"
              title="Degrees around the axis — a number, or an expression"
              class="input input-sm input-bordered w-16 shrink-0 text-xs font-mono" />
            <button data-role="rotate" type="button" class="btn btn-ghost btn-sm shrink-0"
              title="Turn 90° more">
              ${ROTATE_ICON}
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

    this.offsetFields = [this.enhance('offset-x'), this.enhance('offset-y'), this.enhance('offset-z')];

    // The axis takes an expression under its ƒ: the select gives way to the
    // expression, shown with the axis it comes to.
    this.axisControl = new SelectControl<ConnectorRotateAxis>(
      this.role<HTMLSelectElement>('rotate-axis'), this.role('rotate-label'), { name: 'rotate-axis', label: 'Rotation axis' },
    );
    this.axisControl.onChange = () => this.onChange?.();
    this.axisControl.onSubmit = () => this.onApply?.();

    this.angleField = this.enhance('rotate-angle');
    this.angleField.element.addEventListener('input', () => this.syncStepper());
    this.rotateBtn = this.role<HTMLButtonElement>('rotate');
    this.rotateBtn.addEventListener('click', () => {
      // The stepper turns a number 90° on: a blank field is 0, a full turn
      // comes back to blank. An expression it leaves alone (it is disabled then).
      const current = this.stepperAngle();
      if (current === null) {
        return;
      }
      const next = (((current + 90) % 360) + 360) % 360;
      this.angleField.setValue(next === 0 ? '' : next);
      this.syncStepper();
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
    this.setAdjustments({ rotate: null, offset: null });
    this.shell.show();
  }

  /**
   * Edit mode (timeline double-click): the statement's own values seed every
   * field — an expression opening its row in expression mode — and its source
   * expression stands as the slot's un-removable "Current: …" chip — the slot
   * stays armed, so one viewport click re-points the connector at fresh
   * geometry.
   */
  showEdit(seed: ConnectorAdjustments & { name: string; sourceText: string }): void {
    this.shell.setTitle('Edit connector');
    this.sourceSlot.reset();
    this.sourceSlot.seedKeep(seed.sourceText);
    this.sourceSlot.setArmed(true);
    this.nameInput.value = seed.name;
    // The statement's name is the user's own — a re-pick's default suggestion
    // must not overwrite it.
    this.nameTouched = true;
    this.setAdjustments(seed);
    this.shell.show();
  }

  /** The variables the fields' dropdowns and the axis expression offer, and the ghost's numbers resolve over. */
  setScopeVariables(variables: VariableInfo[]): void {
    this.variables = variables;
    for (const field of [...this.offsetFields, this.angleField]) {
      field.setVariables(variables);
    }
    this.axisControl.setVariables(variables);
  }

  /** Seed (or clear) the rotation row and the offset triple; no change event fires. */
  private setAdjustments(adjustments: ConnectorAdjustments): void {
    this.offsetFields.forEach((field, index) => {
      const value = adjustments.offset?.[index] ?? 0;
      // A blank field reads as 0 — a zero component shows as the placeholder.
      field.setValue(value === 0 ? '' : value);
    });
    this.axisControl.setValue(seedOf(adjustments.rotate?.axis ?? 'z'));
    const angle = adjustments.rotate?.angle ?? 0;
    if (typeof angle === 'number') {
      // A hand-written angle keeps its value and steps 90° from there; a
      // negative or over-full turn normalizes to the equivalent 0–359.
      const normalized = ((angle % 360) + 360) % 360;
      this.angleField.setValue(normalized === 0 ? '' : normalized);
    } else {
      this.angleField.setValue(angle);
    }
    this.syncStepper();
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
    const offsets = [
      this.readNumber(this.offsetFields[0], 'Offset X'),
      this.readNumber(this.offsetFields[1], 'Offset Y'),
      this.readNumber(this.offsetFields[2], 'Offset Z'),
    ];
    for (const offset of offsets) {
      if ('error' in offset) {
        return offset;
      }
    }
    const angle = this.readNumber(this.angleField, 'Rotation');
    if ('error' in angle) {
      return angle;
    }
    const axis = this.axisControl.read();
    if ('error' in axis) {
      return axis;
    }
    const reads = [...offsets, angle] as { value: ValueExpr; read: ExpressionFieldResult | null }[];
    return {
      name,
      rotate: { axis: axis.value, angle: angle.value },
      offset: reads.slice(0, 3).map(each => each.value) as ConnectorOffsetSpec,
      newVariables: collectNewVariables(reads.map(each => each.read && !('error' in each.read) ? each.read : null)),
    };
  }

  /**
   * The adjustments as numbers for the ghost: the fields' own, or what their
   * expressions come to over the variables in scope; null while one cannot
   * be told (an unknown name, an axis expression that is none of the three)
   * — no frame draws then.
   */
  resolvedAdjustments(): ConnectorResolvedAdjustments | null {
    const axis = this.axisControl.read();
    const angle = this.readNumber(this.angleField, 'Rotation');
    const offsets = this.offsetFields.map(field => this.readNumber(field, 'Offset'));
    if ('error' in axis || 'error' in angle || offsets.some(each => 'error' in each)) {
      return null;
    }
    const values = offsets as { value: ValueExpr }[];
    return ConnectorPanel.resolveAdjustments({
      rotate: { axis: axis.value, angle: angle.value },
      offset: [values[0].value, values[1].value, values[2].value],
    }, this.variables);
  }

  /**
   * A statement's or a dialog's adjustments as numbers: literals as they
   * are, an expression or a variable's name by what it comes to over
   * `variables`; null while one cannot be told, or the axis comes to none
   * of the three.
   */
  static resolveAdjustments(adjustments: ConnectorAdjustments, variables: VariableInfo[]): ConnectorResolvedAdjustments | null {
    const axisSlot = adjustments.rotate?.axis ?? 'z';
    const axis = typeof axisSlot === 'string'
      ? axisSlot
      : LiteralExpressions.evaluate('expr' in axisSlot ? axisSlot.expr : axisSlot.ref, variables);
    if (axis !== 'x' && axis !== 'y' && axis !== 'z') {
      return null;
    }
    const numbers = [adjustments.rotate?.angle ?? 0, ...(adjustments.offset ?? [0, 0, 0])]
      .map(value => typeof value === 'number' ? value : resolveExpressionValue(value, variables));
    if (numbers.some(value => value === null)) {
      return null;
    }
    const [angle, x, y, z] = numbers as number[];
    return { rotate: { axis, angle }, offset: [x, y, z] };
  }

  /** A number field's value for the statement: 0 when blank, else its number or expression; the message names the field when it holds neither. */
  private readNumber(field: ExpressionField, label: string): { value: ValueExpr; read: ExpressionFieldResult | null } | { error: string } {
    const read = field.read();
    if ('error' in read) {
      return read.error === 'empty' ? { value: 0, read: null } : { error: `${label}: ${read.error}.` };
    }
    return { value: read.value, read };
  }

  /** The number the stepper turns from: a blank field is 0; null for an expression, which the stepper leaves alone. */
  private stepperAngle(): number | null {
    const read = this.angleField.read();
    if ('error' in read) {
      return read.error === 'empty' ? 0 : null;
    }
    return typeof read.value === 'number' ? read.value : null;
  }

  /** The stepper has a number to turn, or is disabled under an expression. */
  private syncStepper(): void {
    this.rotateBtn.disabled = this.stepperAngle() === null;
  }
}
