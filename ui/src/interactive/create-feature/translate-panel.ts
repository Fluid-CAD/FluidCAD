import { FeaturePanel } from './feature-panel';
import { ChoiceTabs } from './panel-controls';
import { PickSlot, PickSlotChip } from '../pick-slot';
import { NewVariable, Translation, ValueExpr } from '../../api';
import { ExpressionField, collectNewVariablesChecked } from '../../ui/expression-field';
import { VariableInfo } from '../../ui/expression-core';
import { iconUrl } from '../../ui/icon-url';
import { DistanceRead, TRANSLATE_AXES, TranslateAxis } from './translate-distances';

/** How the moved bodies land: moved (the default), or left as copies. */
export type TranslateMode = 'move' | 'copy';

/** Validated form values, or the message to show when a field is invalid. */
export type TranslateValues =
  | {
      mode: TranslateMode;
      /** The distance along X, Y and Z. */
      translation: Translation;
      newVariables?: NewVariable[];
    }
  | { error: string };

const AXIS_NAMES = ['X', 'Y', 'Z'] as const;

/**
 * The translate dialog: a Move / Copy tab row (whether the originals stay —
 * the statement's `true` after the distances), the solids slot — filled from
 * whole-solid viewport picks (any face or edge click selects the owning
 * solid) or timeline rows, one numbered chip per solid being moved — and the
 * X, Y and Z distance fields the viewport gizmo drives. The slot is the only
 * one, so it stays armed. Pure DOM + form state — the service owns scene
 * data, the gizmo, previews, and the apply call.
 */
export class TranslatePanel extends FeaturePanel {
  /** The target chip at `index` was removed. */
  onRemoveTarget?: (index: number) => void;

  private tabs: ChoiceTabs<TranslateMode>;
  private targetsSlot: PickSlot;
  private distanceFields: ExpressionField[];

  constructor(container: HTMLElement) {
    super(container, {
      id: 'fluidcad-translate-panel',
      title: 'Translate',
      icon: iconUrl('translate'),
      bodyHtml: `
        <div data-role="tabs" class="join w-full"></div>
        <div data-role="targets-slot"></div>
        <div class="flex flex-col gap-1.5"
          title="How far the solids move along the world axes — drag the gizmo's arrows, planes or center, or click an arrow to type">
          <span class="text-base-content/70">Distance (X, Y, Z)</span>
          <div class="flex items-center gap-1.5">
            ${AXIS_NAMES.map(name => `
              <input data-role="distance-${name.toLowerCase()}" type="number" step="1" value="0"
                title="Along world ${name}" class="input input-sm input-bordered w-full min-w-0 text-xs" />`).join('')}
          </div>
        </div>
      `,
    });

    this.tabs = new ChoiceTabs<TranslateMode>(this.role('tabs'), [
      { key: 'move', label: 'Move', title: 'Move the solids — translate(x, y, z, …)' },
      { key: 'copy', label: 'Copy', title: 'Keep the originals and add moved copies — translate(x, y, z, true, …)' },
    ], 'move');
    this.tabs.onChange = () => this.onChange?.();

    this.targetsSlot = new PickSlot(this.role('targets-slot'), { label: 'Solids', multiple: true });
    this.targetsSlot.onRemove = (index) => this.onRemoveTarget?.(index);

    this.distanceFields = AXIS_NAMES.map(name => this.enhance(`distance-${name.toLowerCase()}`));
  }

  /** The variables the distance fields' dropdowns offer. */
  setScopeVariables(variables: VariableInfo[]): void {
    for (const field of this.distanceFields) {
      field.setVariables(variables);
    }
  }

  show(): void {
    // A fresh arming starts from rest and an empty slot — the previous
    // session's choices would otherwise be revived by source-line matching.
    this.shell.setTitle(null);
    this.tabs.setValue('move');
    this.setTranslation([0, 0, 0]);
    this.openWithTargets();
  }

  /**
   * Open prefilled from an existing statement (edit mode): its distances and
   * copy flag. The targets slot is seeded by the service.
   */
  showEdit(state: { mode: TranslateMode; translation: Translation }): void {
    this.shell.setTitle('Edit translate');
    this.tabs.setValue(state.mode);
    this.setTranslation(state.translation);
    this.openWithTargets();
  }

  /** Render the target chips — numbered, the translate's argument order. */
  setTargets(chips: PickSlotChip[]): void {
    this.targetsSlot.setChips(chips.map((chip, index) => ({
      ...chip,
      badge: String(index + 1),
      removable: true,
    })));
    this.targetsSlot.setPrompt(chips.length > 0 ? null : 'Pick solids in the viewport');
  }

  /** One distance field as it reads right now; null while it holds no valid value. */
  distanceRead(axis: TranslateAxis): DistanceRead | null {
    const read = this.distanceFields[axis].read();
    return 'error' in read ? null : read;
  }

  /** A distance a gizmo drag landed on. No change event fires. */
  setDistance(axis: TranslateAxis, value: number): void {
    this.distanceFields[axis].setValue(value);
  }

  /**
   * A distance typed into the gizmo's value input — an expression, maybe
   * declaring the variable it names. No change event fires.
   */
  setDistanceCommitted(axis: TranslateAxis, expression: string, newVariable?: NewVariable): void {
    this.distanceFields[axis].setCommitted(expression, newVariable);
  }

  values(): TranslateValues {
    const reads = this.distanceFields.map(field => field.read());
    const translation: ValueExpr[] = [];
    for (const axis of TRANSLATE_AXES) {
      const read = reads[axis];
      if ('error' in read) {
        return { error: read.error === 'empty' ? `Enter the ${AXIS_NAMES[axis]} distance — 0 to stay put.` : read.error };
      }
      translation.push(read.value);
    }
    const declared = collectNewVariablesChecked(reads.map(read => 'error' in read ? null : read));
    if ('error' in declared) {
      return declared;
    }
    return {
      mode: this.tabs.value,
      translation: translation as Translation,
      ...declared,
    };
  }

  private setTranslation(translation: Translation): void {
    for (const axis of TRANSLATE_AXES) {
      this.distanceFields[axis].setValue(translation[axis]);
    }
  }

  private openWithTargets(): void {
    this.setTargets([]);
    // The solids slot is the dialog's only pick target — always armed.
    this.targetsSlot.setArmed(true);
    this.shell.show();
  }
}
