import {
  applySweep, applySweepEdit, ApplyFeatureChain, ApplyFeatureResponse, expandBucket,
  FeatureEditTarget, ParsedFeatureStatement, SelectionGroupKind, SweepApplyOptions,
} from '../../api';
import { entityKey, mergeUniqueEntities, sameEntity } from '../../helpers/entities';
import { SelectionContextMenu } from '../selection-menu';
import { SceneObjectRender, SubSelection } from '../../types';
import { SelectedEntity, Viewer } from '../../viewer';
import { Navbar } from '../../ui/navbar';
import { ICON_IMG_FALLBACK } from '../../ui/object-icons';
import { SweepPanel } from './sweep-panel';
import {
  collectSketchProfiles, labelWithSketchNames, optionsSignature, resolveSketchByShapeId, resolveSketchRow,
  SketchProfileOption, sketchWireShapeIds,
} from './sketch-profiles';

const BTN_BASE = 'btn btn-ghost btn-sm h-auto flex-col gap-0.5 px-2.5 py-1 text-base-content/60';
const BTN_ACTIVE = 'btn btn-soft btn-primary btn-sm h-auto flex-col gap-0.5 px-2.5 py-1';
/** Small muted caption under the toolbar icon. */
const BTN_LABEL = 'text-[10px] leading-none text-base-content/50';

const PREVIEW_DEBOUNCE_MS = 250;

/**
 * The Sweep dialog on the create rails: a profile sketch swept along a path.
 * Both slots take sketches (dropdown or timeline click into the focused
 * slot); the path alternatively takes edge picks in the 3D view — plain
 * clicks accumulate, right-click offers the multi-select menu (tangent
 * chain, classified bucket, occluded picks), double-click expands the
 * classified bucket, exactly like the modify rails. Arming edge
 * picking while a sketch is being edited suspends sketch editing (same
 * mechanism as sketch-on-face) so the camera is free and clicks pick edges.
 * Apply writes `sweep(<path>[, <profile>])` with `.thin()`/`.remove()`/
 * `.new()` chains — the re-render is the preview, editor undo the rollback.
 */
export class SweepFeatureService {
  private panel: SweepPanel;
  private button: HTMLButtonElement;
  /** daisyUI tooltip wrapper around {@link button}; hides with the button so no phantom toolbar gap. */
  private buttonWrap: HTMLElement;
  private armed = false;
  private available = false;
  private applying = false;
  private profiles: SketchProfileOption[] = [];
  private sceneObjects: SceneObjectRender[] = [];
  private hasSolid = false;
  private sceneSketchActive = false;
  private suspendedSketchUI = false;
  /** Statement being edited in place (timeline double-click), or null. */
  private editTarget: FeatureEditTarget | null = null;

  private entities: SelectedEntity[] = [];
  private chains: { seed: SelectedEntity; members: SelectedEntity[] }[] = [];
  private selectionMenu: SelectionContextMenu;
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
      /** Armed or disarmed — lets the Sketch button owner re-check `isActive`. */
      onActiveChange?: () => void;
      onSuspendSketchUI?: () => void;
      onResumeSketchUI?: () => void;
    } = {},
  ) {
    const group = navbar.getGroup('create') ?? navbar.addGroup('create', { visible: false, immune: true });
    this.button = document.createElement('button');
    this.button.className = BTN_BASE;
    this.button.setAttribute('aria-label', 'Sweep a sketch along a path');
    this.button.innerHTML = `<img src="/icons/sweep.png" ${ICON_IMG_FALLBACK} class="w-8 h-8 object-contain" alt="" /><span class="${BTN_LABEL}">Sweep</span>`;
    this.button.addEventListener('click', () => {
      if (this.armed) {
        this.exit();
      } else {
        this.enter();
      }
    });
    this.buttonWrap = document.createElement('span');
    this.buttonWrap.className = 'tooltip tooltip-bottom';
    this.buttonWrap.dataset.tip = 'Sweep a sketch along a path';
    this.buttonWrap.appendChild(this.button);
    group.appendChild(this.buttonWrap);

    this.panel = new SweepPanel(container);
    this.panel.onApply = () => this.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.schedulePreview();
    };
    this.panel.onPathModeChange = () => this.syncEdgePicking();

    // Right-click menu for path edge picks: multi-select groups + sibling
    // buckets ("Select other"). A path is one connected chain, so the
    // geometric same-type/equal groups (scattered edges) are not offered.
    this.selectionMenu = new SelectionContextMenu(container, 'fluidcad-sweep-pick-menu', {
      kinds: ['tangent', 'classified', 'sibling'],
      onSelectGroup: (kind, seed, members) => this.applyGroup(kind, seed, members),
      onPreview: (members) => {
        if (this.isEdgePicking) {
          this.refreshHighlight(members ?? []);
        }
      },
    });
  }

  get isActive(): boolean {
    return this.armed;
  }

  /** Edit mode never consumes viewport picks — the viewport stays neutral. */
  get isEditing(): boolean {
    return this.editTarget !== null;
  }

  /** Edge picks are live — the viewer routes clicks here. */
  get isEdgePicking(): boolean {
    return this.armed && !this.editTarget && this.panel.pathSelection()?.kind === 'edges';
  }

  /** True while armed edge picking has suspended sketch editing. */
  get sketchUISuspended(): boolean {
    return this.suspendedSketchUI;
  }

  update(sceneObjects: SceneObjectRender[]): void {
    this.sceneObjects = sceneObjects;
    this.profiles = collectSketchProfiles(sceneObjects);
    this.hasSolid = sceneObjects.some(o =>
      o.sceneShapes?.some(s => s.shapeType === 'solid' && !s.isMetaShape && !s.isGuide));
    this.sceneSketchActive = this.profiles[0]?.kind === 'active';
    // Offered whenever the scene has anything to work from — like Loft. The
    // dialog itself explains what's missing (a profile sketch, a path).
    this.available = this.hasSolid || this.profiles.length > 0;
    this.navbar.setGroupVisible('create', this.available, 'sweep');
    this.syncButton();
    this.hideContextMenu();
    if (!this.armed) {
      return;
    }
    if (this.editTarget) {
      // Edit mode tracks a statement, not the scene: the dialog rides out
      // renders (including the breakpoint render the double-click placed);
      // the preview re-parses the statement in case it changed.
      this.schedulePreview();
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
    this.viewer.pickSketchWires = true;
    // Shape ids changed with the render; the viewer already cleared highlights.
    this.entities = [];
    this.chains = [];
    this.panel.setOptions(this.profiles, this.profiles, this.hasSolid);
    this.refreshSketchLabels();
    this.syncEdgePicking();
    this.refreshHighlight();
    this.refreshPickCount();
    this.schedulePreview();
  }

  /**
   * Open the dialog over an existing sweep statement (timeline
   * double-click). No picking is involved — the path and profile are fixed
   * to the statement's own — and Apply rewrites the statement in place.
   */
  enterEdit(target: FeatureEditTarget, parsed: Extract<ParsedFeatureStatement, { feature: 'sweep' }>): void {
    if (this.armed) {
      this.exit();
    }
    this.hooks.onEnter?.();
    this.armed = true;
    this.editTarget = target;
    this.syncButton();
    this.panel.showEdit({
      op: parsed.op,
      thin: parsed.thin,
      pathLabel: parsed.pathText,
      profileLabel: parsed.profileText ?? 'Current sketch (implicit)',
    });
    this.schedulePreview();
  }

  enter(): void {
    if (this.armed) {
      return;
    }
    this.hooks.onEnter?.();
    this.armed = true;
    // Composing a sweep means looking at the whole scene, not down the
    // active sketch plane — leave sketch editing right away (resumed on
    // cancel; an apply's re-render takes over).
    if (this.sceneSketchActive) {
      this.suspendSketchUI();
    }
    this.viewer.pickSketchWires = true;
    this.syncButton();
    this.panel.show(this.profiles, this.profiles, this.hasSolid);
    this.refreshSketchLabels();
    this.syncEdgePicking();
    this.refreshHighlight();
    this.refreshPickCount();
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
    this.editTarget = null;
    this.syncButton();
    this.cancelPreview();
    this.entities = [];
    this.chains = [];
    this.viewer.clearHighlight();
    this.viewer.pickFilter = 'all';
    this.viewer.pickSketchWires = false;
    this.hideContextMenu();
    this.panel.hide();
    this.resumeSketchUI((opts.resume ?? 'immediate') === 'immediate');
  }

  /**
   * Routes viewer clicks while edge picking is live: plain clicks accumulate,
   * clicking a selected edge deselects it (a chain member deselects its whole
   * chain), empty-space clicks keep the selection.
   */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.isEdgePicking || !shapeId || !sub || sub.type !== 'edge') {
      return;
    }
    this.hideContextMenu();
    this.panel.setMessage(null);
    this.toggleEntity({ shapeId, sub });
  }

  /** Toggle a plain pick; a chain member toggles its whole chain off. */
  private toggleEntity(entity: SelectedEntity): void {
    const chain = this.chains.find(c => c.members.some(m => sameEntity(m, entity)));
    if (chain) {
      const memberKeys = new Set(chain.members.map(entityKey));
      this.entities = this.entities.filter(e => !memberKeys.has(entityKey(e)));
      this.chains = this.chains.filter(c => c !== chain);
    } else {
      const existing = this.entities.findIndex(e => sameEntity(e, entity));
      if (existing >= 0) {
        this.entities = this.entities.filter((_, i) => i !== existing);
      } else {
        this.entities = [...this.entities, entity];
      }
    }
    this.refreshHighlight();
    this.refreshPickCount();
    this.schedulePreview();
  }

  /** Double-click: expand the pick to its whole classified bucket. */
  async handleDoubleClick(shapeId: string | null, sub: SubSelection): Promise<void> {
    if (!this.isEdgePicking || !shapeId || !sub || sub.type !== 'edge') {
      return;
    }
    this.hideContextMenu();
    const result = await expandBucket({ shapeId, sub });
    if (!this.isEdgePicking) {
      return;
    }
    if ('error' in result) {
      this.panel.setMessage(result.error);
      return;
    }
    this.mergeEntities(result.members.map(m => ({ shapeId: m.shapeId, sub: m.sub })));
  }

  /** Merge group members into the path selection as plain picks. */
  private mergeEntities(members: SelectedEntity[]): void {
    const merged = mergeUniqueEntities(this.entities, members.filter(m => m.sub.type === 'edge'));
    if (merged.length === this.entities.length) {
      return;
    }
    this.entities = merged;
    this.refreshHighlight();
    this.refreshPickCount();
    this.schedulePreview();
  }

  /** Right-click on an edge: the multi-select menu for that path pick. */
  handleContextMenu(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): void {
    if (!this.isEdgePicking) {
      return;
    }
    this.hideContextMenu();
    if (!shapeId || !sub || sub.type !== 'edge') {
      return;
    }
    // The hover tint would otherwise be stashed as an "original" color by the
    // preview highlight and stick around after the preview restores it.
    this.viewer.clearHover();
    void this.selectionMenu.open({ shapeId, sub }, clientX, clientY);
  }

  /** A multi-select menu group was clicked. */
  private applyGroup(kind: SelectionGroupKind, seed: SelectedEntity, members: SelectedEntity[]): void {
    if (!this.isEdgePicking) {
      return;
    }
    this.panel.setMessage(null);
    if (kind === 'tangent') {
      this.addChain(seed, members);
    } else {
      this.mergeEntities(members);
    }
  }

  /** Record a tangent chain: it owns its members, replacing overlapping picks. */
  private addChain(seed: SelectedEntity, members: SelectedEntity[]): void {
    const memberKeys = new Set(members.map(entityKey));
    this.chains = this.chains.filter(c => !c.members.some(m => memberKeys.has(entityKey(m))));
    this.entities = [
      ...this.entities.filter(e => !memberKeys.has(entityKey(e))),
      ...members,
    ];
    this.chains.push({ seed, members });
    this.refreshHighlight();
    this.refreshPickCount();
    this.schedulePreview();
  }

  /**
   * A timeline row was clicked while the dialog is armed: the sketch lands in
   * the focused slot. Consumed on any sketch row so the default rollback
   * can't close the dialog mid-flow.
   */
  handleTimelinePick(obj: SceneObjectRender): boolean {
    if (!this.armed || this.editTarget) {
      return false;
    }
    const sketch = resolveSketchRow(obj, this.sceneObjects);
    if (!sketch?.sourceLocation) {
      return false;
    }
    this.pickSketch(sketch);
    return true;
  }

  /**
   * A sketch wire was clicked in the 3D view: same as a timeline pick — the
   * sketch lands in the focused slot.
   */
  handleSketchPick(shapeId: string): boolean {
    if (!this.armed || this.editTarget) {
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
    if (!this.panel.selectSketch(this.panel.armedSlot, loc.filePath, loc.line)) {
      this.panel.setMessage('That sketch was already consumed — only sketches still rendered in the scene can be used.');
      return;
    }
    this.panel.setMessage(null);
    this.syncEdgePicking();
    this.refreshHighlight();
    this.schedulePreview();
  }

  private async apply(): Promise<void> {
    if (!this.armed || this.applying) {
      return;
    }
    if (this.editTarget) {
      const values = this.panel.values();
      if ('error' in values) {
        this.panel.setMessage(values.error);
        return;
      }
      this.applying = true;
      this.panel.setApplyEnabled(false);
      try {
        const result = await applySweepEdit(this.editTarget, values);
        if (result.success) {
          this.exit({ resume: 'lazy' });
        } else {
          this.panel.setMessage(result.reason ?? 'Could not apply the edit.');
        }
      } finally {
        this.applying = false;
        this.panel.setApplyEnabled(true);
      }
      return;
    }
    const request = this.buildRequest();
    if ('error' in request) {
      this.panel.setMessage(request.error);
      return;
    }
    this.applying = true;
    this.panel.setApplyEnabled(false);
    try {
      const result = await applySweep(request);
      if (result.success) {
        // The editor round-trip re-renders the scene; that render is the
        // preview and editor undo is the rollback.
        this.exit({ resume: 'lazy' });
      } else {
        this.panel.setMessage(result.reason ?? 'Could not apply the sweep.');
      }
    } finally {
      this.applying = false;
      this.panel.setApplyEnabled(true);
    }
  }

  /** The request for the current form state, or the message blocking it. */
  private buildRequest(): SweepApplyOptions | { error: string } {
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    const profile = this.panel.selectedProfile();
    if (!profile) {
      return { error: 'No profile sketch to sweep.' };
    }
    if (!profile.hasGeometry) {
      return { error: 'Draw a profile in the sketch first.' };
    }
    const pathSel = this.panel.pathSelection();
    if (!pathSel) {
      return { error: 'Choose a path for the sweep.' };
    }
    let path: SweepApplyOptions['path'];
    if (pathSel.kind === 'sketch') {
      const option = pathSel.option;
      if (option.filePath === profile.filePath && option.line === profile.line) {
        return { error: 'The profile and path must be different sketches.' };
      }
      if (!option.hasGeometry) {
        return { error: 'The path sketch has nothing drawn.' };
      }
      path = { kind: 'sketch', filePath: option.filePath, line: option.line, column: option.column };
    } else {
      if (this.entities.length === 0) {
        return { error: 'Pick the path edges first.' };
      }
      path = {
        kind: 'edges',
        entities: this.entities,
        chains: this.chains.map((c): ApplyFeatureChain => ({ seed: c.seed, members: c.members })),
      };
    }
    return {
      op: values.op,
      thin: values.thin,
      profile: {
        mode: profile.kind === 'active' ? 'active' : 'bound',
        filePath: profile.filePath,
        line: profile.line,
        column: profile.column,
      },
      path,
    };
  }

  // -------------------------------------------------------------------------
  // Edge-pick mode + sketch-editing suspension
  // -------------------------------------------------------------------------

  /**
   * Align the viewer with the path slot: live edge picking narrows the pick
   * filter and, from inside a sketch, suspends sketch editing so the camera
   * is free. Switching the path back to a sketch keeps a suspension in place
   * — the camera shouldn't ping-pong mid-dialog; exit restores it.
   */
  private syncEdgePicking(): void {
    const picking = this.isEdgePicking;
    this.viewer.pickFilter = picking ? 'edge' : 'all';
    if (picking && this.sceneSketchActive) {
      this.suspendSketchUI();
    }
    if (!picking) {
      if (this.entities.length > 0) {
        this.entities = [];
        this.chains = [];
      }
      this.hideContextMenu();
    }
    this.refreshHighlight();
    this.refreshPickCount();
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
   * dropdowns ("spine — line 3"). Applied only if the dialog is still armed
   * on the same option set when the lookup lands.
   */
  private async refreshSketchLabels(): Promise<void> {
    const signature = optionsSignature(this.profiles);
    this.labelSignature = signature;
    const labeled = await labelWithSketchNames(this.profiles);
    if (!this.armed || this.labelSignature !== signature) {
      return;
    }
    this.profiles = labeled;
    this.panel.setOptions(labeled, labeled, this.hasSolid);
  }

  /**
   * Repaint the viewport selection: the picked path edges plus the wires of
   * the sketches chosen in the slots — the dialog's inputs stay visible in
   * 3D. `previewMembers` (a hovered menu item) show on top of the selection.
   */
  private refreshHighlight(previewMembers: SelectedEntity[] = []): void {
    if (!this.armed) {
      return;
    }
    const sketches: SketchProfileOption[] = [];
    const profile = this.panel.selectedProfile();
    if (profile) {
      sketches.push(profile);
    }
    const path = this.panel.pathSelection();
    if (path?.kind === 'sketch') {
      sketches.push(path.option);
    }
    const wireIds = sketches.flatMap(option => sketchWireShapeIds(option, this.sceneObjects));
    const shown = mergeUniqueEntities(this.entities, previewMembers);
    if (shown.length > 0 || wireIds.length > 0) {
      this.viewer.highlightEntities(shown, wireIds);
    } else {
      this.viewer.clearHighlight();
    }
  }

  private refreshPickCount(): void {
    const edges = this.entities.length;
    if (edges === 0) {
      this.panel.setPickCount('Pick edges', true);
      return;
    }
    const parts = [`${edges} edge${edges === 1 ? '' : 's'}`];
    if (this.chains.length > 0) {
      parts.push(`${this.chains.length} chain${this.chains.length === 1 ? '' : 's'}`);
    }
    this.panel.setPickCount(parts.join(' + '), false);
  }

  private hideContextMenu(): void {
    this.selectionMenu.hide();
  }

  private syncButton(): void {
    this.button.className = this.armed ? BTN_ACTIVE : BTN_BASE;
    this.buttonWrap.classList.toggle('hidden', !this.available);
    // Every armed flip lands here — the Sketch button disables while a
    // create dialog is up.
    this.hooks.onActiveChange?.();
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
    // Edit mode previews from the form values alone — the path and profile
    // stay whatever the statement already says.
    const request = this.editTarget ? this.panel.values() : this.buildRequest();
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
      result = this.editTarget
        ? await applySweepEdit(this.editTarget, { op: request.op, thin: request.thin, preview: true, signal: abort.signal })
        : await applySweep({ ...(request as SweepApplyOptions), preview: true, signal: abort.signal });
    } catch {
      return; // aborted
    }
    if (seq !== this.previewSeq || !this.armed) {
      return;
    }
    this.panel.setPreview(result.success ? result.preview ?? null : null);
    if (!result.success && result.reason) {
      // Pre-Apply refusals (unsynthesizable path, multi-part selection)
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
