import { FeatureOp, OpTabs, PanelShell, ThinControl } from './panel-controls';
import { SketchProfileOption } from './sketch-profiles';

/** Sentinel value for the path dropdown's "pick edges in the 3D view" mode. */
const PICK_EDGES = '__edges__';

// The path count box mirrors the modify panel's selection field: primary
// outline while it awaits picks, neutral fill once populated.
const COUNT_BOX_BASE = 'flex items-center gap-2 rounded-md px-3 py-2.5 border transition-colors';
const COUNT_BOX_IDLE = 'bg-base-200 border-base-300 text-base-content/70';
const COUNT_BOX_ACTIVE = 'bg-primary/10 border-primary text-primary';

/** Validated form values, or the message to show when a field is invalid. */
export type SweepValues =
  | { op: FeatureOp; thin: [number] | null }
  | { error: string };

export type SweepPathSelection =
  | { kind: 'edges' }
  | { kind: 'sketch'; option: SketchProfileOption };

/**
 * The sweep dialog: operation tabs, the profile-sketch dropdown, and the
 * path slot — a dropdown offering "Pick edges in 3D" plus the scene's
 * sketches, with a count box while edge picking is live. Timeline picks land
 * in whichever slot was focused last (`armedSlot`). Pure DOM + form state —
 * the service owns scene data, edge picks, previews, and the apply call.
 */
export class SweepPanel {
  onChange?: () => void;
  onApply?: () => void;
  onExit?: () => void;
  /** The path dropdown switched between edge picking and a sketch. */
  onPathModeChange?: () => void;

  /** The slot a timeline sketch click fills — the one last focused. */
  armedSlot: 'profile' | 'path' = 'path';

  private shell: PanelShell;
  private tabs: OpTabs;
  private thin: ThinControl;
  private profileSelect: HTMLSelectElement;
  private pathSelect: HTMLSelectElement;
  private countBox: HTMLElement;
  private countText: HTMLElement;
  private applyBtn: HTMLButtonElement;
  private profileOptions: SketchProfileOption[] = [];
  private pathOptions: SketchProfileOption[] = [];
  private allowEdgePicking = false;

  constructor(container: HTMLElement) {
    this.shell = new PanelShell(container, 'fluidcad-sweep-panel', 'Sweep mode', '/icons/sweep.png');
    this.shell.onEscape = () => this.onExit?.();
    this.shell.body.insertAdjacentHTML('beforeend', `
      <div data-role="tabs" class="join w-full"></div>
      <label class="flex flex-col gap-1.5">
        <span class="text-base-content/70">Profile</span>
        <select data-role="profile" class="select select-sm select-bordered w-full text-xs"></select>
      </label>
      <label class="flex flex-col gap-1.5">
        <span class="text-base-content/70">Path</span>
        <select data-role="path" class="select select-sm select-bordered w-full text-xs"></select>
      </label>
      <div data-role="count-box" class="hidden ${COUNT_BOX_BASE} ${COUNT_BOX_ACTIVE}">
        <span data-role="count" class="whitespace-nowrap">Pick edges</span>
      </div>
      <div data-role="thin-host" class="contents"></div>
      <div class="flex items-center gap-2 pt-1">
        <button data-role="apply" class="btn btn-primary btn-sm flex-1">Apply</button>
        <button data-role="exit" class="btn btn-ghost btn-sm">Exit</button>
      </div>
    `);

    this.tabs = new OpTabs(this.shell.body.querySelector('[data-role="tabs"]')!, [
      { op: 'add', label: 'Add', title: 'Fuse the swept solid with the model — sweep()' },
      { op: 'remove', label: 'Remove', title: 'Cut the swept solid out of the model — sweep().remove()' },
      { op: 'new', label: 'New', title: 'Keep the swept solid as a separate body — sweep().new()' },
    ]);
    this.tabs.onChange = () => this.onChange?.();
    this.thin = new ThinControl(this.shell.body.querySelector('[data-role="thin-host"]')!);
    this.thin.onChange = () => this.onChange?.();
    this.thin.onSubmit = () => this.onApply?.();

    this.profileSelect = this.shell.body.querySelector('[data-role="profile"]')!;
    this.pathSelect = this.shell.body.querySelector('[data-role="path"]')!;
    this.countBox = this.shell.body.querySelector('[data-role="count-box"]')!;
    this.countText = this.shell.body.querySelector('[data-role="count"]')!;
    this.applyBtn = this.shell.body.querySelector('[data-role="apply"]')!;

    this.applyBtn.addEventListener('click', () => this.onApply?.());
    this.shell.body.querySelector('[data-role="exit"]')!.addEventListener('click', () => this.onExit?.());
    this.profileSelect.addEventListener('focus', () => this.setArmedSlot('profile'));
    this.pathSelect.addEventListener('focus', () => this.setArmedSlot('path'));
    this.profileSelect.addEventListener('change', () => this.onChange?.());
    this.pathSelect.addEventListener('change', () => {
      this.syncPathControls();
      this.onPathModeChange?.();
      this.onChange?.();
    });
  }

  get isVisible(): boolean {
    return this.shell.isVisible;
  }

  show(profiles: SketchProfileOption[], paths: SketchProfileOption[], allowEdgePicking: boolean): void {
    // A fresh arming starts from defaults — the previous session's slot
    // choices would otherwise be revived by source-line matching.
    this.profileOptions = [];
    this.pathOptions = [];
    this.shell.setTitle(null);
    this.setOptions(profiles, paths, allowEdgePicking);
    this.setArmedSlot('path');
    this.shell.show();
  }

  /**
   * Open prefilled from an existing statement (edit mode). The path and
   * profile slots are fixed — they name the statement's own expressions and
   * can't change; the op tabs and thin control edit in place.
   */
  showEdit(state: { op: FeatureOp; thin: [number] | null; pathLabel: string; profileLabel: string }): void {
    this.profileOptions = [];
    this.pathOptions = [];
    this.allowEdgePicking = false;
    this.shell.setTitle('Edit sweep');
    this.profileSelect.replaceChildren(makeOption('', state.profileLabel));
    this.profileSelect.disabled = true;
    this.pathSelect.replaceChildren(makeOption('', state.pathLabel));
    this.pathSelect.disabled = true;
    this.countBox.classList.add('hidden');
    this.profileSelect.classList.remove('select-primary');
    this.pathSelect.classList.remove('select-primary');
    this.tabs.setOp(state.op);
    this.thin.setValues(state.thin);
    this.shell.show();
  }

  hide(): void {
    this.shell.hide();
  }

  /**
   * Refresh both dropdowns after a re-render, keeping current choices when
   * the same sketch is still offered (matched by kind + source location).
   */
  setOptions(profiles: SketchProfileOption[], paths: SketchProfileOption[], allowEdgePicking: boolean): void {
    const prevProfile = this.selectedProfile();
    const prevPath = this.pathSelection();
    this.profileOptions = profiles;
    this.pathOptions = paths;
    this.allowEdgePicking = allowEdgePicking;

    if (profiles.length === 0) {
      const placeholder = makeOption('', 'No sketch — create one first');
      placeholder.disabled = true;
      this.profileSelect.replaceChildren(placeholder);
    } else {
      this.profileSelect.replaceChildren(...profiles.map((option, i) => makeOption(String(i), option.label)));
      this.profileSelect.value = String(matchOption(profiles, prevProfile));
    }
    this.profileSelect.disabled = profiles.length <= 1;

    const pathEntries: HTMLOptionElement[] = [];
    if (allowEdgePicking) {
      pathEntries.push(makeOption(PICK_EDGES, 'Pick edges in 3D'));
    }
    pathEntries.push(...paths.map((option, i) => makeOption(String(i), option.label)));
    this.pathSelect.replaceChildren(...pathEntries);
    if (prevPath?.kind === 'edges' && allowEdgePicking) {
      this.pathSelect.value = PICK_EDGES;
    } else if (prevPath?.kind === 'sketch') {
      const match = matchOption(paths, prevPath.option);
      this.pathSelect.value = paths[match] ? String(match) : this.defaultPathValue();
    } else {
      this.pathSelect.value = this.defaultPathValue();
    }
    this.pathSelect.disabled = pathEntries.length <= 1;
    this.syncPathControls();
  }

  selectedProfile(): SketchProfileOption | null {
    return this.profileOptions[Number(this.profileSelect.value)] ?? null;
  }

  pathSelection(): SweepPathSelection | null {
    if (this.pathSelect.value === PICK_EDGES) {
      return this.allowEdgePicking ? { kind: 'edges' } : null;
    }
    const option = this.pathOptions[Number(this.pathSelect.value)];
    return option ? { kind: 'sketch', option } : null;
  }

  /**
   * A timeline sketch pick for the armed slot. Returns false when the sketch
   * isn't among that slot's options.
   */
  selectSketch(slot: 'profile' | 'path', filePath: string, line: number): boolean {
    const options = slot === 'profile' ? this.profileOptions : this.pathOptions;
    const index = options.findIndex(o => o.filePath === filePath && o.line === line);
    if (index < 0) {
      return false;
    }
    const select = slot === 'profile' ? this.profileSelect : this.pathSelect;
    select.value = String(index);
    if (slot === 'path') {
      this.syncPathControls();
      this.onPathModeChange?.();
    }
    return true;
  }

  values(): SweepValues {
    const thin = this.thin.values();
    if ('error' in thin) {
      return thin;
    }
    return { op: this.tabs.op, thin: thin.thin };
  }

  /** Edge-pick progress: the count line, wearing the armed outline while empty. */
  setPickCount(text: string, empty: boolean): void {
    this.countText.textContent = text;
    this.countBox.className = `${COUNT_BOX_BASE} ${empty ? COUNT_BOX_ACTIVE : COUNT_BOX_IDLE}`;
    this.countBox.classList.toggle('hidden', this.pathSelection()?.kind !== 'edges');
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

  private defaultPathValue(): string {
    // Prefer a concrete sketch (the common sweep spine idiom) that isn't the
    // chosen profile; fall back to edge picking when none is available.
    const profile = this.selectedProfile();
    const other = this.pathOptions.findIndex(o =>
      !profile || o.filePath !== profile.filePath || o.line !== profile.line);
    if (other >= 0) {
      return String(other);
    }
    return this.allowEdgePicking ? PICK_EDGES : '';
  }

  private setArmedSlot(slot: 'profile' | 'path'): void {
    this.armedSlot = slot;
    this.profileSelect.classList.toggle('select-primary', slot === 'profile');
    this.pathSelect.classList.toggle('select-primary', slot === 'path');
  }

  private syncPathControls(): void {
    this.countBox.classList.toggle('hidden', this.pathSelection()?.kind !== 'edges');
  }
}

function makeOption(value: string, label: string): HTMLOptionElement {
  const el = document.createElement('option');
  el.value = value;
  el.textContent = label;
  return el;
}

function matchOption(options: SketchProfileOption[], previous: SketchProfileOption | null): number {
  if (!previous) {
    return 0;
  }
  const match = options.findIndex(o => o.kind === previous.kind
    && (o.kind === 'active' || (o.filePath === previous.filePath && o.line === previous.line)));
  return match >= 0 ? match : 0;
}
