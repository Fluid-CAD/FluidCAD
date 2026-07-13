import { OpTabs, PanelShell, ThinControl } from './panel-controls';
import { SketchProfileOption } from './sketch-profiles';
import { ExtrudeOptionValues } from '../../api';

/** How the extrusion distributes around the sketch plane. */
export type ExtrudeDirection = 'one' | 'symmetric' | 'two';

/** Validated form values, or the message to show when a field is invalid. */
export type ExtrudeValues = ExtrudeOptionValues | { error: string };

/**
 * The extrude dialog: an Add / Remove / New tab row (the boolean operation),
 * the profile-sketch dropdown, the direction mode (one direction, symmetric,
 * or two distances), the distance fields (through-all on the Remove tab
 * disables them), a draft angle, a drill-holes toggle, and a thin() toggle
 * with its thickness. Pure DOM + form state — the service owns scene data,
 * previews, and the apply call.
 */
export class ExtrudePanel {
  onChange?: () => void;
  onApply?: () => void;
  onExit?: () => void;

  private shell: PanelShell;
  private tabs: OpTabs;
  private thin: ThinControl;
  private profileSelect: HTMLSelectElement;
  private directionSelect: HTMLSelectElement;
  private distanceLabel: HTMLElement;
  private distanceInput: HTMLInputElement;
  private distance2Wrap: HTMLElement;
  private distance2Input: HTMLInputElement;
  private throughWrap: HTMLElement;
  private throughCheckbox: HTMLInputElement;
  private draftInput: HTMLInputElement;
  private drillCheckbox: HTMLInputElement;
  private applyBtn: HTMLButtonElement;
  private options: SketchProfileOption[] = [];

  constructor(container: HTMLElement) {
    this.shell = new PanelShell(container, 'fluidcad-extrude-panel', 'Extrude mode', '/icons/extrude.png');
    this.shell.onEscape = () => this.onExit?.();
    this.shell.body.insertAdjacentHTML('beforeend', `
      <div data-role="tabs" class="join w-full"></div>
      <label class="flex flex-col gap-1.5">
        <span class="text-base-content/70">Profile</span>
        <select data-role="profile" class="select select-sm select-bordered w-full text-xs"></select>
      </label>
      <label class="flex flex-col gap-1.5" title="How the extrusion distributes around the sketch plane">
        <span class="text-base-content/70">Direction</span>
        <select data-role="direction" class="select select-sm select-bordered w-full text-xs">
          <option value="one">One direction</option>
          <option value="symmetric">Symmetric</option>
          <option value="two">Two directions</option>
        </select>
      </label>
      <label class="flex flex-col gap-1.5">
        <span class="text-base-content/70" data-role="distance-label">Distance</span>
        <input data-role="distance" type="number" step="0.5" value="25"
          class="input input-sm input-bordered w-full text-xs" />
      </label>
      <label data-role="distance2-wrap" class="hidden flex-col gap-1.5"
        title="Extrusion distance on the opposite side of the sketch plane">
        <span class="text-base-content/70" data-role="distance2-label">Distance 2</span>
        <input data-role="distance2" type="number" step="0.5" value="25"
          class="input input-sm input-bordered w-full text-xs" />
      </label>
      <label data-role="through-wrap" class="hidden items-center justify-between cursor-pointer">
        <span class="text-base-content/70">Through all</span>
        <input data-role="through" type="checkbox" class="toggle toggle-sm toggle-primary" />
      </label>
      <label class="flex flex-col gap-1.5"
        title="Taper the side walls — positive expands outward, negative tapers inward; 0 is straight">
        <span class="text-base-content/70">Draft angle (°)</span>
        <input data-role="draft" type="number" step="0.5" value="0"
          class="input input-sm input-bordered w-full text-xs" />
      </label>
      <label class="flex items-center justify-between cursor-pointer"
        title="Treat inner closed regions of the profile as holes — off extrudes them solid">
        <span class="text-base-content/70">Drill holes</span>
        <input data-role="drill" type="checkbox" class="toggle toggle-sm toggle-primary" checked />
      </label>
      <div data-role="thin-host" class="contents"></div>
      <div class="flex items-center gap-2 pt-1">
        <button data-role="apply" class="btn btn-primary btn-sm flex-1">Apply</button>
        <button data-role="exit" class="btn btn-ghost btn-sm">Exit</button>
      </div>
    `);

    this.tabs = new OpTabs(this.shell.body.querySelector('[data-role="tabs"]')!, [
      { op: 'add', label: 'Add', title: 'Fuse the extrusion with the model — extrude()' },
      { op: 'remove', label: 'Remove', title: 'Cut the extrusion out of the model — cut()' },
      { op: 'new', label: 'New', title: 'Keep the extrusion as a separate body — extrude().new()' },
    ]);
    this.tabs.onChange = () => {
      this.syncControls();
      this.onChange?.();
    };
    this.thin = new ThinControl(this.shell.body.querySelector('[data-role="thin-host"]')!);
    this.thin.onChange = () => this.onChange?.();
    this.thin.onSubmit = () => this.onApply?.();

    this.profileSelect = this.shell.body.querySelector('[data-role="profile"]')!;
    this.directionSelect = this.shell.body.querySelector('[data-role="direction"]')!;
    this.distanceLabel = this.shell.body.querySelector('[data-role="distance-label"]')!;
    this.distanceInput = this.shell.body.querySelector('[data-role="distance"]')!;
    this.distance2Wrap = this.shell.body.querySelector('[data-role="distance2-wrap"]')!;
    this.distance2Input = this.shell.body.querySelector('[data-role="distance2"]')!;
    this.throughWrap = this.shell.body.querySelector('[data-role="through-wrap"]')!;
    this.throughCheckbox = this.shell.body.querySelector('[data-role="through"]')!;
    this.draftInput = this.shell.body.querySelector('[data-role="draft"]')!;
    this.drillCheckbox = this.shell.body.querySelector('[data-role="drill"]')!;
    this.applyBtn = this.shell.body.querySelector('[data-role="apply"]')!;

    this.applyBtn.addEventListener('click', () => this.onApply?.());
    this.shell.body.querySelector('[data-role="exit"]')!.addEventListener('click', () => this.onExit?.());
    this.profileSelect.addEventListener('change', () => this.onChange?.());
    this.directionSelect.addEventListener('change', () => {
      this.syncControls();
      this.onChange?.();
    });
    this.throughCheckbox.addEventListener('change', () => {
      this.syncControls();
      this.onChange?.();
    });
    this.drillCheckbox.addEventListener('change', () => this.onChange?.());
    for (const input of [this.distanceInput, this.distance2Input, this.draftInput]) {
      input.addEventListener('input', () => this.onChange?.());
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.onApply?.();
        }
        e.stopPropagation();
      });
    }
  }

  get isVisible(): boolean {
    return this.shell.isVisible;
  }

  show(options: SketchProfileOption[]): void {
    // A fresh arming starts from defaults — the previous session's choice
    // would otherwise be revived by source-line matching.
    this.options = [];
    this.shell.setTitle(null);
    this.setOptions(options);
    this.syncControls();
    this.shell.show();
  }

  /**
   * Open prefilled from an existing statement (edit mode). The profile slot
   * is fixed — it names the statement's own profile and can't change; the
   * op tabs, direction, distances, through-all, draft, drill and thin
   * controls edit in place.
   */
  showEdit(state: ExtrudeOptionValues & { thin: [number] | null; profileLabel: string }): void {
    this.options = [];
    this.shell.setTitle('Edit extrude');
    const fixed = document.createElement('option');
    fixed.textContent = state.profileLabel;
    this.profileSelect.replaceChildren(fixed);
    this.profileSelect.disabled = true;
    this.tabs.setOp(state.op);
    this.directionSelect.value = directionOf(state);
    if (state.distance !== null) {
      this.distanceInput.value = String(state.distance);
    }
    if (state.distance2 !== null) {
      this.distance2Input.value = String(state.distance2);
    }
    this.throughCheckbox.checked = state.distance === null;
    this.draftInput.value = String(state.draft ?? 0);
    this.drillCheckbox.checked = state.drill;
    this.thin.setValues(state.thin);
    this.syncControls();
    this.shell.show();
  }

  hide(): void {
    this.shell.hide();
  }

  /**
   * Refresh the profile dropdown after a re-render, keeping the current
   * choice when the same sketch is still offered (matched by kind + source
   * location — scene ids change every render).
   */
  setOptions(options: SketchProfileOption[]): void {
    const previous = this.selectedOption();
    this.options = options;
    if (options.length === 0) {
      const placeholder = document.createElement('option');
      placeholder.textContent = 'No sketch — create one first';
      placeholder.disabled = true;
      this.profileSelect.replaceChildren(placeholder);
      this.profileSelect.disabled = true;
      return;
    }
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

  /** Programmatic profile choice (a timeline pick); no change event fires. */
  selectProfile(index: number): void {
    if (this.options[index]) {
      this.profileSelect.value = String(index);
    }
  }

  values(): ExtrudeValues {
    const op = this.tabs.op;
    const direction = this.direction;
    const throughAll = this.throughAllActive();
    let distance: number | null = null;
    if (!throughAll) {
      distance = parseFloat(this.distanceInput.value);
      if (!Number.isFinite(distance) || distance === 0) {
        return { error: `Enter a nonzero ${op === 'remove' ? 'depth' : 'distance'}.` };
      }
    }
    let distance2: number | null = null;
    if (direction === 'two') {
      distance2 = parseFloat(this.distance2Input.value);
      if (!Number.isFinite(distance2) || distance2 === 0) {
        return { error: 'Enter a nonzero second distance.' };
      }
    }
    const draftAngle = parseFloat(this.draftInput.value || '0');
    if (!Number.isFinite(draftAngle)) {
      return { error: 'Enter a draft angle in degrees (0 for straight walls).' };
    }
    const thin = this.thin.values();
    if ('error' in thin) {
      return thin;
    }
    return {
      op,
      distance,
      distance2,
      symmetric: direction === 'symmetric',
      draft: draftAngle === 0 ? null : draftAngle,
      drill: this.drillCheckbox.checked,
      thin: thin.thin,
    };
  }

  setPreview(text: string | null): void {
    this.shell.setPreview(text);
  }

  setMessage(text: string | null): void {
    this.shell.setMessage(text);
  }

  setApplyEnabled(enabled: boolean): void {
    this.applyBtn.disabled = !enabled;
  }

  private get direction(): ExtrudeDirection {
    return this.directionSelect.value as ExtrudeDirection;
  }

  /** Through-all is a Remove option; a two-distance form has explicit depths. */
  private throughAllActive(): boolean {
    return this.tabs.op === 'remove' && this.direction !== 'two' && this.throughCheckbox.checked;
  }

  /**
   * Per-op and per-direction control states: the second distance belongs to
   * the two-directions mode, through-all to the other two on the Remove tab
   * (where it parks the depth), and labels follow the mode.
   */
  private syncControls(): void {
    const removing = this.tabs.op === 'remove';
    const direction = this.direction;
    const noun = removing ? 'Depth' : 'Distance';
    this.distanceLabel.textContent = direction === 'two'
      ? `${noun} 1`
      : direction === 'symmetric' ? `Total ${noun.toLowerCase()}` : noun;
    this.distance2Wrap.classList.toggle('hidden', direction !== 'two');
    this.distance2Wrap.classList.toggle('flex', direction === 'two');
    const throughOffered = removing && direction !== 'two';
    this.throughWrap.classList.toggle('hidden', !throughOffered);
    this.throughWrap.classList.toggle('flex', throughOffered);
    this.distanceInput.disabled = this.throughAllActive();
  }
}

/** The direction mode a parsed statement's options imply. */
function directionOf(state: { distance2: number | null; symmetric: boolean }): ExtrudeDirection {
  if (state.distance2 !== null) {
    return 'two';
  }
  return state.symmetric ? 'symmetric' : 'one';
}
