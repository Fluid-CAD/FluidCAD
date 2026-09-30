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
  FASTENER_FITS, coarsePitch, defaultDrilledDiameter, defaultSizeLabel, pitchOptions, sizeLabels, standardOf,
  tableCounterbore, tableCountersink, tableDiameter, type FastenerFit, type FastenerStandard, type HoleType,
} from './hole-catalog';

/** Validated form values, or the message to show when a field is invalid. */
export type HoleValues = HoleOptionValues | { error: string };

export type HoleTermination = 'through' | 'blind';

/** The two pick slots; exactly one wears the armed border at a time. */
export type HoleArmedSlot = 'placements' | 'scope';

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
 * placements slot, a section drawing of the hole with the field being edited
 * drawn in colour, the termination with its depth and drill-point angle, the
 * fastener standard, the hole type with its size / fit / pitch and the
 * diameter they give, the counterbore or countersink values, and the scope
 * slot last — the solids the hole is cut from. Pure DOM + form state: the
 * service owns scene data, picks, previews and the apply call.
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
  private illustrationEl: HTMLElement;
  private standardSelect: HTMLSelectElement;
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
      wide: true,
      bodyHtml: `
        <p class="text-base-content/70 leading-snug">Cuts fastener holes into the model at the places you pick.</p>
        <div data-role="style-tabs" class="join w-full"></div>
        <div data-role="placements-slot"></div>
        <div data-role="illustration" class="text-base-content px-2"></div>
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
        <label data-role="standard-row" class="flex flex-col gap-1.5" title="Which fastener catalog the sizes come from">
          <span class="text-base-content/70">Standard</span>
          <select data-role="standard" class="select select-sm select-bordered w-full text-xs">
            <option value="metric" title="ISO sizes: M3, M6, …">Metric</option>
            <option value="inch" title="Unified sizes: #10, 1/4, …">Inch</option>
          </select>
        </label>
        <label class="flex flex-col gap-1.5" title="Drilled takes the diameter you type; Clearance and Tapped read it from the fastener tables">
          <span class="text-base-content/70">Hole type</span>
          <select data-role="type" class="select select-sm select-bordered w-full text-xs">
            <option value="clearance">Clearance</option>
            <option value="drilled">Drilled</option>
            <option value="tapped">Tapped</option>
          </select>
        </label>
        <label data-role="size-row" class="flex flex-col gap-1.5" title="The fastener the hole is for">
          <span class="text-base-content/70">Size</span>
          <select data-role="size" class="select select-sm select-bordered w-full text-xs"></select>
        </label>
        <label data-role="fit-row" class="flex flex-col gap-1.5" title="How much room the fastener gets — ISO 273 / ASME B18.2.8 fine, medium and coarse series">
          <span class="text-base-content/70">Fastener fit</span>
          <select data-role="fit" class="select select-sm select-bordered w-full text-xs"></select>
        </label>
        <label data-role="pitch-row" class="hidden flex-col gap-1.5" title="The thread pitch; the hole is cut at its tap drill diameter (threads are not modelled yet)">
          <span class="text-base-content/70">Pitch</span>
          <select data-role="pitch" class="select select-sm select-bordered w-full text-xs"></select>
        </label>
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

    this.scopeSlot = new ScopeSlotControl(this.role('scope-slot'));
    this.scopeSlot.onRemove = (index) => this.onRemoveScope?.(index);
    this.scopeSlot.onArm = () => this.armSlot('scope');

    this.illustrationEl = this.role('illustration');

    this.standardSelect = this.role('standard');
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
    this.fillSizes(defaultSizeLabel('metric'));
    this.fillPitches();

    this.standardSelect.addEventListener('change', () => {
      this.fillSizes(defaultSizeLabel(this.standard));
      this.fillPitches();
      this.reseedDerived();
      this.syncControls();
      this.onChange?.();
    });
    this.typeSelect.addEventListener('change', () => {
      this.reseedDerived();
      this.syncControls();
      this.onChange?.();
    });
    this.sizeSelect.addEventListener('change', () => {
      this.fillPitches();
      this.reseedDerived();
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

  get standard(): FastenerStandard {
    return this.standardSelect.value as FastenerStandard;
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

  show(): void {
    // A fresh arming starts from defaults — the previous session's form
    // values would otherwise carry over.
    this.shell.setTitle(null);
    this.styleTabs.reset();
    this.standardSelect.value = 'metric';
    this.fillSizes(defaultSizeLabel('metric'));
    this.typeSelect.value = 'clearance';
    this.fitSelect.value = 'normal';
    this.fillPitches();
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
    this.standardSelect.value = standardOf(fastenerLabel);
    this.fillSizes(fastenerLabel ?? defaultSizeLabel(this.standard));
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
  setPlacements(chips: PickSlotChip[], prompt: string): void {
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
    ];
  }

  private selectedPitch(): number | null {
    const value = Number(this.pitchSelect.value);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  private fillSizes(selected: string): void {
    this.sizeSelect.innerHTML = '';
    for (const label of sizeLabels(this.standard)) {
      const option = document.createElement('option');
      option.value = label;
      option.textContent = label;
      this.sizeSelect.appendChild(option);
    }
    this.sizeSelect.value = selected;
    if (this.sizeSelect.value !== selected) {
      this.sizeSelect.value = defaultSizeLabel(this.standard);
    }
  }

  private fillPitches(): void {
    this.pitchSelect.innerHTML = '';
    for (const pitch of pitchOptions(this.sizeLabel)) {
      const option = document.createElement('option');
      option.value = String(pitch.value);
      option.textContent = pitch.label;
      this.pitchSelect.appendChild(option);
    }
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
    this.toggleRow('standard-row', fastener, 'flex');
    this.toggleRow('size-row', fastener, 'flex');
    this.toggleRow('fit-row', type === 'clearance', 'flex');
    this.toggleRow('pitch-row', type === 'tapped', 'flex');
    const diameter = this.role<HTMLInputElement>('diameter');
    diameter.readOnly = fastener;
    diameter.classList.toggle('opacity-70', fastener);
    diameter.title = fastener ? 'From the fastener tables — switch to Drilled to type a diameter' : '';
    this.toggleRow('cbore-rows', this.style === 'counterbore', 'flex');
    this.toggleRow('csink-rows', this.style === 'countersink', 'flex');
    this.toggleRow('blind-rows', this.termination === 'blind', 'flex');
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
    this.illustrationEl.innerHTML = holeIllustration({
      style: this.style,
      through: this.termination === 'through',
      tip,
      highlight: this.focusedDimension ?? 'diameter',
    });
  }
}
