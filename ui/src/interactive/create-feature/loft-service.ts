import { applyLoft, ApplyFeatureResponse, LoftApplyOptions, LoftProfileRef } from '../../api';
import { SceneObjectRender, SubSelection } from '../../types';
import { SelectedEntity, Viewer } from '../../viewer';
import { Navbar } from '../../ui/navbar';
import { ICON_IMG_FALLBACK } from '../../ui/object-icons';
import { LoftPanel } from './loft-panel';
import {
  collectSketchProfiles, labelWithSketchNames, optionsSignature, resolveSketchByShapeId, resolveSketchRow,
  SketchProfileOption,
} from './sketch-profiles';

const BTN_BASE = 'btn btn-ghost btn-square btn-sm text-base-content/60';
const BTN_ACTIVE = 'btn btn-soft btn-primary btn-square btn-sm';

const PREVIEW_DEBOUNCE_MS = 250;

function sameEntity(a: SelectedEntity, b: SelectedEntity): boolean {
  return a.shapeId === b.shapeId && a.sub.type === b.sub.type && a.sub.index === b.sub.index;
}

/** One ordered profile in the dialog: a sketch or a face picked in 3D. */
type LoftProfileItem =
  | { kind: 'sketch'; option: SketchProfileOption }
  | { kind: 'face'; entity: SelectedEntity };

/**
 * The Loft dialog on the create rails: an ordered multi-profile slot. Each
 * profile is a numbered, removable chip whose order is the loft's argument
 * order. Profiles come from three sources: face picks in the 3D view (live
 * the whole time the dialog is armed — each click appends a chip, clicking a
 * picked face removes it), the add-sketch dropdown, and timeline sketch
 * clicks. Arming from inside a sketch suspends sketch editing immediately
 * (the sweep behavior) so the camera is free and clicks pick faces. Apply
 * writes `loft(<profiles…>)` with `.thin()`/`.remove()`/`.new()` chains.
 */
export class LoftFeatureService {
  private panel: LoftPanel;
  private button: HTMLButtonElement;
  private armed = false;
  private available = false;
  private applying = false;
  private profiles: SketchProfileOption[] = [];
  private sceneObjects: SceneObjectRender[] = [];
  private hasSolid = false;
  private sceneSketchActive = false;
  private suspendedSketchUI = false;

  private items: LoftProfileItem[] = [];
  private labelSignature = '';

  private previewTimer: number | null = null;
  private previewAbort: AbortController | null = null;
  private previewSeq = 0;

  constructor(
    container: HTMLElement,
    private viewer: Viewer,
    private navbar: Navbar,
    private hooks: {
      onEnter?: () => void;
      onSuspendSketchUI?: () => void;
      onResumeSketchUI?: () => void;
    } = {},
  ) {
    const group = navbar.getGroup('create') ?? navbar.addGroup('create', { visible: false, immune: true });
    this.button = document.createElement('button');
    this.button.className = BTN_BASE;
    this.button.title = 'Loft between two or more profiles';
    this.button.innerHTML = `<img src="/icons/loft.png" ${ICON_IMG_FALLBACK} class="w-4 h-4 object-contain" alt="" />`;
    this.button.addEventListener('click', () => {
      if (this.armed) {
        this.exit();
      } else {
        this.enter();
      }
    });
    group.appendChild(this.button);

    this.panel = new LoftPanel(container);
    this.panel.onApply = () => this.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.schedulePreview();
    };
    this.panel.onAddSketch = (option) => this.addSketchProfile(option);
    this.panel.onRemoveProfile = (index) => this.removeProfile(index);
    this.panel.onReorderProfile = (from, to) => this.reorderProfile(from, to);
  }

  get isActive(): boolean {
    return this.armed;
  }

  /** Face picks are live the whole time the dialog is armed. */
  get isFacePicking(): boolean {
    return this.armed;
  }

  /** True while the armed dialog has suspended sketch editing. */
  get sketchUISuspended(): boolean {
    return this.suspendedSketchUI;
  }

  update(sceneObjects: SceneObjectRender[]): void {
    this.sceneObjects = sceneObjects;
    this.profiles = collectSketchProfiles(sceneObjects);
    this.hasSolid = sceneObjects.some(o =>
      o.sceneShapes?.some(s => s.shapeType === 'solid' && !s.isMetaShape && !s.isGuide));
    this.sceneSketchActive = this.profiles[0]?.kind === 'active';
    // A loft needs two profile sources: solid faces to pick, or two sketches.
    this.available = this.hasSolid || this.profiles.length >= 2;
    this.navbar.setGroupVisible('create', this.available, 'loft');
    this.syncButton();
    if (!this.armed) {
      return;
    }
    if (!this.available) {
      this.exit({ resume: 'lazy' });
      return;
    }
    // A render can put a sketch back in front (live editing) — the armed
    // dialog keeps the free 3D view.
    if (this.sceneSketchActive) {
      this.suspendSketchUI();
    }
    this.viewer.pickFilter = 'face';
    this.viewer.pickSketchWires = true;
    // Shape ids changed with the render: face chips are stale and drop;
    // sketch chips are line-addressed and survive while still offered.
    this.items = this.items.filter((item): item is LoftProfileItem & { kind: 'sketch' } => {
      if (item.kind !== 'sketch') {
        return false;
      }
      const refreshed = this.findOption(item.option.filePath, item.option.line);
      if (!refreshed) {
        return false;
      }
      item.option = refreshed;
      return true;
    });
    this.refreshSketchLabels();
    this.refreshProfilesUI();
    this.schedulePreview();
  }

  enter(): void {
    if (this.armed) {
      return;
    }
    this.hooks.onEnter?.();
    this.armed = true;
    // Composing a loft means looking at the whole scene, not down the active
    // sketch plane — leave sketch editing right away (resumed on cancel; an
    // apply's re-render takes over).
    if (this.sceneSketchActive) {
      this.suspendSketchUI();
    }
    this.syncButton();
    this.viewer.pickFilter = 'face';
    this.viewer.pickSketchWires = true;
    this.items = [];
    this.panel.show();
    this.refreshSketchLabels();
    this.refreshProfilesUI();
    this.schedulePreview();
  }

  /**
   * `resume: 'lazy'` re-enables sketch editing without forcing the mode
   * transition — for apply-success and scene-driven exits. User cancels
   * default to `'immediate'`.
   */
  exit(opts: { resume?: 'immediate' | 'lazy' } = {}): void {
    if (!this.armed) {
      return;
    }
    this.armed = false;
    this.syncButton();
    this.cancelPreview();
    this.items = [];
    this.viewer.clearHighlight();
    this.viewer.pickFilter = 'all';
    this.viewer.pickSketchWires = false;
    this.panel.hide();
    this.resumeSketchUI((opts.resume ?? 'immediate') === 'immediate');
  }

  /**
   * Routes viewer clicks while the dialog is armed: a face pick appends a
   * profile chip, clicking an already-picked face removes it, empty-space
   * clicks keep the list.
   */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.armed || !shapeId || !sub || sub.type !== 'face') {
      return;
    }
    this.panel.setMessage(null);
    const entity: SelectedEntity = { shapeId, sub };
    const existing = this.items.findIndex(item => item.kind === 'face' && sameEntity(item.entity, entity));
    if (existing >= 0) {
      this.items = this.items.filter((_, i) => i !== existing);
    } else {
      this.items = [...this.items, { kind: 'face', entity }];
    }
    this.refreshProfilesUI();
    this.schedulePreview();
  }

  /**
   * A timeline row was clicked while the dialog is armed: the sketch appends
   * a profile chip. Consumed on any sketch row so the default rollback can't
   * close the dialog mid-flow.
   */
  handleTimelinePick(obj: SceneObjectRender): boolean {
    if (!this.armed) {
      return false;
    }
    const sketch = resolveSketchRow(obj, this.sceneObjects);
    if (!sketch?.sourceLocation) {
      return false;
    }
    this.pickSketch(sketch);
    return true;
  }

  /** A sketch wire was clicked in the 3D view: same as a timeline pick. */
  handleSketchPick(shapeId: string): boolean {
    if (!this.armed) {
      return false;
    }
    const sketch = resolveSketchByShapeId(shapeId, this.sceneObjects);
    if (!sketch?.sourceLocation) {
      return false;
    }
    this.pickSketch(sketch);
    return true;
  }

  private pickSketch(sketch: SceneObjectRender): void {
    const loc = sketch.sourceLocation!;
    const option = this.findOption(loc.filePath, loc.line);
    if (!option) {
      this.panel.setMessage('That sketch was already consumed — only sketches still rendered in the scene can be used.');
      return;
    }
    this.addSketchProfile(option);
  }

  private addSketchProfile(option: SketchProfileOption): void {
    if (!this.armed) {
      return;
    }
    const duplicate = this.items.some(item => item.kind === 'sketch'
      && item.option.filePath === option.filePath && item.option.line === option.line);
    if (duplicate) {
      this.panel.setMessage('That sketch is already a profile — each profile must be different.');
      return;
    }
    this.panel.setMessage(null);
    this.items = [...this.items, { kind: 'sketch', option }];
    this.refreshProfilesUI();
    this.schedulePreview();
  }

  private removeProfile(index: number): void {
    if (index < 0 || index >= this.items.length) {
      return;
    }
    this.panel.setMessage(null);
    this.items = this.items.filter((_, i) => i !== index);
    this.refreshProfilesUI();
    this.schedulePreview();
  }

  /** Move the chip at `from` to position `to` — order is argument order. */
  private reorderProfile(from: number, to: number): void {
    if (from === to || from < 0 || to < 0 || from >= this.items.length || to >= this.items.length) {
      return;
    }
    this.panel.setMessage(null);
    const items = [...this.items];
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);
    this.items = items;
    this.refreshProfilesUI();
    this.schedulePreview();
  }

  private async apply(): Promise<void> {
    if (!this.armed || this.applying) {
      return;
    }
    const request = this.buildRequest();
    if ('error' in request) {
      this.panel.setMessage(request.error);
      return;
    }
    this.applying = true;
    this.syncApplyEnabled();
    try {
      const result = await applyLoft(request);
      if (result.success) {
        // The editor round-trip re-renders the scene; that render is the
        // preview and editor undo is the rollback.
        this.exit({ resume: 'lazy' });
      } else {
        this.panel.setMessage(result.reason ?? 'Could not apply the loft.');
      }
    } finally {
      this.applying = false;
      this.syncApplyEnabled();
    }
  }

  /** The request for the current form state, or the message blocking it. */
  private buildRequest(): LoftApplyOptions | { error: string } {
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    if (this.items.length < 2) {
      return { error: 'A loft needs at least two profiles — pick faces or add sketches.' };
    }
    const profiles: LoftProfileRef[] = [];
    for (const item of this.items) {
      if (item.kind === 'sketch') {
        if (!item.option.hasGeometry) {
          return { error: `Nothing is drawn in "${item.option.label}" yet.` };
        }
        profiles.push({
          kind: 'sketch',
          filePath: item.option.filePath,
          line: item.option.line,
          column: item.option.column,
        });
      } else {
        profiles.push({ kind: 'face', entity: item.entity });
      }
    }
    return { op: values.op, thin: values.thin, profiles };
  }

  // -------------------------------------------------------------------------
  // Profile list + sketch-editing suspension
  // -------------------------------------------------------------------------

  private refreshProfilesUI(): void {
    this.panel.setProfiles(this.items.map(item => ({
      label: item.kind === 'sketch' ? item.option.label : 'Picked face',
    })));
    this.panel.setSketchOptions(this.profiles.filter(option =>
      !this.items.some(item => item.kind === 'sketch'
        && item.option.filePath === option.filePath && item.option.line === option.line)));
    const count = this.items.length;
    if (count === 0) {
      this.panel.setHint('Pick faces in 3D or add sketches', true);
    } else if (count === 1) {
      this.panel.setHint('1 profile — add at least one more', true);
    } else {
      this.panel.setHint(`${count} profiles — chip order is the loft order`, false);
    }
    const faces = this.items
      .filter((item): item is LoftProfileItem & { kind: 'face' } => item.kind === 'face')
      .map(item => item.entity);
    if (faces.length > 0) {
      this.viewer.highlightEntities(faces);
    } else {
      this.viewer.clearHighlight();
    }
    this.syncApplyEnabled();
  }

  private findOption(filePath: string, line: number): SketchProfileOption | undefined {
    return this.profiles.find(o => o.filePath === filePath && o.line === line);
  }

  private suspendSketchUI(): void {
    if (this.suspendedSketchUI) {
      return;
    }
    this.suspendedSketchUI = true;
    this.viewer.suspendSketchEditing();
    this.hooks.onSuspendSketchUI?.();
  }

  private resumeSketchUI(immediate: boolean): void {
    if (!this.suspendedSketchUI) {
      return;
    }
    this.suspendedSketchUI = false;
    this.viewer.resumeSketchEditing(immediate);
    if (immediate) {
      this.hooks.onResumeSketchUI?.();
    }
  }

  /**
   * Async label pass: sketches bound to variables show their names in the
   * dropdown and chips ("spine — line 3"). Applied only if the dialog is
   * still armed on the same option set when the lookup lands.
   */
  private async refreshSketchLabels(): Promise<void> {
    const signature = optionsSignature(this.profiles);
    this.labelSignature = signature;
    const labeled = await labelWithSketchNames(this.profiles);
    if (!this.armed || this.labelSignature !== signature) {
      return;
    }
    this.profiles = labeled;
    for (const item of this.items) {
      if (item.kind === 'sketch') {
        const refreshed = this.findOption(item.option.filePath, item.option.line);
        if (refreshed) {
          item.option = refreshed;
        }
      }
    }
    this.refreshProfilesUI();
  }

  private syncApplyEnabled(): void {
    this.panel.setApplyEnabled(!this.applying && this.items.length >= 2);
  }

  private syncButton(): void {
    this.button.className = this.armed ? BTN_ACTIVE : BTN_BASE;
    this.button.classList.toggle('hidden', !this.available);
  }

  // -------------------------------------------------------------------------
  // Statement preview: debounced server render with truthful variable names.
  // -------------------------------------------------------------------------

  private schedulePreview(): void {
    this.cancelPreview();
    if (!this.armed) {
      return;
    }
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = null;
      this.runPreview();
    }, PREVIEW_DEBOUNCE_MS);
  }

  private async runPreview(): Promise<void> {
    if (!this.armed || this.applying) {
      return;
    }
    const request = this.buildRequest();
    if ('error' in request) {
      this.panel.setPreview(null);
      return;
    }
    const seq = ++this.previewSeq;
    this.previewAbort?.abort();
    const abort = new AbortController();
    this.previewAbort = abort;

    let result: ApplyFeatureResponse;
    try {
      result = await applyLoft({ ...request, preview: true, signal: abort.signal });
    } catch {
      return; // aborted
    }
    if (seq !== this.previewSeq || !this.armed) {
      return;
    }
    this.panel.setPreview(result.success ? result.preview ?? null : null);
    if (result.success) {
      // A scene-driven preview (update() reruns it without a user action)
      // must clear a refusal that no longer applies.
      this.panel.setMessage(null);
    } else if (result.reason) {
      // Pre-Apply refusals (unsynthesizable face, cross-file profiles)
      // surface immediately, like the modify rails.
      this.panel.setMessage(result.reason);
    }
  }

  private cancelPreview(): void {
    if (this.previewTimer !== null) {
      window.clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    this.previewAbort?.abort();
    this.previewAbort = null;
    this.previewSeq++;
  }
}
