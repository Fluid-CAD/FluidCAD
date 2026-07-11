import { ICON_IMG_FALLBACK } from '../../ui/object-icons';

export type FeatureOp = 'add' | 'remove' | 'new';

const TAB_BASE = 'btn btn-sm join-item flex-1 font-normal';
const TAB_ACTIVE = 'btn btn-sm join-item flex-1 btn-soft btn-primary';

/**
 * A mutually-exclusive tab row shared by the create-feature dialogs.
 * Renders into `host` (a `join` row).
 */
export class ChoiceTabs<T extends string> {
  onChange?: () => void;

  private tabs = new Map<T, HTMLButtonElement>();
  private current: T;

  constructor(host: HTMLElement, choices: { key: T; label: string; title: string }[], initial: T) {
    this.current = initial;
    for (const { key, label, title } of choices) {
      const tab = document.createElement('button');
      tab.className = key === this.current ? TAB_ACTIVE : TAB_BASE;
      tab.textContent = label;
      tab.title = title;
      tab.addEventListener('click', () => this.set(key));
      host.appendChild(tab);
      this.tabs.set(key, tab);
    }
  }

  get value(): T {
    return this.current;
  }

  /** Programmatic tab choice (edit-mode prefill); no change event fires. */
  setValue(key: T): void {
    this.current = key;
    for (const [kind, tab] of this.tabs) {
      tab.className = kind === key ? TAB_ACTIVE : TAB_BASE;
    }
  }

  private set(key: T): void {
    if (this.current === key) {
      return;
    }
    this.setValue(key);
    this.onChange?.();
  }
}

/** The boolean-operation tab row (Add / Remove / New). */
export class OpTabs extends ChoiceTabs<FeatureOp> {
  constructor(host: HTMLElement, ops: { op: FeatureOp; label: string; title: string }[]) {
    super(host, ops.map(({ op, label, title }) => ({ key: op, label, title })), 'add');
  }

  get op(): FeatureOp {
    return this.value;
  }

  /** Programmatic tab choice (edit-mode prefill); no change event fires. */
  setOp(op: FeatureOp): void {
    this.setValue(op);
  }
}

/**
 * The "Thin walls" toggle with its thickness field, shared by the
 * create-feature dialogs. Appends its own rows into `container`.
 */
export class ThinControl {
  onChange?: () => void;
  /** Enter pressed inside the thickness field — the dialogs apply. */
  onSubmit?: () => void;

  private checkbox: HTMLInputElement;
  private toggle: HTMLElement;
  private valueWrap: HTMLElement;
  private input: HTMLInputElement;

  constructor(container: HTMLElement) {
    const toggle = document.createElement('label');
    toggle.className = 'flex items-center gap-2 cursor-pointer';
    toggle.innerHTML = `
      <input data-role="thin" type="checkbox" class="checkbox checkbox-sm" />
      <span class="text-base-content/70">Thin walls</span>
    `;
    container.appendChild(toggle);
    this.toggle = toggle;

    this.valueWrap = document.createElement('label');
    this.valueWrap.className = 'hidden flex-col gap-1.5';
    this.valueWrap.innerHTML = `
      <span class="text-base-content/70">Wall thickness</span>
      <input data-role="thin-value" type="number" step="0.5" min="0.05" value="2"
        class="input input-sm input-bordered w-full text-xs" />
    `;
    container.appendChild(this.valueWrap);

    this.checkbox = toggle.querySelector('[data-role="thin"]')!;
    this.input = this.valueWrap.querySelector('[data-role="thin-value"]')!;

    this.checkbox.addEventListener('change', () => {
      this.sync();
      this.onChange?.();
    });
    this.input.addEventListener('input', () => this.onChange?.());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.onSubmit?.();
      }
      e.stopPropagation();
    });
  }

  /**
   * Block the toggle while the feature's current inputs exclude thin mode
   * (loft guides). Blocking unchecks — a checked-but-ignored toggle would
   * lie about the statement being written.
   */
  setBlocked(blocked: boolean, reason: string): void {
    this.checkbox.disabled = blocked;
    this.toggle.title = blocked ? reason : '';
    this.toggle.classList.toggle('opacity-50', blocked);
    this.toggle.classList.toggle('cursor-not-allowed', blocked);
    this.toggle.classList.toggle('cursor-pointer', !blocked);
    if (blocked && this.checkbox.checked) {
      this.checkbox.checked = false;
      this.sync();
    }
  }

  /** Programmatic offsets (edit-mode prefill); no change event fires. */
  setValues(thin: [number] | null): void {
    this.checkbox.checked = thin !== null;
    if (thin !== null) {
      this.input.value = String(thin[0]);
    }
    this.sync();
  }

  /** The `.thin()` offsets, null when off, or the message for a bad value. */
  values(): { thin: [number] | null } | { error: string } {
    if (!this.checkbox.checked) {
      return { thin: null };
    }
    const thickness = parseFloat(this.input.value);
    if (!Number.isFinite(thickness) || thickness <= 0) {
      return { error: 'Enter a positive wall thickness.' };
    }
    return { thin: [thickness] };
  }

  private sync(): void {
    const on = this.checkbox.checked;
    this.valueWrap.classList.toggle('hidden', !on);
    this.valueWrap.classList.toggle('flex', on);
  }
}

/**
 * The floating dialog chrome the create-feature panels share: the docked
 * container, title row, and the statement-preview and error rows below the
 * body. Panels append their controls to `body`.
 */
export class PanelShell {
  readonly body: HTMLDivElement;

  private root: HTMLDivElement;
  private preview: HTMLDivElement;
  private message: HTMLDivElement;
  private titleText: HTMLSpanElement;
  private readonly defaultTitle: string;

  constructor(container: HTMLElement, id: string, title: string, iconSrc: string) {
    this.defaultTitle = title;
    this.root = document.createElement('div');
    this.root.id = id;
    this.root.className = 'absolute top-[116px] right-[76px] z-[999] pointer-events-auto hidden';
    this.root.innerHTML = `
      <div class="flex flex-col items-end gap-1.5">
        <div data-role="body" class="flex flex-col items-stretch gap-3.5 w-60 bg-base-100 border border-base-300 text-base-content rounded-lg px-4 py-4 text-xs select-none shadow-md">
          <div class="flex items-center gap-2.5">
            <img src="${iconSrc}" ${ICON_IMG_FALLBACK} class="w-4 h-4 object-contain" alt="" />
            <span data-role="title" class="font-medium text-sm">${title}</span>
          </div>
        </div>
        <div data-role="preview" class="hidden max-w-[380px] bg-base-100 border border-base-300 rounded-lg px-3 py-1.5 font-mono text-[11px] text-base-content shadow-md"></div>
        <div data-role="message" class="hidden max-w-[380px] bg-error text-error-content rounded-lg px-3 py-2 text-xs leading-snug shadow-md"></div>
      </div>
    `;
    container.appendChild(this.root);
    this.body = this.root.querySelector('[data-role="body"]')!;
    this.preview = this.root.querySelector('[data-role="preview"]')!;
    this.message = this.root.querySelector('[data-role="message"]')!;
    this.titleText = this.root.querySelector('[data-role="title"]')!;

    // Escape closes the dialog only from inside it — in sketch mode the
    // drawing tools own the global Escape.
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.onEscape?.();
      }
    });
  }

  onEscape?: () => void;

  get isVisible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  /** Retitle the dialog ("Edit extrude"); null restores the create title. */
  setTitle(title: string | null): void {
    this.titleText.textContent = title ?? this.defaultTitle;
  }

  show(): void {
    this.setMessage(null);
    this.setPreview(null);
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
    this.setMessage(null);
    this.setPreview(null);
  }

  setPreview(text: string | null): void {
    if (text) {
      this.preview.textContent = text;
      this.preview.classList.remove('hidden');
    } else {
      this.preview.textContent = '';
      this.preview.classList.add('hidden');
    }
  }

  setMessage(text: string | null): void {
    if (text) {
      this.message.textContent = text;
      this.message.classList.remove('hidden');
    } else {
      this.message.textContent = '';
      this.message.classList.add('hidden');
    }
  }
}
