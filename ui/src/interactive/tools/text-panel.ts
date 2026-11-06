import { PanelShell, ChoiceTabs } from '../create-feature/panel-controls';
import { sceneUnit } from '../../units/scene-unit';
import { applyUnitTitles } from '../../units/apply-unit-defaults';
import { EntitySlotControl } from '../create-feature/entity-slot';
import { FlagControl, SelectControl, TabsControl, TextControl, type OptionLabel } from '../create-feature/expression-rows';
import {
  getFontFamilies, FeatureExprValue, FeatureRefValue, NewVariable, TextAlignOption, TextAlignValue, TextOptionValues,
  TextPreviewOptions, ValueExpr,
} from '../../api';
import { ExpressionField, collectNewVariables, type ExpressionFieldResult } from '../../ui/expression-field';
import { resolveExpressionValue, type VariableInfo } from '../../ui/expression-core';
import { iconUrl } from '../../ui/icon-url';

/** The Distribute row's choices: off = the Align tabs stand. */
type TextDistributeOption = 'off' | 'space-between' | 'space-around';

/** What the dialog reads: the statement's options, with the declarations its number fields committed. */
export type TextPanelValues = TextOptionValues & { newVariables?: NewVariable[] };

const WEIGHT_CHOICES: { value: number; label: string }[] = [
  { value: 100, label: 'Thin' },
  { value: 200, label: 'Extra Light' },
  { value: 300, label: 'Light' },
  { value: 400, label: 'Regular' },
  { value: 500, label: 'Medium' },
  { value: 600, label: 'Semi Bold' },
  { value: 700, label: 'Bold' },
  { value: 800, label: 'Extra Bold' },
  { value: 900, label: 'Black' },
];

/** The alignments the align row's expression may come to, as its note names them. */
const ALIGN_CHOICES: readonly OptionLabel<TextAlignValue>[] = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'right', label: 'Right' },
  { value: 'space-between', label: 'Between' },
  { value: 'space-around', label: 'Around' },
];

/** A choice slot's seed for a control with one expression mode: a variable's `{ ref }` opens as the expression of its name. */
function seedOf<T>(value: T | FeatureRefValue | FeatureExprValue): T | FeatureExprValue {
  if (typeof value === 'object' && value !== null && 'ref' in value) {
    return { expr: (value as FeatureRefValue).ref };
  }
  return value as T | FeatureExprValue;
}

/** A number field's refusal, spelled out after the row's own message — unless the field is merely empty. */
function detail(read: ExpressionFieldResult): string {
  return 'error' in read && read.error !== 'empty' ? ` ${read.error}.` : '';
}

/**
 * The Align and Distribute tab rows as the one choice the align slot is: a
 * distribution chosen in path mode overrides Align (as the statement's
 * `.align('space-between')` does), else the Align tab stands. The align
 * row's expression mode stands on this pair, so one expression covers both.
 */
class AlignmentTabs {
  onChange?: () => void;

  constructor(
    private readonly align: ChoiceTabs<TextAlignOption>,
    private readonly distribute: ChoiceTabs<TextDistributeOption>,
    private readonly pathMode: () => boolean,
  ) {
    align.onChange = () => this.onChange?.();
    distribute.onChange = () => this.onChange?.();
  }

  /** The alignment the rows stand on; the distribution only counts while a path is selected. */
  get value(): TextAlignValue {
    const distribute = this.pathMode() ? this.distribute.value : 'off';
    return distribute === 'off' ? this.align.value : distribute;
  }

  setValue(value: TextAlignValue): void {
    if (value === 'space-between' || value === 'space-around') {
      this.distribute.setValue(value);
      this.align.setValue('left');
    } else {
      this.distribute.setValue('off');
      this.align.setValue(value);
    }
  }
}

/**
 * The Text tool's options dialog: the string, typeface (family / weight /
 * italic), size, alignment and spacing controls behind `text()`'s chain
 * methods, plus the path slot for the `text("…", path)` overload. Pure DOM +
 * form state — the tool owns the anchor point, the viewport preview, the
 * path pick and the insert. Every edit fires `onChange`, which the tool
 * answers with a fresh outline preview, so changes render live.
 *
 * Every typed-in row takes an expression in place of its literal: the
 * numbers through their expression fields (a bare name, `cap * 2`), the
 * string, the font, the weight, the flags and the alignment under their ƒ
 * toggles (`` `rib-${n}` ``, `bold ? 700 : 400`). A statement holding one
 * opens the row in that mode with what the expression comes to beside it;
 * the dialog writes the expression back as it stands, and the outline
 * preview draws from what the rows resolve to — nothing, while one cannot.
 */
export class TextPanel {
  onChange?: () => void;
  onApply?: () => void;
  onExit?: () => void;

  /**
   * The path slot (`text("…", path)`): the owner arms picking via its
   * `onArm`, pushes/clears the chip, and seeds the edit-mode keep chip. The
   * keep chip is removable — dropping the statement's path is a real edit
   * (back to plain anchored text).
   */
  readonly pathSlot: EntitySlotControl;

  private shell: PanelShell;
  private textInput: HTMLTextAreaElement;
  private textControl: TextControl;
  private fontSelect: HTMLSelectElement;
  private fontControl: SelectControl<string>;
  private sizeField: ExpressionField;
  private weightSelect: HTMLSelectElement;
  private weightControl: SelectControl<string>;
  private italicControl: FlagControl;
  private alignTabs: ChoiceTabs<TextAlignOption>;
  private alignControl: TabsControl<TextAlignValue>;
  private lineSpacingField: ExpressionField;
  private letterSpacingField: ExpressionField;
  private applyBtn: HTMLButtonElement;
  /** The path-only controls (`.offset()`, `.startAt()`, `.flip()`), shown
   * under the path slot while a path is selected. */
  private pathOptions: HTMLDivElement;
  private pathOffsetField: ExpressionField;
  private startAtField: ExpressionField;
  private flipControl: FlagControl;
  /** The Distribute row beside Align, path mode only; ≠ off grays Align. */
  private distributeRow: HTMLDivElement;
  private distributeTabs: ChoiceTabs<TextDistributeOption>;
  private alignJoin: HTMLDivElement;
  /** True while a path is selected — the path-only options apply. */
  private pathMode = false;
  /** Family chosen before the font list arrived; applied by setFonts. */
  private pendingFont: string | null = null;
  /** The variables in scope, as last pushed — the number rows resolve their expressions by them. */
  private variables: VariableInfo[] = [];

  constructor(container: HTMLElement) {
    // A sketch tool's dialog: the sketch toolbar's Escape exits the tool.
    this.shell = new PanelShell(container, 'fluidcad-text-panel', 'Text', iconUrl('text'), 'inside');
    this.shell.onEscape = () => this.onExit?.();
    this.shell.body.insertAdjacentHTML('beforeend', `
      <label class="flex flex-col gap-1.5">
        <span class="text-base-content/70">Text</span>
        <textarea data-role="text" rows="2" placeholder="Text"
          class="textarea textarea-sm textarea-bordered w-full text-xs leading-snug resize-y">Text</textarea>
      </label>
      <div data-role="path-slot"></div>
      <div data-role="path-options" class="hidden flex-col gap-3.5">
        <div class="flex items-start gap-1.5">
          <label class="flex flex-col gap-1.5 flex-1 min-w-0" data-unit-title="Shift off the path in {unit}; negative moves to the other side">
            <span class="text-base-content/70">Offset</span>
            <input data-role="path-offset" type="number" step="0.5" value="0"
              class="input input-sm input-bordered w-full min-w-0 text-xs" />
          </label>
          <label class="flex flex-col gap-1.5 flex-1 min-w-0" data-unit-title="Distance along the path before the text starts, in {unit}">
            <span class="text-base-content/70">Start at</span>
            <input data-role="path-start-at" type="number" step="1" min="0" value="0"
              class="input input-sm input-bordered w-full min-w-0 text-xs" />
          </label>
        </div>
        <label class="flex items-center justify-between cursor-pointer"
          title="Place the text on the other side of the path (inside, on a closed loop)">
          <span class="text-base-content/70">Flip</span>
          <input data-role="path-flip" type="checkbox" class="toggle toggle-sm toggle-primary" />
        </label>
      </div>
      <label class="flex flex-col gap-1.5">
        <span class="text-base-content/70">Font</span>
        <select data-role="font" class="select select-sm select-bordered w-full text-xs">
          <option value="">Default</option>
        </select>
      </label>
      <div class="flex items-start gap-1.5">
        <label class="flex flex-col gap-1.5 flex-1 min-w-0">
          <span class="text-base-content/70">Size</span>
          <input data-role="size" type="number" step="1" min="0.1" value="10"
            class="input input-sm input-bordered w-full min-w-0 text-xs" />
        </label>
        <label class="flex flex-col gap-1.5 flex-1 min-w-0">
          <span class="text-base-content/70">Weight</span>
          <select data-role="weight" class="select select-sm select-bordered w-full min-w-0 text-xs"></select>
        </label>
      </div>
      <label class="flex items-center justify-between cursor-pointer">
        <span class="text-base-content/70">Italic</span>
        <input data-role="italic" type="checkbox" class="toggle toggle-sm toggle-primary" />
      </label>
      <div class="flex flex-col gap-1.5">
        <span class="text-base-content/70">Align</span>
        <div data-role="align-host" class="flex flex-col gap-3.5">
          <div data-role="align" class="join w-full"></div>
          <div data-role="distribute-row" class="hidden flex-col gap-1.5"
            title="Spread the glyphs across the whole path; overrides Align">
            <span class="text-base-content/70">Distribute</span>
            <div data-role="distribute" class="join w-full"></div>
          </div>
        </div>
      </div>
      <div class="flex items-start gap-1.5">
        <label class="flex flex-col gap-1.5 flex-1 min-w-0" title="Multiplier on the font's natural line height">
          <span class="text-base-content/70">Line spacing</span>
          <input data-role="line-spacing" type="number" step="0.1" min="0.1" value="1"
            class="input input-sm input-bordered w-full min-w-0 text-xs" />
        </label>
        <label class="flex flex-col gap-1.5 flex-1 min-w-0" data-unit-title="Extra advance between glyphs, in {unit}">
          <span class="text-base-content/70">Letter spacing</span>
          <input data-role="letter-spacing" type="number" step="0.1" value="0"
            class="input input-sm input-bordered w-full min-w-0 text-xs" />
        </label>
      </div>
    `);
    this.shell.footer.insertAdjacentHTML('beforeend', `
      <button data-role="apply" class="btn btn-primary btn-sm flex-1">Apply</button>
      <button data-role="exit" class="btn btn-ghost btn-sm">Exit</button>
    `);

    this.pathSlot = new EntitySlotControl(
      this.shell.body.querySelector('[data-role="path-slot"]')!,
      { label: 'Follow path', prompt: 'Pick an edge', keepRemovable: true },
    );
    this.textInput = this.shell.body.querySelector('[data-role="text"]')!;
    this.fontSelect = this.shell.body.querySelector('[data-role="font"]')!;
    this.weightSelect = this.shell.body.querySelector('[data-role="weight"]')!;
    this.applyBtn = this.shell.footer.querySelector('[data-role="apply"]')!;
    this.pathOptions = this.shell.body.querySelector('[data-role="path-options"]')!;
    this.distributeRow = this.shell.body.querySelector('[data-role="distribute-row"]')!;
    this.alignJoin = this.shell.body.querySelector('[data-role="align"]')!;
    applyUnitTitles(this.shell.body);
    sceneUnit.subscribe(() => applyUnitTitles(this.shell.body));

    for (const { value, label } of WEIGHT_CHOICES) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = label;
      option.selected = value === 400;
      this.weightSelect.appendChild(option);
    }

    this.alignTabs = new ChoiceTabs<TextAlignOption>(
      this.alignJoin,
      [
        { key: 'left', label: 'Left', title: 'Baseline starts at the anchor' },
        { key: 'center', label: 'Center', title: 'Line centered on the anchor' },
        { key: 'right', label: 'Right', title: 'Line ends at the anchor' },
      ],
      'left',
    );

    this.distributeTabs = new ChoiceTabs<TextDistributeOption>(
      this.shell.body.querySelector('[data-role="distribute"]')!,
      [
        { key: 'off', label: 'Off', title: 'Align places the text at the path start/center/end' },
        { key: 'space-between', label: 'Between', title: 'First and last glyph pinned to the path ends, the rest spread evenly' },
        { key: 'space-around', label: 'Around', title: 'Glyphs spread evenly with half-gaps at the path ends' },
      ],
      'off',
    );

    // The typed-in rows and their ƒ modes: each statement slot one control,
    // reading a literal or `{ expr }`; the number rows are expression fields.
    this.textControl = new TextControl(this.textInput, this.labelOf(this.textInput), { name: 'text', label: 'Text' });
    this.fontControl = new SelectControl<string>(this.fontSelect, this.labelOf(this.fontSelect), { name: 'font', label: 'Font' });
    this.weightControl = new SelectControl<string>(
      this.weightSelect, this.labelOf(this.weightSelect), { name: 'weight', label: 'Weight', numeric: true },
    );
    this.italicControl = new FlagControl(this.shell.body.querySelector('[data-role="italic"]')!, { name: 'italic', label: 'Italic' });
    this.flipControl = new FlagControl(this.shell.body.querySelector('[data-role="path-flip"]')!, { name: 'flip', label: 'Flip' });
    const alignHost = this.shell.body.querySelector<HTMLElement>('[data-role="align-host"]')!;
    this.alignControl = new TabsControl<TextAlignValue>(
      new AlignmentTabs(this.alignTabs, this.distributeTabs, () => this.pathMode),
      alignHost,
      alignHost.parentElement!.querySelector('span')!,
      ALIGN_CHOICES,
      { name: 'align', label: 'Align' },
    );
    for (const control of [this.textControl, this.fontControl, this.weightControl, this.italicControl, this.flipControl]) {
      control.onChange = () => this.onChange?.();
      control.onSubmit = () => this.onApply?.();
    }
    this.alignControl.onChange = () => {
      this.syncAlignEnabled();
      this.onChange?.();
    };
    this.alignControl.onSubmit = () => this.onApply?.();
    this.sizeField = this.enhance('size');
    this.lineSpacingField = this.enhance('line-spacing');
    this.letterSpacingField = this.enhance('letter-spacing');
    this.pathOffsetField = this.enhance('path-offset');
    this.startAtField = this.enhance('path-start-at');

    // Typing in the dialog must not trigger the single-letter tool shortcuts
    // (window-level). Enter in a select applies; the textarea keeps Enter for
    // new lines. Escape passes through to the shell's handler. The expression
    // fields own their inputs' keys the same way.
    const fields: HTMLElement[] = [this.textInput, this.fontSelect, this.weightSelect];
    for (const field of fields) {
      field.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          return;
        }
        if (e.key === 'Enter' && field !== this.textInput) {
          e.preventDefault();
          this.onApply?.();
        }
        e.stopPropagation();
      });
    }

    this.applyBtn.addEventListener('click', () => this.onApply?.());
    this.shell.footer.querySelector('[data-role="exit"]')!
      .addEventListener('click', () => this.onExit?.());
  }

  /** System font families are per-server-process; fetch once per page. */
  private static fontFamiliesPromise: Promise<string[]> | null = null;

  static loadFontFamilies(): Promise<string[]> {
    if (!TextPanel.fontFamiliesPromise) {
      TextPanel.fontFamiliesPromise = getFontFamilies();
    }
    return TextPanel.fontFamiliesPromise;
  }

  /** Whether a text slot is the one string the statement refuses: a blank literal. An expression is the build's to judge. */
  static blankText(text: string | FeatureExprValue): boolean {
    return typeof text === 'string' && text.trim() === '';
  }

  get isVisible(): boolean {
    return this.shell.isVisible;
  }

  /** Retitle the dialog ("Edit text"); null restores the create title. */
  setTitle(title: string | null): void {
    this.shell.setTitle(title);
  }

  /**
   * Show/hide the path-only controls (Offset, Start at, Flip, Distribute).
   * The owner flips this with the path slot's state; while off, {@link values}
   * reports their defaults so an anchored statement renders no path chains.
   */
  setPathMode(active: boolean): void {
    if (this.pathMode === active) {
      return;
    }
    this.pathMode = active;
    this.pathOptions.classList.toggle('hidden', !active);
    this.pathOptions.classList.toggle('flex', active);
    this.distributeRow.classList.toggle('hidden', !active);
    this.distributeRow.classList.toggle('flex', active);
    this.syncAlignEnabled();
  }

  /** The variables the rows' expressions complete and resolve over (the number fields' dropdowns included). */
  setScopeVariables(variables: VariableInfo[]): void {
    this.variables = variables;
    for (const field of [this.sizeField, this.lineSpacingField, this.letterSpacingField, this.pathOffsetField, this.startAtField]) {
      field.setVariables(variables);
    }
    for (const control of [this.textControl, this.fontControl, this.weightControl, this.italicControl, this.flipControl, this.alignControl]) {
      control.setVariables(variables);
    }
  }

  /** A distribution overrides Align — gray the tabs while one is chosen. */
  private syncAlignEnabled(): void {
    const overridden = this.pathMode && this.distributeTabs.value !== 'off';
    this.alignJoin.classList.toggle('opacity-40', overridden);
    this.alignJoin.classList.toggle('pointer-events-none', overridden);
  }

  /** Programmatic option values (edit-mode prefill); no change event fires. An expression opens its row in expression mode. */
  setValues(values: TextOptionValues): void {
    this.textControl.setValue(values.text);
    this.sizeField.setValue(values.size);
    const font = values.font ?? '';
    if (typeof font === 'string') {
      if (font && ![...this.fontSelect.options].some(o => o.value === font)) {
        // Not offered (yet): add it so the choice sticks — setFonts dedupes
        // when the real list arrives.
        const option = document.createElement('option');
        option.value = font;
        option.textContent = font;
        this.fontSelect.insertBefore(option, this.fontSelect.options[1] ?? null);
      }
      this.fontControl.setValue(font);
      this.pendingFont = font || null;
    } else {
      this.fontControl.setValue(font);
      this.pendingFont = null;
    }
    const weight = seedOf<number>(values.weight);
    this.weightControl.setValue(typeof weight === 'number' ? String(weight) : weight);
    this.italicControl.setValue(values.italic);
    this.alignControl.setValue(seedOf(values.align));
    this.lineSpacingField.setValue(values.lineSpacing);
    this.letterSpacingField.setValue(values.letterSpacing);
    this.pathOffsetField.setValue(values.offset);
    this.startAtField.setValue(values.startAt);
    this.flipControl.setValue(values.flip);
    this.syncAlignEnabled();
  }

  show(): void {
    this.shell.show();
    // Pre-selected starter text: the preview renders immediately and the
    // first keystroke replaces it.
    this.textInput.focus();
    this.textInput.select();
  }

  hide(): void {
    this.shell.hide();
  }

  destroy(): void {
    for (const field of [this.sizeField, this.lineSpacingField, this.letterSpacingField, this.pathOffsetField, this.startAtField]) {
      field.destroy();
    }
    for (const control of [this.textControl, this.fontControl, this.weightControl, this.italicControl, this.flipControl, this.alignControl]) {
      control.destroy();
    }
    this.shell.destroy();
  }

  /** Fill the family dropdown, keeping the current choice when still offered. */
  setFonts(families: string[]): void {
    const current = this.fontSelect.value || this.pendingFont || '';
    while (this.fontSelect.options.length > 1) {
      this.fontSelect.remove(1);
    }
    for (const family of families) {
      const option = document.createElement('option');
      option.value = family;
      option.textContent = family;
      this.fontSelect.appendChild(option);
    }
    if (current) {
      if (!families.includes(current)) {
        // A statement's font the list doesn't offer (a font file path, a
        // family this machine lacks): keep it selectable so editing other
        // options doesn't silently drop the .font() chain.
        const option = document.createElement('option');
        option.value = current;
        option.textContent = current;
        this.fontSelect.insertBefore(option, this.fontSelect.options[1] ?? null);
      }
      this.fontSelect.value = current;
    }
    this.pendingFont = null;
    // An expression in the font row describes what it comes to against the
    // list: a family the machine lacks is its warning, not a refusal.
    this.fontControl.setVariables(this.variables);
  }

  setPreview(statement: string | null): void {
    this.shell.setPreview(statement);
  }

  setMessage(text: string | null): void {
    this.shell.setMessage(text);
  }

  setApplyEnabled(enabled: boolean): void {
    this.applyBtn.disabled = !enabled;
  }

  /** Validated form values, or the message to show for an invalid field. A row in expression mode reads its `{ expr }`, or a bare expression for a number. */
  values(): TextPanelValues | { error: string } {
    const text = this.textControl.read();
    if ('error' in text) {
      return text;
    }
    const size = this.sizeField.read();
    if ('error' in size || (typeof size.value === 'number' && size.value <= 0)) {
      return { error: `Enter a positive text size.${detail(size)}` };
    }
    const lineSpacing = this.lineSpacingField.read();
    if ('error' in lineSpacing || (typeof lineSpacing.value === 'number' && lineSpacing.value <= 0)) {
      return { error: `Enter a positive line spacing factor.${detail(lineSpacing)}` };
    }
    const letterSpacing = this.letterSpacingField.read();
    if ('error' in letterSpacing) {
      return { error: `Enter a letter spacing in ${sceneUnit.current}.${detail(letterSpacing)}` };
    }
    const font = this.fontControl.read();
    if ('error' in font) {
      return font;
    }
    const weight = this.weightControl.read();
    if ('error' in weight) {
      return weight;
    }
    const italic = this.italicControl.read();
    if ('error' in italic) {
      return italic;
    }
    const align = this.alignControl.read();
    if ('error' in align) {
      return align;
    }
    // The path-only options read as their defaults while no path is
    // selected — an anchored statement renders no path chains, whatever the
    // hidden fields still hold from an earlier pick.
    let offset: ValueExpr = 0;
    let startAt: ValueExpr = 0;
    let flip: boolean | FeatureExprValue = false;
    const reads: ExpressionFieldResult[] = [size, lineSpacing, letterSpacing];
    if (this.pathMode) {
      const offsetRead = this.pathOffsetField.read();
      if ('error' in offsetRead) {
        return { error: `Enter a path offset in ${sceneUnit.current}.${detail(offsetRead)}` };
      }
      const startAtRead = this.startAtField.read();
      if ('error' in startAtRead || (typeof startAtRead.value === 'number' && startAtRead.value < 0)) {
        return { error: `Enter a non-negative start distance in ${sceneUnit.current}.${detail(startAtRead)}` };
      }
      const flipRead = this.flipControl.read();
      if ('error' in flipRead) {
        return flipRead;
      }
      offset = offsetRead.value;
      startAt = startAtRead.value;
      flip = flipRead.value;
      reads.push(offsetRead, startAtRead);
    }
    return {
      text: text.value,
      size: size.value,
      font: font.value === '' ? null : font.value,
      weight: typeof weight.value === 'string' ? parseInt(weight.value, 10) || 400 : weight.value,
      italic: italic.value,
      align: align.value,
      lineSpacing: lineSpacing.value,
      letterSpacing: letterSpacing.value,
      offset,
      startAt,
      flip,
      newVariables: collectNewVariables(reads.map(read => 'error' in read ? null : read)),
    };
  }

  /**
   * The text and options as the layout preview takes them: every row's
   * literal, or what its expression comes to over the variables in scope.
   * Null while a row cannot be resolved — there is no outline to draw for
   * a text the dialog cannot spell, and the statement preview stands alone.
   */
  previewOptions(): { text: string; options: TextPreviewOptions } | null {
    const text = this.textControl.text;
    const size = this.resolveNumber(this.sizeField);
    // A font expression lays out in the family it names whether or not the
    // list offers it — the list is a warning there, the registry the judge.
    const fontLiteral = this.fontControl.on ? this.fontControl.mode.value() : this.fontSelect.value;
    const font = typeof fontLiteral === 'string' ? fontLiteral : undefined;
    const weight = this.weightControl.value;
    const italic = this.italicControl.checked;
    const align = this.alignControl.value;
    const lineSpacing = this.resolveNumber(this.lineSpacingField);
    const letterSpacing = this.resolveNumber(this.letterSpacingField);
    let offset: number | null = 0;
    let startAt: number | null = 0;
    let flip: boolean | undefined = false;
    if (this.pathMode) {
      offset = this.resolveNumber(this.pathOffsetField);
      startAt = this.resolveNumber(this.startAtField);
      flip = this.flipControl.checked;
    }
    if (text === undefined || size === null || font === undefined || weight === undefined || italic === undefined
      || align === undefined || lineSpacing === null || letterSpacing === null || offset === null || startAt === null
      || flip === undefined) {
      return null;
    }
    return {
      text,
      options: {
        size,
        font: font === '' ? null : font,
        weight: parseInt(weight, 10) || 400,
        italic,
        align,
        lineSpacing,
        letterSpacing,
        offset,
        startAt,
        flip,
      },
    };
  }

  /** A number field's literal, or what its expression comes to by the variables in scope; null while it cannot be told. */
  private resolveNumber(field: ExpressionField): number | null {
    const read = field.read();
    if ('error' in read) {
      return null;
    }
    return typeof read.value === 'number' ? read.value : resolveExpressionValue(read.value, this.variables);
  }

  /** The label text (its `<span>`) of the row a control sits in — where the ƒ toggle goes. */
  private labelOf(control: HTMLElement): HTMLElement {
    return control.closest('label')!.querySelector('span')!;
  }

  /**
   * Wrap a number input in an ExpressionField wired to the panel: Enter
   * applies, typing fires change, and the field owns the input's keyboard
   * handling (variable dropdown, type="text" for identifiers).
   */
  private enhance(role: string): ExpressionField {
    const input = this.shell.body.querySelector<HTMLInputElement>(`[data-role="${role}"]`)!;
    const field = new ExpressionField(input);
    field.onSubmit = () => this.onApply?.();
    input.addEventListener('input', () => this.onChange?.());
    return field;
  }
}
