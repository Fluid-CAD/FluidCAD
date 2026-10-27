import { FeaturePanel } from './feature-panel';
import { ChoiceTabs } from './panel-controls';
import { PickSlot, PickSlotChip } from '../pick-slot';
import { ExpressionRow } from '../modify-pick/expression-row';
import { ColorValues } from './color-values';
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
 * like the fillet dialog's. Pure DOM state — the service owns scene data,
 * the picks, and the apply call.
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
          <span class="text-base-content/70">Colour</span>
          <div class="flex items-center gap-2">
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
    // The well writes hex; the field takes anything and the well follows
    // when the text is a colour it can show.
    this.well.addEventListener('input', () => {
      this.valueInput.value = this.well.value;
      this.syncSwatches();
      this.onChange?.();
    });
    this.valueInput.addEventListener('input', () => {
      this.syncWell();
      this.syncSwatches();
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

  /** The colour field's text, trimmed — validated by the service through {@link ColorValues}. */
  get colorValue(): string {
    return this.valueInput.value.trim();
  }

  /** Set the colour field (and the well, when the value is one it can show). */
  setColorValue(value: string): void {
    this.valueInput.value = value;
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

  /** Open prefilled from an existing statement (edit mode): its tab and colour; the chips are the service's. */
  showEdit(mode: ColorPaintMode, value: string): void {
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

  /** The expression row's static prefix — the colour as the statement will quote it. */
  setExpressionPrefix(value: string): void {
    this.expression.setPrefix(`color('${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', `);
    this.expression.setSuffix(')');
  }

  /** Whether the colour field or the expression row owns the keyboard (Enter-to-apply). */
  ownsFocus(target: Element | null): boolean {
    return target === this.valueInput || target === this.expression.inputElement;
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

  private syncWell(): void {
    const hex = ColorValues.toHex(this.valueInput.value);
    if (hex !== null) {
      this.well.value = hex;
    }
  }

  /** Ring the swatch whose colour the field holds, by name or by hex. */
  private syncSwatches(): void {
    const hex = ColorValues.toHex(this.valueInput.value);
    for (const button of this.swatchHost.querySelectorAll<HTMLButtonElement>('button[data-swatch]')) {
      const swatch = COLOR_SWATCHES.find(s => s.name === button.dataset.swatch)!;
      const active = hex !== null && swatch.hex === hex;
      button.className = active ? `${SWATCH_BASE} ${SWATCH_ACTIVE}` : SWATCH_BASE;
    }
  }
}
