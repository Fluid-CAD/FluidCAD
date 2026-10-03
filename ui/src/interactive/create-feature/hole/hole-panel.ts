import { ChoiceTabs } from '../panel-controls';
import { FeaturePanel } from '../feature-panel';
import { ScopeSlotControl } from '../scope-slot';
import { PickSlot, PickSlotChip } from '../../pick-slot';
import {
  HoleFastenerSpec, HoleOptionValues, HoleSizeSpec, HoleStyleSpec, ParsedFeatureStatement, ValueExpr,
} from '../../../api';
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
export type HoleArmedSlot = 'placements' | 'fasten' | 'scope';

/** Append a labelled `<optgroup>` of `options` to `select`. */
function appendOptionGroup(select: HTMLSelectElement, label: string, options: { value: string; label: string }[]): void {
  const optgroup = document.createElement('optgroup');
  optgroup.label = label;
  for (const entry of options) {
    const option = document.createElement('option');
    option.value = entry.value;
    option.textContent = entry.label;
    optgroup.appendChild(option);
  }
  select.appendChild(optgroup);
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
 * fasten slot of a clearance hole — the solid the fastener threads into, with
 * the tapped hole it takes — and the scope slot last — the solids the hole is
 * cut from. A section drawing of the hole,
 * the field being edited drawn in colour, floats beside the dialog. Pure DOM +
 * form state: the service owns scene data, picks, previews and the apply call.
 */
export class HolePanel extends FeaturePanel {
  /** The placement chip at `index` was removed. */
  onRemovePlacement?: (index: number) => void;
  /** The scope chip at `index` was removed. */
  onRemoveScope?: (index: number) => void;
  /** The fasten chip was removed. */
  onRemoveFasten?: () => void;
  /** The armed slot changed — the service re-aims the viewport channels. */
  onArmedSlotChange?: () => void;

  private styleTabs: ChoiceTabs<HoleStyle>;
  private placementsSlot: PickSlot;
  private scopeSlot: ScopeSlotControl;
  private fastenSlot: PickSlot;
  private fastenPitchSelect: HTMLSelectElement;
  private fastenThroughToggle: HTMLInputElement;
  private fastenDepthField: ExpressionField;
  private fastenTipField: ExpressionField;
  /** A solid sits in the fasten slot — its tapped-hole rows show. */
  private fastenPicked = false;
  /** The section drawing: the float's side card, and the sheet's copy in the body. */
  private illustrationEls: HTMLElement[];
  private typeSelect: HTMLSelectElement;
  private sizeSelect: HTMLSelectElement;
  private fitSelect: HTMLSelectElement;
  private pitchSelect: HTMLSelectElement;
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
          <label class="flex flex-col gap-1.5 flex-1 min-w-0" title="The fastener the hole is for: ISO metric (M3, M6, …) or unified imperial (#10, 1/4, …)">
            <span class="text-base-content/70">Size</span>
            <select data-role="size" class="select select-sm select-bordered w-full text-xs"></select>
          </label>
          <label data-role="fit-row" class="flex flex-col gap-1.5 flex-1 min-w-0" title="How much room the fastener gets — ISO 273 / ASME B18.2.8 fine, medium and coarse series">
            <span class="text-base-content/70">Fastener fit</span>
            <select data-role="fit" class="select select-sm select-bordered w-full text-xs"></select>
          </label>
          <label data-role="pitch-row" class="hidden flex-col gap-1.5 flex-1 min-w-0" title="The thread pitch; the hole is cut at its tap drill diameter (threads are not modelled yet)">
            <span class="text-base-content/70">Pitch</span>
            <select data-role="pitch" class="select select-sm select-bordered w-full text-xs"></select>
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
          <div data-role="fasten-slot"></div>
          <div data-role="fasten-rows" class="hidden gap-2">
            <label class="flex flex-col gap-1.5 flex-1 min-w-0" title="The tapped hole takes the clearance hole's size — change it above">
              <span class="text-base-content/70">Tapped size</span>
              <input data-role="fasten-size" type="text" readonly tabindex="-1"
                class="input input-sm input-bordered w-full text-xs opacity-70" />
            </label>
            <label class="flex flex-col gap-1.5 flex-1 min-w-0" title="The thread pitch of the tapped hole in the solid it fastens to">
              <span class="text-base-content/70">Pitch</span>
              <select data-role="fasten-pitch" class="select select-sm select-bordered w-full text-xs"></select>
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

    this.fastenSlot = new PickSlot(this.role('fasten-slot'), { label: 'Fasten to', multiple: false });
    this.fastenSlot.setPrompt('Optional: pick the solid the fastener threads into');
    this.fastenSlot.onRemove = () => this.onRemoveFasten?.();
    this.fastenSlot.onArm = () => this.armSlot('fasten');
    this.fastenPitchSelect = this.role('fasten-pitch');
    this.fastenThroughToggle = this.role('fasten-through');

    this.scopeSlot = new ScopeSlotControl(this.role('scope-slot'));
    this.scopeSlot.onRemove = (index) => this.onRemoveScope?.(index);
    this.scopeSlot.onArm = () => this.armSlot('scope');

    this.illustrationEls = [this.shell.addSideCard(), this.role('illustration')];

    this.typeSelect = this.role('type');
    this.sizeSelect = this.role('size');
    this.fitSelect = this.role('fit');
    this.pitchSelect = this.role('pitch');
    this.terminationSelect = this.role('termination');
    for (const fit of FASTENER_FITS) {
      const option = document.createElement('option');
      option.value = fit.value;
      option.textContent = fit.label;
      this.fitSelect.appendChild(option);
    }
    this.fillSizes();
    this.selectSize(DEFAULT_SIZE_LABEL);
    this.fillPitches();

    this.typeSelect.addEventListener('change', () => {
      this.reseedDerived();
      // The fasten slot leaves with the clearance type — picks go back to the placements.
      if (this.armed === 'fasten' && !this.fastenAvailable) {
        this.armSlot('placements');
      }
      this.syncControls();
      this.onChange?.();
    });
    for (const control of [this.fastenPitchSelect, this.fastenThroughToggle]) {
      control.addEventListener('change', () => {
        this.syncFastenRows();
        this.onChange?.();
      });
    }
    this.sizeSelect.addEventListener('change', () => {
      this.fillPitches();
      this.reseedDerived();
      this.syncFastenRows();
      this.onChange?.();
    });
    this.fitSelect.addEventListener('change', () => {
      this.reseedDiameter();
      this.onChange?.();
    });
    this.pitchSelect.addEventListener('change', () => {
      this.reseedDiameter();
      this.onChange?.();
    });
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

  /** The variables the fields' dropdowns offer. */
  setScopeVariables(variables: VariableInfo[]): void {
    for (const field of this.fields()) {
      field.setVariables(variables);
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

  get sizeLabel(): string {
    return this.sizeSelect.value;
  }

  get termination(): HoleTermination {
    return this.terminationSelect.value as HoleTermination;
  }

  /** Only a clearance hole fastens to another solid — the slot hides otherwise. */
  get fastenAvailable(): boolean {
    return this.holeType === 'clearance';
  }

  /** The fastened solid's thread pitch as the statement writes it: null for the coarse pitch. */
  fastenPitch(): number | null {
    const value = Number(this.fastenPitchSelect.value);
    const pitch = Number.isFinite(value) && value > 0 ? value : null;
    return pitch !== null && pitch === coarsePitch(this.sizeLabel) ? null : pitch;
  }

  /** The tap drill diameter the fastened solid is cut at, in the document unit. */
  fastenDiameter(): number | null {
    return tableDiameter(this.sizeLabel, 'tapped', { pitch: this.fastenPitch() });
  }

  /** The fastened solid's tapped hole stops at a depth instead of running through it. */
  private get fastenBlind(): boolean {
    return this.fastenAvailable && this.fastenPicked && !this.fastenThroughToggle.checked;
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

  /** The fasten chip (the service owns the choice); null empties the slot. */
  setFasten(chip: PickSlotChip | null): void {
    this.fastenPicked = chip !== null;
    this.fastenSlot.setChips(chip ? [chip] : []);
    this.syncFastenRows();
  }

  show(): void {
    // A fresh arming starts from defaults — the previous session's form
    // values would otherwise carry over.
    this.shell.setTitle(null);
    this.styleTabs.reset();
    this.selectSize(DEFAULT_SIZE_LABEL);
    this.typeSelect.value = 'clearance';
    this.fitSelect.value = 'normal';
    this.fillPitches();
    this.fastenThroughToggle.checked = true;
    this.fastenDepthField.setValue(10);
    this.fastenTipField.setValue(DEFAULT_TIP_ANGLE);
    this.setFasten(null);
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
    this.selectSize(fastenerLabel ?? DEFAULT_SIZE_LABEL);
    if (parsed.size.kind === 'diameter') {
      this.typeSelect.value = 'drilled';
    } else {
      this.typeSelect.value = parsed.fastener?.type ?? 'clearance';
    }
    this.fitSelect.value = parsed.fastener?.type === 'clearance' ? parsed.fastener.fit : 'normal';
    this.fillPitches();
    if (parsed.fastener?.type === 'tapped' && parsed.fastener.pitch !== null) {
      this.pitchSelect.value = String(parsed.fastener.pitch);
    }
    if (parsed.fasten && parsed.fasten.pitch !== null) {
      this.fastenPitchSelect.value = String(parsed.fasten.pitch);
    }
    const fastenDepth = parsed.fasten?.depth ?? null;
    this.fastenThroughToggle.checked = fastenDepth === null;
    this.fastenDepthField.setValue(fastenDepth ?? 10);
    // A blind statement without a tip angle has a flat bottom; a through one opens Blind on the standard drill.
    this.fastenTipField.setValue(fastenDepth === null ? DEFAULT_TIP_ANGLE : parsed.fasten?.tipAngle ?? 0);
    this.setFasten(null);
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
    this.fastenSlot.setArmed(slot === 'fasten');
    this.scopeSlot.setArmed(slot === 'scope');
    if (changed && !opts.silent) {
      this.onArmedSlotChange?.();
    }
  }

  /** The diameter the tables give the current choice (null for a drilled hole). */
  derivedDiameter(): number | null {
    return tableDiameter(this.sizeLabel, this.holeType, {
      fit: this.fitSelect.value as FastenerFit,
      pitch: this.selectedPitch(),
    });
  }

  values(): HoleValues {
    const type = this.holeType;
    const reads: (ExpressionFieldResult | null)[] = [];

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
      size = { kind: 'fastener', label: this.sizeLabel };
      if (type === 'clearance') {
        fastener = { type: 'clearance', fit: this.fitSelect.value as FastenerFit };
      } else {
        const pitch = this.selectedPitch();
        // The coarse pitch is what a bare `.tapped()` means — written without a value.
        fastener = { type: 'tapped', pitch: pitch !== null && pitch === coarsePitch(this.sizeLabel) ? null : pitch };
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
      newVariables: collectNewVariables(reads.map(r => r && !('error' in r) ? r : null)),
    };
  }

  /** The numbers the ghost is drawn with: the derived diameter and the entry values the fields hold. */
  ghostNumbers(): {
    diameter: ValueExpr; counterbore: { diameter: ValueExpr; depth: ValueExpr } | null;
    countersink: { diameter: ValueExpr; angle: ValueExpr } | null;
  } | null {
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

  private fields(): ExpressionField[] {
    return [
      this.diameterField, this.depthField, this.tipField,
      this.cboreDiameterField, this.cboreDepthField, this.csinkDiameterField, this.csinkAngleField,
      this.fastenDepthField, this.fastenTipField,
    ];
  }

  private selectedPitch(): number | null {
    const value = Number(this.pitchSelect.value);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  private fillSizes(): void {
    for (const group of SIZE_GROUPS) {
      const sizes = sizeLabels(group.standard).map(label => ({ value: label, label }));
      appendOptionGroup(this.sizeSelect, group.label, sizes);
    }
  }

  /** Select `label`, or the default size when the tables don't list it. */
  private selectSize(label: string): void {
    this.sizeSelect.value = label;
    if (this.sizeSelect.value !== label) {
      this.sizeSelect.value = DEFAULT_SIZE_LABEL;
    }
  }

  /** Both pitch lists follow the size: the tapped hole's own, and the fastened solid's. */
  private fillPitches(): void {
    for (const select of [this.pitchSelect, this.fastenPitchSelect]) {
      select.innerHTML = '';
      for (const group of pitchGroups(this.sizeLabel)) {
        const pitches = group.pitches.map(pitch => ({ value: String(pitch.value), label: pitch.label }));
        appendOptionGroup(select, group.label, pitches);
      }
    }
  }

  /** The fasten section shows for a clearance hole; its tapped-hole rows once a solid is picked. */
  private syncFastenRows(): void {
    this.toggleRow('fasten-section', this.fastenAvailable, 'flex');
    this.toggleRow('fasten-rows', this.fastenAvailable && this.fastenPicked, 'flex');
    this.toggleRow('fasten-through-wrap', this.fastenAvailable && this.fastenPicked, 'flex');
    this.toggleRow('fasten-depth-rows', this.fastenBlind, 'flex');
    this.role<HTMLInputElement>('fasten-size').value = this.sizeLabel;
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

  private reseedEntry(): void {
    if (this.holeType === 'drilled') {
      this.seededCounterbore = null;
      this.seededCountersink = null;
      return;
    }
    const counterbore = tableCounterbore(this.sizeLabel);
    if (counterbore) {
      this.seededCounterbore = counterbore;
      this.cboreDiameterField.setValue(counterbore.diameter);
      this.cboreDepthField.setValue(counterbore.depth);
    }
    const countersink = tableCountersink(this.sizeLabel);
    if (countersink) {
      this.seededCountersink = countersink;
      this.csinkDiameterField.setValue(countersink.diameter);
      this.csinkAngleField.setValue(countersink.angle);
    }
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
