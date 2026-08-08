import { PanelShell, ChoiceTabs } from '../create-feature/panel-controls';
import { EntitySlotControl } from '../create-feature/entity-slot';
import { getFontFamilies, TextAlignOption, TextOptionValues } from '../../api';

/** The Distribute row's choices: off = the Align tabs stand. */
type TextDistributeOption = 'off' | 'space-between' | 'space-around';

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

/**
 * The Text tool's options dialog: the string, typeface (family / weight /
 * italic), size, alignment and spacing controls behind `text()`'s chain
 * methods, plus the path slot for the `text("…", path)` overload. Pure DOM +
 * form state — the tool owns the anchor point, the viewport preview, the
 * path pick and the insert. Every edit fires `onChange`, which the tool
 * answers with a fresh outline preview, so changes render live.
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
  private fontSelect: HTMLSelectElement;
  private sizeInput: HTMLInputElement;
  private weightSelect: HTMLSelectElement;
  private italicToggle: HTMLInputElement;
  private alignTabs: ChoiceTabs<TextAlignOption>;
  private lineSpacingInput: HTMLInputElement;
  private letterSpacingInput: HTMLInputElement;
  private applyBtn: HTMLButtonElement;
  /** The path-only controls (`.offset()`, `.startAt()`, `.flip()`), shown
   * under the path slot while a path is selected. */
  private pathOptions: HTMLDivElement;
  private pathOffsetInput: HTMLInputElement;
  private startAtInput: HTMLInputElement;
  private flipToggle: HTMLInputElement;
  /** The Distribute row beside Align, path mode only; ≠ off grays Align. */
  private distributeRow: HTMLDivElement;
  private distributeTabs: ChoiceTabs<TextDistributeOption>;
  private alignJoin: HTMLDivElement;
  /** True while a path is selected — the path-only options apply. */
  private pathMode = false;
  /** Family chosen before the font list arrived; applied by setFonts. */
  private pendingFont: string | null = null;

  constructor(container: HTMLElement) {
    this.shell = new PanelShell(container, 'fluidcad-text-panel', 'Text', '/icons/text.png');
    this.shell.onEscape = () => this.onExit?.();
    this.shell.body.insertAdjacentHTML('beforeend', `
      <label class="flex flex-col gap-1.5">
        <span class="text-base-content/70">Text</span>
        <textarea data-role="text" rows="2" placeholder="Text"
          class="textarea textarea-sm textarea-bordered w-full text-xs leading-snug resize-y">Text</textarea>
      </label>
      <div data-role="path-slot"></div>
      <div data-role="path-options" class="hidden flex-col gap-3.5">
        <div class="flex items-center gap-1.5">
          <label class="flex flex-col gap-1.5 flex-1 min-w-0" title="Shift off the path in mm; negative moves to the other side">
            <span class="text-base-content/70">Offset</span>
            <input data-role="path-offset" type="number" step="0.5" value="0"
              class="input input-sm input-bordered w-full min-w-0 text-xs" />
          </label>
          <label class="flex flex-col gap-1.5 flex-1 min-w-0" title="Distance along the path before the text starts, in mm">
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
      <div class="flex items-center gap-1.5">
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
        <div data-role="align" class="join w-full"></div>
      </div>
      <div data-role="distribute-row" class="hidden flex-col gap-1.5"
        title="Spread the glyphs across the whole path; overrides Align">
        <span class="text-base-content/70">Distribute</span>
        <div data-role="distribute" class="join w-full"></div>
      </div>
      <div class="flex items-center gap-1.5">
        <label class="flex flex-col gap-1.5 flex-1 min-w-0" title="Multiplier on the font's natural line height">
          <span class="text-base-content/70">Line spacing</span>
          <input data-role="line-spacing" type="number" step="0.1" min="0.1" value="1"
            class="input input-sm input-bordered w-full min-w-0 text-xs" />
        </label>
        <label class="flex flex-col gap-1.5 flex-1 min-w-0" title="Extra advance between glyphs, in mm">
          <span class="text-base-content/70">Letter spacing</span>
          <input data-role="letter-spacing" type="number" step="0.1" value="0"
            class="input input-sm input-bordered w-full min-w-0 text-xs" />
        </label>
      </div>
      <div class="flex items-center gap-2 pt-1">
        <button data-role="apply" class="btn btn-primary btn-sm flex-1">Apply</button>
        <button data-role="exit" class="btn btn-ghost btn-sm">Exit</button>
      </div>
    `);

    this.pathSlot = new EntitySlotControl(
      this.shell.body.querySelector('[data-role="path-slot"]')!,
      { label: 'Follow path', prompt: 'Pick an edge', keepRemovable: true },
    );
    this.textInput = this.shell.body.querySelector('[data-role="text"]')!;
    this.fontSelect = this.shell.body.querySelector('[data-role="font"]')!;
    this.sizeInput = this.shell.body.querySelector('[data-role="size"]')!;
    this.weightSelect = this.shell.body.querySelector('[data-role="weight"]')!;
    this.italicToggle = this.shell.body.querySelector('[data-role="italic"]')!;
    this.lineSpacingInput = this.shell.body.querySelector('[data-role="line-spacing"]')!;
    this.letterSpacingInput = this.shell.body.querySelector('[data-role="letter-spacing"]')!;
    this.applyBtn = this.shell.body.querySelector('[data-role="apply"]')!;
    this.pathOptions = this.shell.body.querySelector('[data-role="path-options"]')!;
    this.pathOffsetInput = this.shell.body.querySelector('[data-role="path-offset"]')!;
    this.startAtInput = this.shell.body.querySelector('[data-role="path-start-at"]')!;
    this.flipToggle = this.shell.body.querySelector('[data-role="path-flip"]')!;
    this.distributeRow = this.shell.body.querySelector('[data-role="distribute-row"]')!;
    this.alignJoin = this.shell.body.querySelector('[data-role="align"]')!;

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
    this.alignTabs.onChange = () => this.onChange?.();

    this.distributeTabs = new ChoiceTabs<TextDistributeOption>(
      this.shell.body.querySelector('[data-role="distribute"]')!,
      [
        { key: 'off', label: 'Off', title: 'Align places the text at the path start/center/end' },
        { key: 'space-between', label: 'Between', title: 'First and last glyph pinned to the path ends, the rest spread evenly' },
        { key: 'space-around', label: 'Around', title: 'Glyphs spread evenly with half-gaps at the path ends' },
      ],
      'off',
    );
    this.distributeTabs.onChange = () => {
      this.syncAlignEnabled();
      this.onChange?.();
    };

    this.textInput.addEventListener('input', () => this.onChange?.());
    for (const input of [this.sizeInput, this.lineSpacingInput, this.letterSpacingInput,
      this.pathOffsetInput, this.startAtInput]) {
      input.addEventListener('input', () => this.onChange?.());
    }
    for (const select of [this.fontSelect, this.weightSelect]) {
      select.addEventListener('change', () => this.onChange?.());
    }
    this.italicToggle.addEventListener('change', () => this.onChange?.());
    this.flipToggle.addEventListener('change', () => this.onChange?.());

    // Typing in the dialog must not trigger the single-letter tool shortcuts
    // (window-level). Enter in a single-line field applies; the textarea
    // keeps Enter for new lines. Escape passes through to the shell's handler.
    const fields: HTMLElement[] = [
      this.textInput, this.fontSelect, this.sizeInput, this.weightSelect,
      this.lineSpacingInput, this.letterSpacingInput,
      this.pathOffsetInput, this.startAtInput,
    ];
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
    this.shell.body.querySelector('[data-role="exit"]')!
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

  /** A distribution overrides Align — gray the tabs while one is chosen. */
  private syncAlignEnabled(): void {
    const overridden = this.pathMode && this.distributeTabs.value !== 'off';
    this.alignJoin.classList.toggle('opacity-40', overridden);
    this.alignJoin.classList.toggle('pointer-events-none', overridden);
  }

  /** Programmatic option values (edit-mode prefill); no change event fires. */
  setValues(values: TextOptionValues): void {
    this.textInput.value = values.text;
    this.sizeInput.value = String(values.size);
    if (values.font && ![...this.fontSelect.options].some(o => o.value === values.font)) {
      // Not offered (yet): add it so the choice sticks — setFonts dedupes
      // when the real list arrives.
      const option = document.createElement('option');
      option.value = values.font;
      option.textContent = values.font;
      this.fontSelect.insertBefore(option, this.fontSelect.options[1] ?? null);
    }
    this.fontSelect.value = values.font ?? '';
    this.pendingFont = values.font;
    this.weightSelect.value = String(values.weight);
    this.italicToggle.checked = values.italic;
    if (values.align === 'space-between' || values.align === 'space-around') {
      this.distributeTabs.setValue(values.align);
      this.alignTabs.setValue('left');
    } else {
      this.distributeTabs.setValue('off');
      this.alignTabs.setValue(values.align);
    }
    this.lineSpacingInput.value = String(values.lineSpacing);
    this.letterSpacingInput.value = String(values.letterSpacing);
    this.pathOffsetInput.value = String(values.offset);
    this.startAtInput.value = String(values.startAt);
    this.flipToggle.checked = values.flip;
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

  /** Validated form values, or the message to show for an invalid field. */
  values(): TextOptionValues | { error: string } {
    const size = parseFloat(this.sizeInput.value);
    if (!Number.isFinite(size) || size <= 0) {
      return { error: 'Enter a positive text size.' };
    }
    const lineSpacing = parseFloat(this.lineSpacingInput.value);
    if (!Number.isFinite(lineSpacing) || lineSpacing <= 0) {
      return { error: 'Enter a positive line spacing factor.' };
    }
    const letterSpacing = parseFloat(this.letterSpacingInput.value);
    if (!Number.isFinite(letterSpacing)) {
      return { error: 'Enter a letter spacing in mm.' };
    }
    // The path-only options read as their defaults while no path is
    // selected — an anchored statement renders no path chains, whatever the
    // hidden fields still hold from an earlier pick.
    let offset = 0;
    let startAt = 0;
    let flip = false;
    if (this.pathMode) {
      offset = parseFloat(this.pathOffsetInput.value);
      if (!Number.isFinite(offset)) {
        return { error: 'Enter a path offset in mm.' };
      }
      startAt = parseFloat(this.startAtInput.value);
      if (!Number.isFinite(startAt) || startAt < 0) {
        return { error: 'Enter a non-negative start distance in mm.' };
      }
      flip = this.flipToggle.checked;
    }
    const distribute = this.pathMode ? this.distributeTabs.value : 'off';
    return {
      text: this.textInput.value,
      size,
      font: this.fontSelect.value || null,
      weight: parseInt(this.weightSelect.value, 10) || 400,
      italic: this.italicToggle.checked,
      align: distribute === 'off' ? this.alignTabs.value : distribute,
      lineSpacing,
      letterSpacing,
      offset,
      startAt,
      flip,
    };
  }
}
