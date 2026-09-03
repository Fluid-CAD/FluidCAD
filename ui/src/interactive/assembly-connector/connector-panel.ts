import { FeaturePanel } from '../create-feature/feature-panel';
import { ExpressionField, collectNewVariables } from '../../ui/expression-field';
import type { VariableInfo } from '../../ui/expression-core';

const NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export type AxisKey = 'x' | 'y' | 'z';
const AXES: AxisKey[] = ['x', 'y', 'z'];

/** One axis of the dialog: numeric value, or the expression text the user typed. */
export type AxisValue = { value: number | string; newVariable?: { name: string; initializer: string } };

export type ConnectorPanelValues = {
  name: string;
  position: [AxisValue, AxisValue, AxisValue];
  /** Null while rotation editing is blocked (a chain the dialog can't rewrite). */
  rotation: [AxisValue, AxisValue, AxisValue] | null;
  newVariables?: { name: string; initializer: string }[];
};

/**
 * The assembly-connector dialog: name, world position and rotation. Each
 * numeric field is an ExpressionField — variables in scope, `name = value`
 * declarations — and the rotation reads as intrinsic XYZ degrees, the
 * canonical `.rotate('x', a).rotate('y', b).rotate('z', c)` chain.
 */
export class AssemblyConnectorPanel extends FeaturePanel {
  private nameInput: HTMLInputElement;
  private positionFields: [ExpressionField, ExpressionField, ExpressionField];
  private rotationFields: [ExpressionField, ExpressionField, ExpressionField];
  private rotationBlocked = false;

  constructor(container: HTMLElement) {
    super(container, {
      id: 'fluidcad-assembly-connector-panel',
      title: 'Assembly connector',
      icon: '/icons/mate-connector.png',
      bodyHtml: `
        <label class="flex flex-col gap-1.5"
          title="The identifier the connector registers under — mates reference its binding">
          <span class="text-base-content/70">Name</span>
          <input data-role="name" type="text" spellcheck="false" autocomplete="off"
            class="input input-sm input-bordered w-full text-xs font-mono" />
        </label>
        <div class="flex flex-col gap-1.5" title="Where the connector sits, in assembly coordinates">
          <span class="text-base-content/70">Position (X, Y, Z)</span>
          <div class="flex gap-1.5">
            ${AXES.map(axis => `<input data-role="position-${axis}" type="number" step="any" placeholder="0" title="World ${axis.toUpperCase()}"
              class="input input-sm input-bordered w-full text-xs" />`).join('')}
          </div>
        </div>
        <div class="flex flex-col gap-1.5"
          title="Turn the connector about its own X, then Y, then Z axis, in degrees — the frame starts with Z up">
          <span class="text-base-content/70">Rotation (X, Y, Z °)</span>
          <div class="flex gap-1.5">
            ${AXES.map(axis => `<input data-role="rotation-${axis}" type="number" step="any" placeholder="0" title="Degrees about the connector's ${axis.toUpperCase()} axis"
              class="input input-sm input-bordered w-full text-xs" />`).join('')}
          </div>
          <span data-role="rotation-note" class="hidden text-[11px] text-base-content/50 leading-snug"></span>
        </div>
      `,
      exitLabel: 'Cancel',
    });
    this.nameInput = this.role<HTMLInputElement>('name');
    this.nameInput.addEventListener('input', () => this.onChange?.());
    this.nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.onApply?.();
      }
    });
    this.positionFields = AXES.map(axis => this.enhance(`position-${axis}`)) as typeof this.positionFields;
    this.rotationFields = AXES.map(axis => this.enhance(`rotation-${axis}`)) as typeof this.rotationFields;
  }

  /** Seed and show. `rotation` null blocks the rotation row with `note`. */
  show(seed: {
    title: string;
    name: string;
    position: [number | string, number | string, number | string];
    rotation: [number | string, number | string, number | string] | null;
    note?: string;
  }): void {
    this.shell.setTitle(seed.title);
    this.nameInput.value = seed.name;
    seed.position.forEach((v, i) => this.positionFields[i].setValue(v));
    const note = this.role<HTMLSpanElement>('rotation-note');
    this.rotationBlocked = seed.rotation === null;
    (seed.rotation ?? [0, 0, 0]).forEach((v, i) => this.rotationFields[i].setValue(v));
    for (const field of this.rotationFields) {
      field.element.disabled = this.rotationBlocked;
    }
    note.textContent = seed.note ?? '';
    note.classList.toggle('hidden', !seed.note);
    this.shell.show();
    this.nameInput.focus();
    this.nameInput.select();
  }

  setVariables(variables: VariableInfo[]): void {
    for (const field of [...this.positionFields, ...this.rotationFields]) {
      field.setVariables(variables);
    }
  }

  focusName(): void {
    this.nameInput.focus();
  }

  /** Every field read for a preview or apply, or the first problem. */
  values(): ConnectorPanelValues | { error: string } {
    const name = this.nameInput.value.trim();
    if (name === '' || name.length > 64 || !NAME_PATTERN.test(name)) {
      return { error: "Enter a connector name — a plain identifier like 'hinge'." };
    }
    const reads: AxisValue[] = [];
    const readAxis = (field: ExpressionField, label: string): AxisValue | { error: string } => {
      const raw = field.element.value.trim();
      if (raw === '') {
        return { value: 0 };
      }
      const read = field.read();
      if ('error' in read) {
        return { error: read.error === 'empty' ? `${label} needs a value.` : `${label}: ${read.error}` };
      }
      reads.push(read);
      return read;
    };
    const position: AxisValue[] = [];
    for (let i = 0; i < 3; i++) {
      const read = readAxis(this.positionFields[i], `Position ${AXES[i].toUpperCase()}`);
      if ('error' in read) {
        return read;
      }
      position.push(read);
    }
    let rotation: AxisValue[] | null = null;
    if (!this.rotationBlocked) {
      rotation = [];
      for (let i = 0; i < 3; i++) {
        const read = readAxis(this.rotationFields[i], `Rotation ${AXES[i].toUpperCase()}`);
        if ('error' in read) {
          return read;
        }
        rotation.push(read);
      }
    }
    return {
      name,
      position: position as ConnectorPanelValues['position'],
      rotation: rotation as ConnectorPanelValues['rotation'],
      newVariables: collectNewVariables(reads),
    };
  }
}
