import { ICON_IMG_FALLBACK } from '../../ui/object-icons';

/** A sketch the extrude dialog can consume as its profile. */
export type SketchProfileOption = {
  /** `active` is the sketch being edited (implicit consumption). */
  kind: 'active' | 'other';
  label: string;
  filePath: string;
  line: number;
  column: number;
  /** False while the sketch has nothing drawn — Apply is refused with a hint. */
  hasGeometry: boolean;
};

export type ExtrudeOp = 'add' | 'remove' | 'new';

/** Validated form values, or the message to show when a field is invalid. */
export type ExtrudeValues =
  | { op: ExtrudeOp; distance: number | null; thin: [number] | null }
  | { error: string };

const TAB_BASE = 'btn btn-sm join-item flex-1 font-normal';
const TAB_ACTIVE = 'btn btn-sm join-item flex-1 btn-soft btn-primary';

const OPS: { op: ExtrudeOp; label: string; title: string }[] = [
  { op: 'add', label: 'Add', title: 'Fuse the extrusion with the model — extrude()' },
  { op: 'remove', label: 'Remove', title: 'Cut the extrusion out of the model — cut()' },
  { op: 'new', label: 'New', title: 'Keep the extrusion as a separate body — extrude().new()' },
];

/**
 * The extrude dialog: an Add / Remove / New tab row (the boolean operation),
 * the profile-sketch dropdown, the distance field (through-all on the Remove
 * tab disables it), and a thin() toggle with its thickness. Pure DOM + form
 * state — the service owns scene data, previews, and the apply call.
 */
export class ExtrudePanel {
  onChange?: () => void;
  onApply?: () => void;
  onExit?: () => void;

  private root: HTMLDivElement;
  private tabs = new Map<ExtrudeOp, HTMLButtonElement>();
  private op: ExtrudeOp = 'add';
  private profileSelect: HTMLSelectElement;
  private distanceLabel: HTMLElement;
  private distanceInput: HTMLInputElement;
  private throughWrap: HTMLElement;
  private throughCheckbox: HTMLInputElement;
  private thinCheckbox: HTMLInputElement;
  private thinValueWrap: HTMLElement;
  private thinInput: HTMLInputElement;
  private applyBtn: HTMLButtonElement;
  private preview: HTMLDivElement;
  private message: HTMLDivElement;
  private options: SketchProfileOption[] = [];

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'fluidcad-extrude-panel';
    this.root.className = 'absolute top-[116px] right-[76px] z-[999] pointer-events-auto hidden';
    this.root.innerHTML = `
      <div class="flex flex-col items-end gap-1.5">
        <div class="flex flex-col items-stretch gap-3.5 w-60 bg-base-100 border border-base-300 text-base-content rounded-lg px-4 py-4 text-xs select-none shadow-md">
          <div class="flex items-center gap-2.5">
            <img src="/icons/extrude.png" ${ICON_IMG_FALLBACK} class="w-4 h-4 object-contain" alt="" />
            <span class="font-medium text-sm">Extrude mode</span>
          </div>
          <div data-role="tabs" class="join w-full"></div>
          <label class="flex flex-col gap-1.5">
            <span class="text-base-content/70">Profile</span>
            <select data-role="profile" class="select select-sm select-bordered w-full text-xs"></select>
          </label>
          <label class="flex flex-col gap-1.5">
            <span class="text-base-content/70" data-role="distance-label">Distance</span>
            <input data-role="distance" type="number" step="0.5" value="25"
              class="input input-sm input-bordered w-full text-xs" />
          </label>
          <label data-role="through-wrap" class="hidden items-center gap-2 cursor-pointer">
            <input data-role="through" type="checkbox" class="checkbox checkbox-sm" />
            <span class="text-base-content/70">Through all</span>
          </label>
          <label class="flex items-center gap-2 cursor-pointer">
            <input data-role="thin" type="checkbox" class="checkbox checkbox-sm" />
            <span class="text-base-content/70">Thin walls</span>
          </label>
          <label data-role="thin-value-wrap" class="hidden flex-col gap-1.5">
            <span class="text-base-content/70">Wall thickness</span>
            <input data-role="thin-value" type="number" step="0.5" min="0.05" value="2"
              class="input input-sm input-bordered w-full text-xs" />
          </label>
          <div class="flex items-center gap-2 pt-1">
            <button data-role="apply" class="btn btn-primary btn-sm flex-1">Apply</button>
            <button data-role="exit" class="btn btn-ghost btn-sm">Exit</button>
          </div>
        </div>
        <div data-role="preview" class="hidden max-w-[380px] bg-base-100 border border-base-300 rounded-lg px-3 py-1.5 font-mono text-[11px] text-base-content shadow-md"></div>
        <div data-role="message" class="hidden max-w-[380px] bg-error text-error-content rounded-lg px-3 py-2 text-xs leading-snug shadow-md"></div>
      </div>
    `;
    container.appendChild(this.root);

    const tabsHost = this.root.querySelector('[data-role="tabs"]')!;
    for (const { op, label, title } of OPS) {
      const tab = document.createElement('button');
      tab.className = op === this.op ? TAB_ACTIVE : TAB_BASE;
      tab.textContent = label;
      tab.title = title;
      tab.addEventListener('click', () => this.setOp(op));
      tabsHost.appendChild(tab);
      this.tabs.set(op, tab);
    }

    this.profileSelect = this.root.querySelector('[data-role="profile"]')!;
    this.distanceLabel = this.root.querySelector('[data-role="distance-label"]')!;
    this.distanceInput = this.root.querySelector('[data-role="distance"]')!;
    this.throughWrap = this.root.querySelector('[data-role="through-wrap"]')!;
    this.throughCheckbox = this.root.querySelector('[data-role="through"]')!;
    this.thinCheckbox = this.root.querySelector('[data-role="thin"]')!;
    this.thinValueWrap = this.root.querySelector('[data-role="thin-value-wrap"]')!;
    this.thinInput = this.root.querySelector('[data-role="thin-value"]')!;
    this.applyBtn = this.root.querySelector('[data-role="apply"]')!;
    this.preview = this.root.querySelector('[data-role="preview"]')!;
    this.message = this.root.querySelector('[data-role="message"]')!;

    this.applyBtn.addEventListener('click', () => this.onApply?.());
    this.root.querySelector('[data-role="exit"]')!.addEventListener('click', () => this.onExit?.());
    this.profileSelect.addEventListener('change', () => this.onChange?.());
    this.throughCheckbox.addEventListener('change', () => {
      this.syncControls();
      this.onChange?.();
    });
    this.thinCheckbox.addEventListener('change', () => {
      this.syncControls();
      this.onChange?.();
    });
    for (const input of [this.distanceInput, this.thinInput]) {
      input.addEventListener('input', () => this.onChange?.());
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.onApply?.();
        }
        e.stopPropagation();
      });
    }
    // Escape closes the dialog only from inside it — in sketch mode the
    // drawing tools own the global Escape.
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.onExit?.();
      }
    });
  }

  get isVisible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  show(options: SketchProfileOption[]): void {
    this.setOptions(options);
    this.setMessage(null);
    this.setPreview(null);
    this.syncControls();
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
    this.setMessage(null);
    this.setPreview(null);
  }

  /**
   * Refresh the profile dropdown after a re-render, keeping the current
   * choice when the same sketch is still offered (matched by kind + source
   * location — scene ids change every render).
   */
  setOptions(options: SketchProfileOption[]): void {
    const previous = this.selectedOption();
    this.options = options;
    this.profileSelect.replaceChildren(...options.map((option, i) => {
      const el = document.createElement('option');
      el.value = String(i);
      el.textContent = option.label;
      return el;
    }));
    let index = 0;
    if (previous) {
      const match = options.findIndex(o => o.kind === previous.kind
        && (o.kind === 'active' || (o.filePath === previous.filePath && o.line === previous.line)));
      index = match >= 0 ? match : 0;
    }
    this.profileSelect.value = String(index);
    this.profileSelect.disabled = options.length <= 1;
  }

  selectedOption(): SketchProfileOption | null {
    return this.options[Number(this.profileSelect.value)] ?? null;
  }

  values(): ExtrudeValues {
    const throughAll = this.op === 'remove' && this.throughCheckbox.checked;
    let distance: number | null = null;
    if (!throughAll) {
      distance = parseFloat(this.distanceInput.value);
      if (!Number.isFinite(distance) || distance === 0) {
        return { error: `Enter a nonzero ${this.op === 'remove' ? 'depth' : 'distance'}.` };
      }
    }
    let thin: [number] | null = null;
    if (this.thinCheckbox.checked) {
      const thickness = parseFloat(this.thinInput.value);
      if (!Number.isFinite(thickness) || thickness <= 0) {
        return { error: 'Enter a positive wall thickness.' };
      }
      thin = [thickness];
    }
    return { op: this.op, distance, thin };
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

  setApplyEnabled(enabled: boolean): void {
    this.applyBtn.disabled = !enabled;
  }

  private setOp(op: ExtrudeOp): void {
    if (this.op === op) {
      return;
    }
    this.op = op;
    for (const [kind, tab] of this.tabs) {
      tab.className = kind === op ? TAB_ACTIVE : TAB_BASE;
    }
    this.syncControls();
    this.onChange?.();
  }

  /** Per-op control states: through-all is a Remove option and parks the depth. */
  private syncControls(): void {
    const removing = this.op === 'remove';
    this.distanceLabel.textContent = removing ? 'Depth' : 'Distance';
    this.throughWrap.classList.toggle('hidden', !removing);
    this.throughWrap.classList.toggle('flex', removing);
    this.distanceInput.disabled = removing && this.throughCheckbox.checked;
    const thin = this.thinCheckbox.checked;
    this.thinValueWrap.classList.toggle('hidden', !thin);
    this.thinValueWrap.classList.toggle('flex', thin);
  }
}
