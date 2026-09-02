import { LoftConditionRef, NewVariable, ValueExpr } from '../../api';
import { FeatureOp, OpTabs, ThinControl } from './panel-controls';
import { FeaturePanel } from './feature-panel';
import { ScopeSlotControl } from './scope-slot';
import { PickSlot, PickSlotChip } from '../pick-slot';
import { ExpressionField, collectNewVariables } from '../../ui/expression-field';
import { VariableInfo } from '../../ui/expression-core';

/** Validated form values, or the message to show when a field is invalid. */
export type LoftValues =
  | {
      op: FeatureOp;
      thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
      startCondition: LoftConditionRef | null;
      endCondition: LoftConditionRef | null;
      newVariables?: NewVariable[];
    }
  | { error: string };

/**
 * One takeoff-condition row (start or end): the type select plus a magnitude
 * field shown only while a condition is set. 'none' means "write no chain" —
 * it never reaches the statement.
 */
class ConditionRow {
  onChange?: () => void;
  onSubmit?: () => void;

  private select: HTMLSelectElement;
  private magnitude: HTMLInputElement;
  private field: ExpressionField;

  constructor(host: HTMLElement, label: string, title: string, private which: string) {
    host.className = 'flex flex-col gap-1.5';
    host.innerHTML = `
      <span class="text-base-content/70">${label}</span>
      <div class="flex items-center gap-1.5">
        <select data-role="type" class="select select-sm select-bordered flex-1 text-xs" title="${title}">
          <option value="none">None</option>
          <option value="normal">Normal</option>
          <option value="tangent">Tangent</option>
        </select>
        <input data-role="magnitude" data-unit="length" type="number" step="0.5" value="1"
          title="Takeoff strength (default 1)"
          class="input input-sm input-bordered w-16 text-xs hidden" />
      </div>
    `;
    this.select = host.querySelector('[data-role="type"]')!;
    this.magnitude = host.querySelector('[data-role="magnitude"]')!;
    this.select.addEventListener('change', () => {
      this.sync();
      this.onChange?.();
    });
    // The field owns the magnitude input's keyboard handling (variable
    // dropdown, Enter-to-apply) and flips it to type="text" for identifiers.
    this.field = new ExpressionField(this.magnitude);
    this.field.onSubmit = () => this.onSubmit?.();
    this.magnitude.addEventListener('input', () => this.onChange?.());
  }

  /** The variables the magnitude field's dropdown offers. */
  setVariables(variables: VariableInfo[]): void {
    this.field.setVariables(variables);
  }

  reset(): void {
    this.select.value = 'none';
    this.field.setValue(1);
    this.sync();
  }

  /** Programmatic condition (edit-mode prefill); no change event fires. */
  set(condition: LoftConditionRef | null): void {
    this.select.value = condition ? condition.type : 'none';
    this.field.setValue(condition ? condition.magnitude : 1);
    this.sync();
  }

  /** The condition to write, null for none, or the blocking message. */
  values(): { condition: LoftConditionRef | null; newVariable?: NewVariable } | { error: string } {
    const type = this.select.value;
    if (type !== 'normal' && type !== 'tangent') {
      return { condition: null };
    }
    const read = this.field.read();
    if ('error' in read || (typeof read.value === 'number' && read.value === 0)) {
      return { error: `Enter a nonzero magnitude for the ${this.which} condition.` };
    }
    return { condition: { type, magnitude: read.value }, newVariable: read.newVariable };
  }

  private sync(): void {
    this.magnitude.classList.toggle('hidden', this.select.value === 'none');
  }
}

/**
 * The loft dialog: operation tabs, the ordered profile slot (numbered,
 * removable chips in a container — chip order is argument order, rows
 * drag-reorder by their grip), the optional guide slot (up to two guide
 * sketches), the start/end takeoff conditions, and the thin toggle (blocked
 * while guides exist — the kernel forbids the combination). Faces are added
 * by picking in the 3D view while the dialog is armed; sketches by timeline
 * or wire clicks, landing in whichever slot was clicked last
 * (`armedSection`). Pure DOM + form state — the service owns the
 * profile/guide lists, picks, previews, and the apply call.
 */
export class LoftPanel extends FeaturePanel {
  /** The chip at `index` (argument order) was removed. */
  onRemoveProfile?: (index: number) => void;
  /** The chip at `from` was dragged to position `to` (argument order). */
  onReorderProfile?: (from: number, to: number) => void;
  /** The guide chip at `index` was removed. */
  onRemoveGuide?: (index: number) => void;
  /** The scope chip at `index` was removed — the service owns the choices. */
  onRemoveScope?: (index: number) => void;
  /** The armed section changed — the service re-aims the pick channels. */
  onArmedSectionChange?: () => void;

  /** The slot a timeline/viewport sketch pick fills — last clicked. */
  armedSection: 'profiles' | 'guides' | 'scope' = 'profiles';

  private tabs: OpTabs;
  private thin: ThinControl;
  private startCondition: ConditionRow;
  private endCondition: ConditionRow;
  private profilesSlot: PickSlot;
  private guidesSlot: PickSlot;
  private scopeSlot: ScopeSlotControl;

  constructor(container: HTMLElement) {
    super(container, {
      id: 'fluidcad-loft-panel',
      title: 'Loft',
      icon: '/icons/loft.png',
      bodyHtml: `
        <div data-role="tabs" class="join w-full"></div>
        <div data-role="profiles-slot"></div>
        <div data-role="guides-slot"></div>
        <div data-role="start-condition"></div>
        <div data-role="end-condition"></div>
        <div data-role="thin-host" class="contents"></div>
        <div data-role="scope-slot"></div>
      `,
    });

    this.tabs = new OpTabs(this.role('tabs'), [
      { op: 'add', label: 'Add', title: 'Fuse the lofted solid with the model — loft()' },
      { op: 'remove', label: 'Remove', title: 'Cut the lofted solid out of the model — loft().remove()' },
      { op: 'new', label: 'New', title: 'Keep the lofted solid as a separate body — loft().new()' },
    ]);
    this.tabs.onChange = () => {
      this.syncScopeVisible();
      this.onChange?.();
    };
    this.thin = new ThinControl(this.role('thin-host'));
    this.thin.onChange = () => this.onChange?.();
    this.thin.onSubmit = () => this.onApply?.();
    this.startCondition = new ConditionRow(
      this.role('start-condition'),
      'Start condition', 'How the surface takes off from the first profile', 'start',
    );
    this.endCondition = new ConditionRow(
      this.role('end-condition'),
      'End condition', 'How the surface arrives at the last profile', 'end',
    );
    for (const row of [this.startCondition, this.endCondition]) {
      row.onChange = () => this.onChange?.();
      row.onSubmit = () => this.onApply?.();
    }

    this.profilesSlot = new PickSlot(
      this.role('profiles-slot'),
      { label: 'Sketches — in loft order', multiple: true, reorderable: true },
    );
    this.guidesSlot = new PickSlot(
      this.role('guides-slot'),
      { label: 'Guides — optional, up to 2', multiple: true },
    );
    this.profilesSlot.onArm = () => this.setArmedSection('profiles');
    this.guidesSlot.onArm = () => this.setArmedSection('guides');
    this.profilesSlot.onRemove = (index) => this.onRemoveProfile?.(index);
    this.profilesSlot.onReorder = (from, to) => this.onReorderProfile?.(from, to);
    this.guidesSlot.onRemove = (index) => this.onRemoveGuide?.(index);

    this.scopeSlot = new ScopeSlotControl(this.role('scope-slot'));
    this.scopeSlot.onRemove = (index) => this.onRemoveScope?.(index);
    this.scopeSlot.onArm = () => this.setArmedSection('scope');
  }

  show(): void {
    // A fresh arming starts from empty profile/guide/scope lists,
    // unconditioned takeoffs and default form values.
    this.shell.setTitle(null);
    this.tabs.reset();
    this.setProfiles([]);
    this.setGuides([]);
    this.setScopeChips([]);
    this.startCondition.reset();
    this.endCondition.reset();
    this.thin.reset();
    this.setThinBlocked(false);
    this.syncScopeVisible();
    this.setArmedSection('profiles');
    this.shell.show();
  }

  /**
   * Open prefilled from an existing statement (edit mode). The profile and
   * guide chips are the LIVE lists — the service seeds them from the
   * statement's own arguments and every gesture (remove, drag-reorder, face
   * picks, sketch adds) works exactly like create mode; the op tabs,
   * conditions and thin control edit in place.
   */
  showEdit(state: {
    op: FeatureOp;
    thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
    startCondition: LoftConditionRef | null;
    endCondition: LoftConditionRef | null;
  }): void {
    this.shell.setTitle('Edit loft');
    this.setProfiles([]);
    this.setGuides([]);
    this.tabs.setOp(state.op);
    this.thin.setValues(state.thin);
    this.startCondition.set(state.startCondition);
    this.endCondition.set(state.endCondition);
    this.syncScopeVisible();
    this.setArmedSection('profiles');
    this.shell.show();
  }

  /**
   * Render the ordered profile chips; chip N is the loft's argument N.
   * Rows reorder by dragging their grip handle.
   */
  setProfiles(chips: PickSlotChip[]): void {
    this.profilesSlot.setChips(chips.map((chip, index) => ({
      ...chip,
      badge: String(index + 1),
      removable: true,
    })));
  }

  /** Render the guide chips — plain removable rows, no ordering. */
  setGuides(chips: PickSlotChip[]): void {
    this.guidesSlot.setChips(chips.map(chip => ({
      ...chip,
      badge: 'G',
      badgeMuted: true,
      removable: true,
    })));
    this.guidesSlot.setPrompt(chips.length === 0 ? 'Pick guide sketches or helixes' : null);
  }

  /** Guides exclude thin mode — block the toggle while any guide is set. */
  setThinBlocked(blocked: boolean): void {
    this.thin.setBlocked(blocked, 'Guides cannot be combined with thin walls — remove the guides first.');
  }

  values(): LoftValues {
    const thin = this.thin.values();
    if ('error' in thin) {
      return thin;
    }
    const start = this.startCondition.values();
    if ('error' in start) {
      return start;
    }
    const end = this.endCondition.values();
    if ('error' in end) {
      return end;
    }
    return {
      op: this.tabs.op,
      thin: thin.thin,
      startCondition: start.condition,
      endCondition: end.condition,
      newVariables: collectNewVariables([thin, start, end]),
    };
  }

  /** The variables the fields' dropdowns offer (thin + conditions). */
  setScopeVariables(variables: VariableInfo[]): void {
    this.thin.setVariables(variables);
    this.startCondition.setVariables(variables);
    this.endCondition.setVariables(variables);
  }

  /** The boolean operation tab — gates the scope section (New writes none). */
  get op(): FeatureOp {
    return this.tabs.op;
  }

  /** The scope chips (the service owns the choices). */
  setScopeChips(chips: PickSlotChip[]): void {
    this.scopeSlot.setChips(chips);
  }

  /**
   * A separate body has no boolean to scope — the section hides on the New
   * tab, handing the armed border back to the profiles slot.
   */
  private syncScopeVisible(): void {
    this.scopeSlot.setVisible(this.tabs.op !== 'new');
    if (!this.scopeSlot.visible && this.armedSection === 'scope') {
      this.setArmedSection('profiles');
    }
  }

  private setArmedSection(section: 'profiles' | 'guides' | 'scope'): void {
    const changed = this.armedSection !== section;
    this.armedSection = section;
    this.profilesSlot.setArmed(section === 'profiles');
    this.guidesSlot.setArmed(section === 'guides');
    this.scopeSlot.setArmed(section === 'scope');
    if (changed) {
      this.onArmedSectionChange?.();
    }
  }

  /** Profile progress prompt while more profiles are needed; null hides it. */
  setHint(text: string | null): void {
    this.profilesSlot.setPrompt(text);
  }
}
