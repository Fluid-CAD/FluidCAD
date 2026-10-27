import { ChoiceTabs } from '../panel-controls';
import { FeaturePanel } from '../feature-panel';
import { ScopeSlotControl } from '../scope-slot';
import { PickSlot, PickSlotChip } from '../../pick-slot';
import { ChoiceControl, type ChoiceRead } from '../choice-control';
import {
  FeatureRefValue, HoleFastenerSpec, HoleOptionValues, HoleSizeSpec, HoleStyleSpec, NewVariable, ParsedFeatureStatement,
  ValueExpr,
} from '../../../api';
import type { ChoiceItem } from '../../../ui/controls';
import { ExpressionField, ExpressionFieldResult, collectNewVariables } from '../../../ui/expression-field';
import { VariableInfo } from '../../../ui/expression-core';
import { iconUrl } from '../../../ui/icon-url';
import { holeIllustration, type HoleDimension, type HoleStyle } from './hole-illustration';
import {
  DEFAULT_SIZE_LABEL, FASTENER_FITS, SIZE_GROUPS, coarsePitch, defaultDrilledDiameter, pitchGroups, sizeLabels,
  tableCounterbore, tableCountersink, tableDiameter, type FastenerFit, type HoleType,
} from './hole-catalog';

/** Validated form values, or the message to show when a field is invalid. */
export type HoleValues = HoleOptionValues | { error: string };

export type HoleTermination = 'through' | 'blind';

/** The pick slots; exactly one wears the armed border at a time. */
export type HoleArmedSlot = 'placements' | 'scope';

/** The size dropdown's items: every standard's labels under its heading, metric first. */
const SIZE_ITEMS: readonly ChoiceItem<string>[] = SIZE_GROUPS.flatMap(group =>
  sizeLabels(group.standard).map(label => ({ value: label, label, group: group.label })));

/** The pitch dropdowns' items for a size: coarse then fine, each under its heading; none for a size the tables don't list. */
function pitchItems(label: string | null): ChoiceItem<number>[] {
  if (label === null) {
    return [];
  }
  return pitchGroups(label).flatMap(group => group.pitches.map(pitch => ({ ...pitch, group: group.label })));
}

/** The tip angle a blind hole starts with — a standard twist drill. */
const DEFAULT_TIP_ANGLE = 118;

/** Which dimension each editable field draws in the illustration while it has focus. */
const FIELD_DIMENSIONS: Record<string, HoleDimension> = {
  diameter: 'diameter',
  depth: 'depth',
  'tip-angle': 'tipAngle',
  'cbore-diameter': 'counterboreDiameter',
  'cbore-depth': 'counterboreDepth',
  'csink-diameter': 'countersinkDiameter',
  'csink-angle': 'countersinkAngle',
};

/**
 * The hole dialog: the entry style (simple, counterbore, countersink), the
 * placements slot, the termination with its depth and drill-point angle, the
 * hole type with its size (metric and imperial in one list) beside the fit or
 * pitch and the diameter they give, the counterbore or countersink values, the
 * fasten toggle of a clearance hole — the tapped hole cut into the next solid
 * along each hole's axis, the one the fastener threads into — and the scope
 * slot last — the solids the hole is cut from. A section drawing of the hole,
 * the field being edited drawn in colour, floats beside the dialog. Pure DOM +
 * form state: the service owns scene data, picks, previews and the apply call.
 */
export class HolePanel extends FeaturePanel {
  /** The placement chip at `index` was removed. */
  onRemovePlacement?: (index: number) => void;
  /** The scope chip at `index` was removed. */
  onRemoveScope?: (index: number) => void;
  /** The armed slot changed — the service re-aims the viewport channels. */
  onArmedSlotChange?: () => void;

  private styleTabs: ChoiceTabs<HoleStyle>;
  private placementsSlot: PickSlot;
  private scopeSlot: ScopeSlotControl;
  private fastenToggle: HTMLInputElement;
  private fastenPitchControl: ChoiceControl<number>;
  private fastenThroughToggle: HTMLInputElement;
  private fastenDepthField: ExpressionField;
  private fastenTipField: ExpressionField;
  /** The section drawing: the float's side card, and the sheet's copy in the body. */
  private illustrationEls: HTMLElement[];
  private typeSelect: HTMLSelectElement;
  /** The value dropdowns: each lists the parameters in scope under its options and binds to one. */
  private sizeControl: ChoiceControl<string>;
  private fitControl: ChoiceControl<FastenerFit>;
  private pitchControl: ChoiceControl<number>;
  private terminationSelect: HTMLSelectElement;
  private diameterField: ExpressionField;
  private depthField: ExpressionField;
  private tipField: ExpressionField;
  private cboreDiameterField: ExpressionField;
  private cboreDepthField: ExpressionField;
  private csinkDiameterField: ExpressionField;
  private csinkAngleField: ExpressionField;
  private armed: HoleArmedSlot = 'placements';
  private focusedDimension: HoleDimension | null = null;
  /** The table values the counterbore/countersink fields were last seeded with — unchanged fields write no explicit value. */
  private seededCounterbore: { diameter: number; depth: number } | null = null;
  private seededCountersink: { diameter: number; angle: number } | null = null;

  constructor(container: HTMLElement) {
    super(container, {
      id: 'fluidcad-hole-panel',
      title: 'Hole',
      icon: iconUrl('hole'),
      // The three style tabs' labels would crowd the default column.
      width: 'wide',
      bodyHtml: `
        <p class="text-base-content/70 leading-snug">Cuts fastener holes into the model at the places you pick.</p>
        <div data-role="style-tabs" class="join w-full"></div>
        <div data-role="placements-slot"></div>
        <div data-role="illustration" class="sm:hidden text-base-content px-2"></div>
        <label class="flex flex-col gap-1.5" title="Through all cuts every solid in scope; Blind stops at the depth">
          <span class="text-base-content/70">Termination</span>
          <select data-role="termination" class="select select-sm select-bordered w-full text-xs">
            <option value="through">Through all</option>
            <option value="blind">Blind</option>
          </select>
        </label>
        <div data-role="blind-rows" class="hidden gap-2">
          <label class="flex flex-col gap-1.5 flex-1 min-w-0" title="Depth from the surface to the shoulder (the full-diameter depth)">
            <span class="text-base-content/70">Depth</span>
            <input data-role="depth" data-unit="length" type="number" step="0.5" value="10"
              class="input input-sm input-bordered w-full text-xs" />
          </label>
          <label class="flex flex-col gap-1.5 flex-1 min-w-0" title="The drill point angle below the shoulder; 0 leaves a flat bottom">
            <span class="text-base-content/70">Tip angle (°)</span>
            <input data-role="tip-angle" type="number" step="1" value="${DEFAULT_TIP_ANGLE}"
              class="input input-sm input-bordered w-full text-xs" />
          </label>
        </div>
        <label class="flex flex-col gap-1.5" title="Drilled takes the diameter you type; Clearance and Tapped read it from the fastener tables">
          <span class="text-base-content/70">Hole type</span>
          <select data-role="type" class="select select-sm select-bordered w-full text-xs">
            <option value="clearance">Clearance</option>
            <option value="drilled">Drilled</option>
            <option value="tapped">Tapped</option>
          </select>
        </label>
        <div data-role="size-rows" class="flex gap-2">
          <label data-role="size-row" class="flex flex-col gap-1.5 flex-1 min-w-0" title="The fastener the hole is for: ISO metric (M3, M6, …) or unified imperial (#10, 1/4, …)">
            <span class="text-base-content/70">Size</span>
          </label>
          <label data-role="fit-row" class="flex flex-col gap-1.5 flex-1 min-w-0" title="How much room the fastener gets — ISO 273 / ASME B18.2.8 fine, medium and coarse series">
            <span class="text-base-content/70">Fastener fit</span>
          </label>
          <label data-role="pitch-row" class="hidden flex-col gap-1.5 flex-1 min-w-0" title="The thread pitch; the hole is cut at its tap drill diameter (threads are not modelled yet)">
            <span class="text-base-content/70">Pitch</span>
          </label>
        </div>
        <label class="flex flex-col gap-1.5" title="The hole diameter — typed for a drilled hole, from the tables otherwise">
          <span class="text-base-content/70">Diameter</span>
          <input data-role="diameter" data-unit="length" type="number" step="0.1" value="6"
            class="input input-sm input-bordered w-full text-xs" />
        </label>
        <div data-role="cbore-rows" class="hidden gap-2">
          <label class="flex flex-col gap-1.5 flex-1 min-w-0" title="The counterbore diameter at the surface">
            <span class="text-base-content/70">Counterbore Ø</span>
            <input data-role="cbore-diameter" data-unit="length" type="number" step="0.1" value="11"
              class="input input-sm input-bordered w-full text-xs" />
          </label>
          <label class="flex flex-col gap-1.5 flex-1 min-w-0" title="How deep the counterbore goes from the surface">
            <span class="text-base-content/70">Depth</span>
            <input data-role="cbore-depth" data-unit="length" type="number" step="0.1" value="6.8"
              class="input input-sm input-bordered w-full text-xs" />
          </label>
        </div>
        <div data-role="csink-rows" class="hidden gap-2">
          <label class="flex flex-col gap-1.5 flex-1 min-w-0" title="The countersink diameter at the surface">
            <span class="text-base-content/70">Countersink Ø</span>
            <input data-role="csink-diameter" data-unit="length" type="number" step="0.1" value="13.44"
              class="input input-sm input-bordered w-full text-xs" />
          </label>
          <label class="flex flex-col gap-1.5 flex-1 min-w-0" title="The included angle of the countersink cone">
            <span class="text-base-content/70">Angle (°)</span>
            <input data-role="csink-angle" type="number" step="1" value="90"
              class="input input-sm input-bordered w-full text-xs" />
          </label>
        </div>
        <div data-role="fasten-section" class="flex flex-col gap-3.5">
          <div class="border-t border-base-content/10"></div>
          <label class="flex items-center justify-between cursor-pointer" title="On cuts the matching tapped hole into the next solid along each hole's axis — the one the fastener threads into">
            <span class="text-base-content/70">Fasten to the solid below</span>
            <input data-role="fasten" type="checkbox" class="toggle toggle-sm toggle-primary" />
          </label>
          <div data-role="fasten-rows" class="hidden gap-2">
            <label class="flex flex-col gap-1.5 flex-1 min-w-0" title="The tapped hole takes the clearance hole's size — change it above">
              <span class="text-base-content/70">Tapped size</span>
              <input data-role="fasten-size" type="text" readonly tabindex="-1"
                class="input input-sm input-bordered w-full text-xs opacity-70" />
            </label>
            <label data-role="fasten-pitch-row" class="flex flex-col gap-1.5 flex-1 min-w-0" title="The thread pitch of the tapped hole in the solid it fastens to">
              <span class="text-base-content/70">Pitch</span>
            </label>
            <label class="flex flex-col gap-1.5 flex-1 min-w-0" title="The tap drill diameter the tapped hole is cut at, from the fastener tables">
              <span class="text-base-content/70">Tap drill Ø</span>
              <input data-role="fasten-diameter" type="text" readonly tabindex="-1"
                class="input input-sm input-bordered w-full text-xs opacity-70" />
            </label>
          </div>
          <label data-role="fasten-through-wrap" class="hidden items-center justify-between cursor-pointer" title="On taps the whole solid; off stops the tapped hole at a depth">
            <span class="text-base-content/70">Through all</span>
            <input data-role="fasten-through" type="checkbox" class="toggle toggle-sm toggle-primary" checked />
          </label>
          <div data-role="fasten-depth-rows" class="hidden gap-2">
            <label class="flex flex-col gap-1.5 flex-1 min-w-0" title="Depth of the tapped hole, from the face it enters the solid through">
              <span class="text-base-content/70">Tapped depth</span>
              <input data-role="fasten-depth" data-unit="length" type="number" step="0.5" value="10"
                class="input input-sm input-bordered w-full text-xs" />
            </label>
            <label class="flex flex-col gap-1.5 flex-1 min-w-0" title="The drill point angle below the tapped depth; 0 leaves a flat bottom">
              <span class="text-base-content/70">Tip angle (°)</span>
              <input data-role="fasten-tip-angle" type="number" step="1" value="${DEFAULT_TIP_ANGLE}"
                class="input input-sm input-bordered w-full text-xs" />
            </label>
          </div>
        </div>
        <div data-role="scope-slot"></div>
      `,
    });

    this.styleTabs = new ChoiceTabs<HoleStyle>(this.role('style-tabs'), [
      { key: 'simple', label: 'Simple', title: 'A plain hole' },
      { key: 'counterbore', label: 'Counterbore', title: 'A wider, flat-bottomed recess at the entry for a cap screw head' },
      { key: 'countersink', label: 'Countersink', title: 'A conical entry for a flat head screw' },
    ], 'simple', { compact: true });
    this.styleTabs.onChange = () => {
      this.reseedEntry();
      this.syncControls();
      this.onChange?.();
    };
    this.placementsSlot = new PickSlot(this.role('placements-slot'), { label: 'Placements', multiple: true });
    this.placementsSlot.onRemove = (index) => this.onRemovePlacement?.(index);
    this.placementsSlot.onArm = () => this.armSlot('placements');

    this.fastenToggle = this.role('fasten');
    this.fastenThroughToggle = this.role('fasten-through');

    this.scopeSlot = new ScopeSlotControl(this.role('scope-slot'));
    this.scopeSlot.onRemove = (index) => this.onRemoveScope?.(index);
    this.scopeSlot.onArm = () => this.armSlot('scope');

    this.illustrationEls = [this.shell.addSideCard(), this.role('illustration')];

    this.typeSelect = this.role('type');
    this.terminationSelect = this.role('termination');
    this.sizeControl = new ChoiceControl<string>({ items: SIZE_ITEMS, value: DEFAULT_SIZE_LABEL, label: 'Size', dataRole: 'size' });
    this.fitControl = new ChoiceControl<FastenerFit>({ items: FASTENER_FITS, value: 'normal', label: 'Fastener fit', dataRole: 'fit' });
    this.pitchControl = new ChoiceControl<number>({ items: [], placeholder: 'No pitches', label: 'Pitch', dataRole: 'pitch' });
    this.fastenPitchControl = new ChoiceControl<number>({ items: [], placeholder: 'No pitches', label: 'Fasten pitch', dataRole: 'fasten-pitch' });
    this.role('size-row').appendChild(this.sizeControl.element);
    this.role('fit-row').appendChild(this.fitControl.element);
    this.role('pitch-row').appendChild(this.pitchControl.element);
    this.role('fasten-pitch-row').appendChild(this.fastenPitchControl.element);
    this.fillPitches();

    this.typeSelect.addEventListener('change', () => {
      this.reseedDerived();
      this.syncControls();
      this.onChange?.();
    });
    for (const control of [this.fastenToggle, this.fastenThroughToggle]) {
      control.addEventListener('change', () => {
        this.syncFastenRows();
        this.onChange?.();
      });
    }
    this.fastenPitchControl.onChange = () => {
      this.syncFastenRows();
      this.onChange?.();
    };
    this.sizeControl.onChange = () => {
      this.fillPitches();
      this.reseedDerived();
      this.syncFastenRows();
      this.onChange?.();
    };
    this.fitControl.onChange = () => {
      this.reseedDiameter();
      this.onChange?.();
    };
    this.pitchControl.onChange = () => {
      this.reseedDiameter();
      this.onChange?.();
    };
    this.terminationSelect.addEventListener('change', () => {
      this.syncControls();
      this.onChange?.();
    });

    this.diameterField = this.enhance('diameter');
    this.depthField = this.enhance('depth');
    this.tipField = this.enhance('tip-angle');
    this.cboreDiameterField = this.enhance('cbore-diameter');
    this.cboreDepthField = this.enhance('cbore-depth');
    this.csinkDiameterField = this.enhance('csink-diameter');
    this.csinkAngleField = this.enhance('csink-angle');
    this.fastenDepthField = this.enhance('fasten-depth');
    this.fastenTipField = this.enhance('fasten-tip-angle');
    for (const role of Object.keys(FIELD_DIMENSIONS)) {
      const input = this.role<HTMLInputElement>(role);
      input.addEventListener('focus', () => this.highlight(FIELD_DIMENSIONS[role]));
      input.addEventListener('mouseenter', () => this.highlight(FIELD_DIMENSIONS[role]));
      input.addEventListener('blur', () => this.highlight(null));
      input.addEventListener('mouseleave', () => {
        if (document.activeElement !== input) {
          this.highlight(null);
        }
      });
    }
    this.tipField.element.addEventListener('input', () => this.drawIllustration());
    this.syncControls();
  }

  /**
   * The variables the fields' and the dropdowns' lists offer. A dropdown
   * bound to a name resolves it here — a size or pitch read from an edited
   * statement before the scope arrived — so what hangs off it (the pitch
   * lists, the table diameter, untouched entry values, the fasten rows)
   * follows, and the ghost is asked again.
   */
  setScopeVariables(variables: VariableInfo[]): void {
    for (const field of this.fields()) {
      field.setVariables(variables);
    }
    for (const control of this.choices()) {
      control.setVariables(variables);
    }
    if (this.choices().some(control => control.binding !== undefined)) {
      this.fillPitches();
      this.reseedDiameter();
      this.reseedEntry({ untouchedOnly: true });
      this.syncFastenRows();
      this.onChange?.();
    }
  }

  get armedSlot(): HoleArmedSlot {
    return this.armed;
  }

  get style(): HoleStyle {
    return this.styleTabs.value;
  }

  get holeType(): HoleType {
    return this.typeSelect.value as HoleType;
  }

  /** The fastener size the dialog stands on: the chosen label, or the one a bound variable's value selects — null while that is unknown. */
  get sizeLabel(): string | null {
    return this.sizeControl.value ?? null;
  }

  get termination(): HoleTermination {
    return this.terminationSelect.value as HoleTermination;
  }

  /** Only a clearance hole fastens to another solid — the toggle hides otherwise. */
  get fastenAvailable(): boolean {
    return this.holeType === 'clearance';
  }

  /** The hole fastens: a clearance hole with its toggle on writes `.fasten(…)`. */
  get fastened(): boolean {
    return this.fastenAvailable && this.fastenToggle.checked;
  }

  /** The fastened solid's thread pitch as the statement writes it: a variable bare, null for the coarse pitch. */
  fastenPitch(): number | FeatureRefValue | null {
    const read = this.fastenPitchControl.read();
    if ('error' in read) {
      return null;
    }
    return 'ref' in read ? { ref: read.ref } : this.writtenPitch(read.value);
  }

  /** The tap drill diameter the fastened solid is cut at, in the document unit; null while the size or the pitch resolves to nothing. */
  fastenDiameter(): number | null {
    const pitch = HolePanel.tablePitch(this.fastenPitchControl);
    if (this.sizeLabel === null || pitch === undefined) {
      return null;
    }
    return tableDiameter(this.sizeLabel, 'tapped', { pitch });
  }

  /** A chosen pitch as the statement writes it: the coarse pitch is what a bare `.tapped()` / `.fasten()` means — written without a value. */
  private writtenPitch(pitch: number): number | null {
    return this.sizeLabel !== null && pitch === coarsePitch(this.sizeLabel) ? null : pitch;
  }

  /**
   * The pitch a dropdown gives the tables: the option's number, null for
   * none (the coarse pitch), undefined while a bound name resolves to nothing
   * — no diameter can be read for it.
   */
  private static tablePitch(control: ChoiceControl<number>): number | null | undefined {
    if (control.binding !== undefined && control.value === undefined) {
      return undefined;
    }
    return control.value ?? null;
  }

  /** The fastened solid's tapped hole stops at a depth instead of running through it. */
  private get fastenBlind(): boolean {
    return this.fastened && !this.fastenThroughToggle.checked;
  }

  /** The tapped hole's blind depth as the statement writes it; null for through all (or an unreadable field). */
  fastenDepth(): ValueExpr | null {
    if (!this.fastenBlind) {
      return null;
    }
    const read = this.fastenDepthField.read();
    return 'error' in read ? null : read.value;
  }

  /** The drill point angle below the tapped hole's blind depth; null for a flat bottom (0), through all or an unreadable field. */
  fastenTipAngle(): ValueExpr | null {
    if (!this.fastenBlind) {
      return null;
    }
    const read = this.fastenTipField.read();
    return 'error' in read || read.value === 0 ? null : read.value;
  }

  show(): void {
    // A fresh arming starts from defaults — the previous session's form
    // values would otherwise carry over.
    this.shell.setTitle(null);
    this.styleTabs.reset();
    this.sizeControl.setValue(DEFAULT_SIZE_LABEL);
    this.typeSelect.value = 'clearance';
    this.fitControl.setValue('normal');
    this.fillPitches();
    this.fastenToggle.checked = false;
    this.fastenThroughToggle.checked = true;
    this.fastenDepthField.setValue(10);
    this.fastenTipField.setValue(DEFAULT_TIP_ANGLE);
    this.terminationSelect.value = 'through';
    this.depthField.setValue(10);
    this.tipField.setValue(DEFAULT_TIP_ANGLE);
    this.reseedDerived();
    this.armSlot('placements', { silent: true });
    this.syncControls();
    this.shell.show();
  }

  /**
   * Open prefilled from an existing statement (edit mode). The placement
   * and scope chips are the service's — it seeds one kept chip per
   * argument, removed and re-picked like create mode.
   */
  showEdit(parsed: Extract<ParsedFeatureStatement, { feature: 'hole' }>): void {
    this.shell.setTitle('Edit hole');
    this.styleTabs.setValue(parsed.style?.kind ?? 'simple');
    const fastenerLabel = parsed.size.kind === 'fastener' ? parsed.size.label : null;
    HolePanel.seed(this.sizeControl, SIZE_ITEMS, fastenerLabel, DEFAULT_SIZE_LABEL);
    if (parsed.size.kind === 'diameter') {
      this.typeSelect.value = 'drilled';
    } else {
      this.typeSelect.value = parsed.fastener?.type ?? 'clearance';
    }
    HolePanel.seed(this.fitControl, FASTENER_FITS, parsed.fastener?.type === 'clearance' ? parsed.fastener.fit : null, 'normal');
    this.fillPitches();
    // A statement's pitch the list doesn't carry stays on the coarse one, as the lists are filled; a variable binds whatever it holds.
    const pitches = pitchItems(this.sizeLabel);
    if (parsed.fastener?.type === 'tapped') {
      HolePanel.seed(this.pitchControl, pitches, parsed.fastener.pitch, this.pitchControl.value);
    }
    this.fastenToggle.checked = !!parsed.fasten;
    if (parsed.fasten) {
      HolePanel.seed(this.fastenPitchControl, pitches, parsed.fasten.pitch, this.fastenPitchControl.value);
    }
    const fastenDepth = parsed.fasten?.depth ?? null;
    this.fastenThroughToggle.checked = fastenDepth === null;
    this.fastenDepthField.setValue(fastenDepth ?? 10);
    // A blind statement without a tip angle has a flat bottom; a through one opens Blind on the standard drill.
    this.fastenTipField.setValue(fastenDepth === null ? DEFAULT_TIP_ANGLE : parsed.fasten?.tipAngle ?? 0);
    this.reseedDerived();
    if (parsed.size.kind === 'diameter') {
      this.diameterField.setValue(parsed.size.value);
    }
    if (parsed.style?.kind === 'counterbore') {
      if (parsed.style.diameter !== null) {
        this.cboreDiameterField.setValue(parsed.style.diameter);
      }
      if (parsed.style.depth !== null) {
        this.cboreDepthField.setValue(parsed.style.depth);
      }
    } else if (parsed.style?.kind === 'countersink') {
      if (parsed.style.diameter !== null) {
        this.csinkDiameterField.setValue(parsed.style.diameter);
      }
      if (parsed.style.angle !== null) {
        this.csinkAngleField.setValue(parsed.style.angle);
      }
    }
    this.terminationSelect.value = parsed.depth === null ? 'through' : 'blind';
    this.depthField.setValue(parsed.depth ?? 10);
    this.tipField.setValue(parsed.tipAngle ?? 0);
    this.armSlot('placements', { silent: true });
    this.syncControls();
    this.shell.show();
  }

  /** The placement chips (the service owns the choices). */
  setPlacements(chips: PickSlotChip[], prompt: string | null): void {
    this.placementsSlot.setChips(chips);
    this.placementsSlot.setPrompt(prompt);
  }

  /** The scope chips (the service owns the choices; prompts are the slot's). */
  setScope(chips: PickSlotChip[]): void {
    this.scopeSlot.setChips(chips);
  }

  /** Move the armed border to `slot` (a slot click, or the service re-aiming). */
  armSlot(slot: HoleArmedSlot, opts: { silent?: boolean } = {}): void {
    const changed = this.armed !== slot;
    this.armed = slot;
    this.placementsSlot.setArmed(slot === 'placements');
    this.scopeSlot.setArmed(slot === 'scope');
    if (changed && !opts.silent) {
      this.onArmedSlotChange?.();
    }
  }

  /** The diameter the tables give the current choice (null for a drilled hole, or while a bound size, fit or pitch resolves to nothing). */
  derivedDiameter(): number | null {
    const fit = this.fitControl.value;
    const pitch = HolePanel.tablePitch(this.pitchControl);
    if (this.sizeLabel === null || fit === undefined || pitch === undefined) {
      return null;
    }
    return tableDiameter(this.sizeLabel, this.holeType, { fit, pitch });
  }

  values(): HoleValues {
    const type = this.holeType;
    const reads: Parameters<typeof collectNewVariables>[0] = [];

    let size: HoleSizeSpec;
    let fastener: HoleFastenerSpec | null;
    if (type === 'drilled') {
      const diameter = this.diameterField.read();
      if ('error' in diameter || (typeof diameter.value === 'number' && diameter.value <= 0)) {
        return { error: `Enter a positive diameter.${this.detail(diameter)}` };
      }
      reads.push(diameter);
      size = { kind: 'diameter', value: diameter.value };
      fastener = null;
    } else {
      // A dropdown bound to a variable writes its name; one bound to a value no option carries refuses.
      const sizeRead = this.sizeControl.read();
      if ('error' in sizeRead) {
        return { error: sizeRead.error };
      }
      reads.push(HolePanel.declared(sizeRead));
      size = { kind: 'fastener', label: 'ref' in sizeRead ? { ref: sizeRead.ref } : sizeRead.value };
      if (type === 'clearance') {
        const fitRead = this.fitControl.read();
        if ('error' in fitRead) {
          return { error: fitRead.error };
        }
        reads.push(HolePanel.declared(fitRead));
        fastener = { type: 'clearance', fit: 'ref' in fitRead ? { ref: fitRead.ref } : fitRead.value };
      } else {
        const pitchRead = this.pitchControl.read();
        if ('error' in pitchRead) {
          return { error: pitchRead.error };
        }
        reads.push(HolePanel.declared(pitchRead));
        // A variable always writes the argument; the coarse pitch collapses to a bare `.tapped()`.
        fastener = { type: 'tapped', pitch: 'ref' in pitchRead ? { ref: pitchRead.ref } : this.writtenPitch(pitchRead.value) };
      }
      if (this.fastened) {
        const fastenPitchRead = this.fastenPitchControl.read();
        if ('error' in fastenPitchRead) {
          return { error: fastenPitchRead.error };
        }
        reads.push(HolePanel.declared(fastenPitchRead));
      }
    }

    let style: HoleStyleSpec | null = null;
    if (this.style === 'counterbore') {
      const diameter = this.cboreDiameterField.read();
      const depth = this.cboreDepthField.read();
      if ('error' in diameter || (typeof diameter.value === 'number' && diameter.value <= 0)) {
        return { error: `Enter a positive counterbore diameter.${this.detail(diameter)}` };
      }
      if ('error' in depth || (typeof depth.value === 'number' && depth.value <= 0)) {
        return { error: `Enter a positive counterbore depth.${this.detail(depth)}` };
      }
      reads.push(diameter, depth);
      // Unchanged table values are left to the tables: the statement reads
      // `.counterbore()` and follows the standard if the size changes.
      const seeded = type !== 'drilled' && this.seededCounterbore;
      const explicit = !seeded || diameter.value !== seeded.diameter || depth.value !== seeded.depth;
      style = {
        kind: 'counterbore',
        diameter: explicit ? diameter.value : null,
        depth: explicit ? depth.value : null,
      };
    } else if (this.style === 'countersink') {
      const diameter = this.csinkDiameterField.read();
      const angle = this.csinkAngleField.read();
      if ('error' in diameter || (typeof diameter.value === 'number' && diameter.value <= 0)) {
        return { error: `Enter a positive countersink diameter.${this.detail(diameter)}` };
      }
      if ('error' in angle || (typeof angle.value === 'number' && (angle.value <= 0 || angle.value >= 180))) {
        return { error: `Enter a countersink angle between 0 and 180 degrees.${this.detail(angle)}` };
      }
      reads.push(diameter, angle);
      const seeded = type !== 'drilled' && this.seededCountersink;
      const explicit = !seeded || diameter.value !== seeded.diameter || angle.value !== seeded.angle;
      style = {
        kind: 'countersink',
        diameter: explicit ? diameter.value : null,
        angle: explicit ? angle.value : null,
      };
    }

    let depth: ValueExpr | null = null;
    let tipAngle: ValueExpr | null = null;
    if (this.termination === 'blind') {
      const depthRead = this.depthField.read();
      if ('error' in depthRead || (typeof depthRead.value === 'number' && depthRead.value <= 0)) {
        return { error: `Enter a positive depth.${this.detail(depthRead)}` };
      }
      reads.push(depthRead);
      depth = depthRead.value;
      const tipRead = this.tipField.read();
      if ('error' in tipRead && tipRead.error !== 'empty') {
        return { error: `Tip angle: ${tipRead.error}.` };
      }
      if (!('error' in tipRead)) {
        if (typeof tipRead.value === 'number' && (tipRead.value < 0 || tipRead.value >= 180)) {
          return { error: 'Enter a tip angle between 0 (flat) and 180 degrees.' };
        }
        if (tipRead.value !== 0) {
          reads.push(tipRead);
          tipAngle = tipRead.value;
        }
      }
    }

    if (this.fastenBlind) {
      const fastenDepth = this.fastenDepthField.read();
      if ('error' in fastenDepth || (typeof fastenDepth.value === 'number' && fastenDepth.value <= 0)) {
        return { error: `Enter a positive tapped depth.${this.detail(fastenDepth)}` };
      }
      reads.push(fastenDepth);
      const fastenTip = this.fastenTipField.read();
      if ('error' in fastenTip && fastenTip.error !== 'empty') {
        return { error: `Tapped tip angle: ${fastenTip.error}.` };
      }
      if (!('error' in fastenTip)) {
        if (typeof fastenTip.value === 'number' && (fastenTip.value < 0 || fastenTip.value >= 180)) {
          return { error: 'Enter a tapped tip angle between 0 (flat) and 180 degrees.' };
        }
        if (fastenTip.value !== 0) {
          reads.push(fastenTip);
        }
      }
    }

    return {
      size,
      fastener,
      style,
      depth,
      tipAngle,
      newVariables: collectNewVariables(reads),
    };
  }

  /**
   * The numbers the ghost is drawn with: the derived diameter and the entry
   * values the fields hold. None while the tables give no diameter — a
   * dropdown bound to a name that resolves to nothing: the diameter field
   * still shows the last one, which is not this hole's.
   */
  ghostNumbers(): {
    diameter: ValueExpr; counterbore: { diameter: ValueExpr; depth: ValueExpr } | null;
    countersink: { diameter: ValueExpr; angle: ValueExpr } | null;
  } | null {
    if (this.holeType !== 'drilled' && this.derivedDiameter() === null) {
      return null;
    }
    const diameterRead = this.diameterField.read();
    if ('error' in diameterRead) {
      return null;
    }
    let counterbore: { diameter: ValueExpr; depth: ValueExpr } | null = null;
    let countersink: { diameter: ValueExpr; angle: ValueExpr } | null = null;
    if (this.style === 'counterbore') {
      const diameter = this.cboreDiameterField.read();
      const depth = this.cboreDepthField.read();
      if ('error' in diameter || 'error' in depth) {
        return null;
      }
      counterbore = { diameter: diameter.value, depth: depth.value };
    } else if (this.style === 'countersink') {
      const diameter = this.csinkDiameterField.read();
      const angle = this.csinkAngleField.read();
      if ('error' in diameter || 'error' in angle) {
        return null;
      }
      countersink = { diameter: diameter.value, angle: angle.value };
    }
    return { diameter: diameterRead.value, counterbore, countersink };
  }

  private detail(read: ExpressionFieldResult): string {
    return 'error' in read && read.error !== 'empty' ? ` ${read.error}.` : '';
  }

  /** The parameter a dropdown declared over its option, to land with the statement; nothing for a chosen option or a variable the file has. */
  private static declared<V extends string | number>(read: ChoiceRead<V>): { newVariable?: NewVariable } | null {
    return 'ref' in read && read.newVariable ? { newVariable: read.newVariable } : null;
  }

  /**
   * Seed a dropdown from a parsed slot: a variable binds (resolved once the
   * scope's variables arrive), a listed option is chosen, anything else —
   * null, a value the list doesn't carry — takes the fallback.
   */
  private static seed<V extends string | number>(
    control: ChoiceControl<V>,
    items: readonly ChoiceItem<V>[],
    value: V | FeatureRefValue | null,
    fallback: V | undefined,
  ): void {
    if (value !== null && typeof value === 'object') {
      control.setRef(value.ref);
      return;
    }
    const listed = value !== null && items.some(item => item.value === value);
    control.setValue(listed ? value as V : fallback);
  }

  /** The four dropdowns, as what the scope's variables reach. */
  private choices(): { setVariables(variables: VariableInfo[]): void; readonly binding: FeatureRefValue | undefined }[] {
    return [this.sizeControl, this.fitControl, this.pitchControl, this.fastenPitchControl];
  }

  private fields(): ExpressionField[] {
    return [
      this.diameterField, this.depthField, this.tipField,
      this.cboreDiameterField, this.cboreDepthField, this.csinkDiameterField, this.csinkAngleField,
      this.fastenDepthField, this.fastenTipField,
    ];
  }

  /**
   * Both pitch lists follow the size: the tapped hole's own, and the fastened
   * solid's. A chosen pitch starts over on the coarse one (the first); a
   * bound variable stays, resolved against the new list.
   */
  private fillPitches(): void {
    const items = pitchItems(this.sizeLabel);
    for (const control of [this.pitchControl, this.fastenPitchControl]) {
      control.setItems(items);
      if (control.binding === undefined) {
        control.setValue(items[0]?.value);
      }
    }
  }

  /** The fasten section shows for a clearance hole; its tapped-hole rows once the toggle is on. */
  private syncFastenRows(): void {
    this.toggleRow('fasten-section', this.fastenAvailable, 'flex');
    this.toggleRow('fasten-rows', this.fastened, 'flex');
    this.toggleRow('fasten-through-wrap', this.fastened, 'flex');
    this.toggleRow('fasten-depth-rows', this.fastenBlind, 'flex');
    // The tapped size follows the clearance hole's: its label, or the bare name of a variable that resolves to nothing yet.
    this.role<HTMLInputElement>('fasten-size').value = this.sizeLabel ?? this.sizeControl.binding?.ref ?? '';
    const diameter = this.fastenDiameter();
    this.role<HTMLInputElement>('fasten-diameter').value = diameter === null ? '' : String(diameter);
  }

  /** The diameter and the entry values follow the size, fit and pitch choice. */
  private reseedDerived(): void {
    this.reseedDiameter();
    this.reseedEntry();
  }

  private reseedDiameter(): void {
    if (this.holeType === 'drilled') {
      // Leaving a fastener type keeps its diameter as the typed start point.
      const previous = this.diameterField.read();
      if ('error' in previous) {
        this.diameterField.setValue(defaultDrilledDiameter());
      }
      return;
    }
    const derived = this.derivedDiameter();
    if (derived !== null) {
      this.diameterField.setValue(derived);
    }
  }

  /**
   * The entry values follow the size's table row. While a bound size resolves
   * to nothing, the values the fields hold stand for the row (so an untouched
   * entry still writes `.counterbore()`, left to the tables — the variable
   * decides at build time). `untouchedOnly` (the scope's variables arriving)
   * reseeds a field pair only while it still holds its last seed: values an
   * edited statement spelled out, or the user typed, stay.
   */
  private reseedEntry(opts: { untouchedOnly?: boolean } = {}): void {
    if (this.holeType === 'drilled') {
      this.seededCounterbore = null;
      this.seededCountersink = null;
      return;
    }
    const label = this.sizeLabel;
    const counterbore = label === null ? this.heldPair(this.cboreDiameterField, this.cboreDepthField) : tableCounterbore(label);
    if (counterbore && (!opts.untouchedOnly || this.untouched(this.seededCounterbore, this.cboreDiameterField, this.cboreDepthField))) {
      this.seededCounterbore = counterbore;
      this.cboreDiameterField.setValue(counterbore.diameter);
      this.cboreDepthField.setValue(counterbore.depth);
    }
    const countersink = label === null ? this.heldPair(this.csinkDiameterField, this.csinkAngleField) : tableCountersink(label);
    if (countersink && (!opts.untouchedOnly || this.untouched(this.seededCountersink, this.csinkDiameterField, this.csinkAngleField))) {
      this.seededCountersink = { diameter: countersink.diameter, angle: countersink.angle };
      this.csinkDiameterField.setValue(countersink.diameter);
      this.csinkAngleField.setValue(countersink.angle);
    }
  }

  /** The numbers two entry fields hold, as a seed; null when either holds an expression or nothing. */
  private heldPair(first: ExpressionField, second: ExpressionField): { diameter: number; depth: number; angle: number } | null {
    const a = first.read();
    const b = second.read();
    if ('error' in a || 'error' in b || typeof a.value !== 'number' || typeof b.value !== 'number') {
      return null;
    }
    return { diameter: a.value, depth: b.value, angle: b.value };
  }

  /** Whether two entry fields still hold their last seed — nothing typed over them since. */
  private untouched(seed: { diameter: number; depth?: number; angle?: number } | null, first: ExpressionField, second: ExpressionField): boolean {
    if (!seed) {
      return false;
    }
    const a = first.read();
    const b = second.read();
    return !('error' in a) && !('error' in b) && a.value === seed.diameter && b.value === (seed.depth ?? seed.angle);
  }

  /** Show the rows the current choices need; the diameter is typed only for a drilled hole. */
  private syncControls(): void {
    const type = this.holeType;
    const fastener = type !== 'drilled';
    this.toggleRow('size-rows', fastener, 'flex');
    this.toggleRow('fit-row', type === 'clearance', 'flex');
    this.toggleRow('pitch-row', type === 'tapped', 'flex');
    const diameter = this.role<HTMLInputElement>('diameter');
    diameter.readOnly = fastener;
    diameter.classList.toggle('opacity-70', fastener);
    diameter.title = fastener ? 'From the fastener tables — switch to Drilled to type a diameter' : '';
    this.toggleRow('cbore-rows', this.style === 'counterbore', 'flex');
    this.toggleRow('csink-rows', this.style === 'countersink', 'flex');
    this.toggleRow('blind-rows', this.termination === 'blind', 'flex');
    this.syncFastenRows();
    this.drawIllustration();
  }

  private toggleRow(role: string, visible: boolean, display: 'flex'): void {
    const el = this.role(role);
    // `.flex` outranks `.hidden` in the stylesheet — toggle both.
    el.classList.toggle('hidden', !visible);
    el.classList.toggle(display, visible);
  }

  private highlight(dimension: HoleDimension | null): void {
    this.focusedDimension = dimension;
    this.drawIllustration();
  }

  private drawIllustration(): void {
    const tipRead = this.tipField.read();
    const tip = !('error' in tipRead) && !(typeof tipRead.value === 'number' && tipRead.value === 0);
    for (const el of this.illustrationEls) {
      // One SVG per host — each carries its own arrow marker ids.
      el.innerHTML = holeIllustration({
        style: this.style,
        through: this.termination === 'through',
        tip,
        highlight: this.focusedDimension ?? 'diameter',
      });
    }
  }
}
