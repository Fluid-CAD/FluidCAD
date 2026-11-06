import { FeaturePanel } from './feature-panel';
import { ChoiceTabs } from './panel-controls';
import { PickSlot, PickSlotChip } from '../pick-slot';
import { ExpressionRow } from '../modify-pick/expression-row';
import { TextControl } from './expression-rows';
import { ColorValues } from './color-values';
import { FeatureExprValue } from '../../api';
import { VariableInfo } from '../../ui/expression-core';
import { iconUrl } from '../../ui/icon-url';

/** What the colour paints — the dialog's two tabs. */
export type ColorPaintMode = 'solids' | 'faces';

/** The colour a fresh dialog opens on. */
export const DEFAULT_COLOR = '#3498db';

/**
 * The swatch row under the colour field: a short palette of the colours
 * parts tend to be shown in, each a one-click value. The names are what the
 * statement writes, so the code stays readable.
 */
export const COLOR_SWATCHES: readonly { name: string; hex: string }[] = [
  { name: 'steelblue', hex: '#4682b4' },
  { name: 'tomato', hex: '#ff6347' },
  { name: 'orange', hex: '#ffa500' },
  { name: 'gold', hex: '#ffd700' },
  { name: 'seagreen', hex: '#2e8b57' },
  { name: 'slateblue', hex: '#6a5acd' },
  { name: 'silver', hex: '#c0c0c0' },
  { name: 'dimgray', hex: '#696969' },
];

const SWATCH_BASE = 'w-5 h-5 rounded-full border border-base-content/20 cursor-pointer transition-transform hover:scale-110';
const SWATCH_ACTIVE = 'ring-2 ring-primary ring-offset-1 ring-offset-base-100';

/**
 * The Color dialog: a Solid / Face tab row (what the paint lands on) over
 * the colour field — a colour well, the value as text (a hex value, a CSS
 * colour name or an `rgb()` string) and a swatch row — and the tab's pick
 * slot: whole solids picked in the viewport (any face or edge click selects
 * the owning solid) or timeline rows, or the faces to paint, one chip per
 * pick. The Face tab docks the expression-transparency row under the dialog
 * like the fillet dialog's. The colour field takes an expression under its ƒ
 * toggle (`tint`, `left ? 'red' : 'blue'`): the well and the swatch ring then
 * follow what it comes to when that is a colour, and stay put otherwise. Pure
 * DOM state — the service owns scene data, the picks, and the apply call.
 */
export class ColorPanel extends FeaturePanel {
  /** The tab changed — the service re-aims the viewport picks. */
  onModeChange?: () => void;
  /** The chip at `index` of the Solids slot was removed. */
  onRemoveTarget?: (index: number) => void;
  /** The chip at `index` of the Faces slot was removed. */
  onRemoveFace?: (index: number) => void;
  /** A chip row of the shown slot is hovered (its index) or left (null) — viewport previews. */
  onChipHover?: (index: number | null) => void;

  /** The Face tab's expression-transparency row (the synthesized selectors, editable). */
  readonly expression: ExpressionRow;

  private readonly tabs: ChoiceTabs<ColorPaintMode>;
  private readonly well: HTMLInputElement;
  private readonly valueInput: HTMLInputElement;
  /** The colour field with its ƒ mode: a literal, or the expression the statement computes the colour with. */
  private readonly valueControl: TextControl;
  private readonly swatchHost: HTMLElement;
  private readonly targetsWrap: HTMLElement;
  private readonly facesWrap: HTMLElement;
  private readonly targetsSlot: PickSlot;
  private readonly facesSlot: PickSlot;
  /** The colour a fresh arming opens on — the last one applied or typed. */
  private lastValue = DEFAULT_COLOR;

  constructor(container: HTMLElement) {
    super(container, {
      id: 'fluidcad-color-panel',
      title: 'Color',
      icon: iconUrl('color'),
      bodyHtml: `
        <div data-role="tabs" class="join w-full"></div>
        <div class="flex flex-col gap-1.5">
          <span data-role="value-label" class="text-base-content/70">Colour</span>
          <div class="flex items-start gap-2">
            <input data-role="well" type="color" value="${DEFAULT_COLOR}" title="Pick a colour"
              class="w-9 h-8 shrink-0 p-0.5 rounded-md border border-base-300 bg-base-100 cursor-pointer" />
            <input data-role="value" type="text" spellcheck="false" autocomplete="off" value="${DEFAULT_COLOR}"
              placeholder="#3498db, steelblue, rgb(…)" title="A hex value, a CSS colour name or an rgb() string"
              class="input input-sm input-bordered flex-1 min-w-0 font-mono text-xs" />
          </div>
          <div data-role="swatches" class="flex flex-wrap items-center gap-1.5 pt-0.5"></div>
        </div>
        <div data-role="targets-slot"></div>
        <div data-role="faces-slot" class="hidden"></div>
      `,
    });

    this.tabs = new ChoiceTabs<ColorPaintMode>(this.role('tabs'), [
      { key: 'solids', label: 'Solid', title: 'Colour every face of whole solids — color(value, e)' },
      { key: 'faces', label: 'Face', title: 'Colour the picked faces — color(value, e.endFaces())' },
    ], 'solids');
    this.tabs.onChange = () => {
      this.syncMode();
      this.onModeChange?.();
      this.onChange?.();
    };

    this.well = this.role<HTMLInputElement>('well');
    this.valueInput = this.role<HTMLInputElement>('value');
    // The field's ƒ mode: the expression line takes the field's place beside
    // the well; the well and the swatch ring follow what the expression comes to.
    this.valueControl = new TextControl(this.valueInput, this.role('value-label'), { name: 'value', label: 'Colour' });
    this.valueControl.onChange = () => {
      this.syncWell();
      this.syncSwatches();
      this.onChange?.();
    };
    this.valueControl.onSubmit = () => this.onApply?.();
    this.swatchHost = this.role('swatches');
    for (const swatch of COLOR_SWATCHES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = SWATCH_BASE;
      button.style.backgroundColor = swatch.hex;
      button.title = swatch.name;
      button.dataset.swatch = swatch.name;
      button.setAttribute('aria-label', swatch.name);
      button.addEventListener('click', () => {
        this.setColorValue(swatch.name);
        this.onChange?.();
      });
      this.swatchHost.appendChild(button);
    }
    // The well writes hex — a literal, which leaves an expression mode the
    // field was in; the field takes anything and the well follows when the
    // text is a colour it can show.
    this.well.addEventListener('input', () => {
      this.setColorValue(this.well.value);
      this.onChange?.();
    });
    this.valueInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.onApply?.();
      }
      e.stopPropagation();
    });

    this.targetsWrap = this.role('targets-slot');
    this.targetsSlot = new PickSlot(this.targetsWrap, { label: 'Solids', multiple: true });
    this.targetsSlot.onRemove = (index) => this.onRemoveTarget?.(index);
    this.targetsSlot.onChipHover = (index) => this.onChipHover?.(index);
    this.facesWrap = this.role('faces-slot');
    this.facesSlot = new PickSlot(this.facesWrap, { label: 'Faces', multiple: true });
    this.facesSlot.onRemove = (index) => this.onRemoveFace?.(index);
    this.facesSlot.onChipHover = (index) => this.onChipHover?.(index);
    // Picking is live the whole time the dialog is up — the shown slot
    // always wears the pick-target styling.
    this.targetsSlot.setArmed(true);
    this.facesSlot.setArmed(true);

    this.expression = new ExpressionRow(this.shell.column);
    this.expression.onSubmit = () => this.onApply?.();
    this.syncMode();
  }

  get mode(): ColorPaintMode {
    return this.tabs.value;
  }

  /**
   * The colour the field stands on, trimmed — its text, or what its expression
   * comes to (empty while that is unknown or no text); the tint the viewport
   * shows, validated by the service through {@link ColorValues}.
   */
  get colorValue(): string {
    return (this.valueControl.text ?? '').trim();
  }

  /** What the field writes: its text (the service judges whether it is a colour), or the expression; the message when the mode is on with nothing in it. */
  readColor(): { value: string | FeatureExprValue } | { error: string } {
    return this.valueControl.read();
  }

  /** Set the colour field (and the well, when the value is one it can show). An expression opens the field's ƒ mode. */
  setColorValue(value: string | FeatureExprValue): void {
    this.valueControl.setValue(value);
    this.syncWell();
    this.syncSwatches();
  }

  /** The variables the field's expression completes and resolves over; the well follows what it then comes to. */
  setScopeVariables(variables: VariableInfo[]): void {
    this.valueControl.setVariables(variables);
    this.syncWell();
    this.syncSwatches();
  }

  /** A fresh arming: the Solid tab, the last colour, empty slots. */
  show(): void {
    this.shell.setTitle(null);
    this.tabs.setValue('solids');
    this.setColorValue(this.lastValue);
    this.setTargets([]);
    this.setFaces([]);
    this.expression.hide();
    this.syncMode();
    this.shell.show();
  }

  /** Open prefilled from an existing statement (edit mode): its tab and colour — an expression in its ƒ mode; the chips are the service's. */
  showEdit(mode: ColorPaintMode, value: string | FeatureExprValue): void {
    this.shell.setTitle('Edit color');
    this.tabs.setValue(mode);
    this.setColorValue(value);
    this.setTargets([]);
    this.setFaces([]);
    this.expression.hide();
    this.syncMode();
    this.shell.show();
  }

  /** Programmatic tab choice (edit seeding once the sources resolve); no change event fires. */
  setMode(mode: ColorPaintMode): void {
    this.tabs.setValue(mode);
    this.syncMode();
  }

  /** Remember the colour for the next fresh arming (an apply went through). */
  rememberColor(): void {
    const normalized = ColorValues.normalize(this.colorValue);
    if (normalized !== null) {
      this.lastValue = normalized;
    }
  }

  setTargets(chips: PickSlotChip[]): void {
    this.targetsSlot.setChips(chips.map((chip, index) => ({ ...chip, badge: String(index + 1) })));
    this.targetsSlot.setPrompt(chips.length > 0 ? null : 'Pick solids in the viewport');
  }

  setFaces(chips: PickSlotChip[]): void {
    this.facesSlot.setChips(chips.map((chip, index) => ({ ...chip, badge: String(index + 1) })));
    this.facesSlot.setPrompt(chips.length > 0 ? null : 'Pick faces in the viewport');
  }

  /** The expression row's static prefix — the colour as the statement will quote it, an expression written bare. */
  setExpressionPrefix(value: string | FeatureExprValue): void {
    const source = typeof value === 'string' ? `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : value.expr.trim();
    this.expression.setPrefix(`color(${source}, `);
    this.expression.setSuffix(')');
  }

  /** Whether the colour field (its expression input included) or the expression row owns the keyboard (Enter-to-apply). */
  ownsFocus(target: Element | null): boolean {
    return target === this.valueInput || target === this.expression.inputElement
      || (target !== null && this.valueControl.mode.line.contains(target));
  }

  /** Show the shown tab's slot; the Face tab's expression row only ever shows under it. */
  private syncMode(): void {
    const faces = this.mode === 'faces';
    this.targetsWrap.classList.toggle('hidden', faces);
    this.facesWrap.classList.toggle('hidden', !faces);
    if (!faces) {
      this.expression.hide();
    }
  }

  /** The well shows the colour the field stands on when it can; otherwise it stays put. */
  private syncWell(): void {
    const hex = ColorValues.toHex(this.colorValue);
    if (hex !== null) {
      this.well.value = hex;
    }
  }

  /** Ring the swatch whose colour the field stands on, by name or by hex. */
  private syncSwatches(): void {
    const hex = ColorValues.toHex(this.colorValue);
    for (const button of this.swatchHost.querySelectorAll<HTMLButtonElement>('button[data-swatch]')) {
      const swatch = COLOR_SWATCHES.find(s => s.name === button.dataset.swatch)!;
      const active = hex !== null && swatch.hex === hex;
      button.className = active ? `${SWATCH_BASE} ${SWATCH_ACTIVE}` : SWATCH_BASE;
    }
  }
}
