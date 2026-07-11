import {
  applyExtrude, applyExtrudeEdit, ApplyFeatureResponse, ExtrudeProfileRef, FeatureEditTarget, ParsedFeatureStatement,
} from '../../api';
import { SceneObjectRender } from '../../types';
import { Viewer } from '../../viewer';
import { Navbar } from '../../ui/navbar';
import { ICON_IMG_FALLBACK } from '../../ui/object-icons';
import { ExtrudePanel } from './extrude-panel';
import {
  collectSketchProfiles, labelWithSketchNames, optionsSignature, resolveSketchByShapeId, resolveSketchRow,
  SketchProfileOption, sketchWireShapeIds,
} from './sketch-profiles';

const BTN_BASE = 'btn btn-ghost btn-square btn-sm text-base-content/60';
const BTN_ACTIVE = 'btn btn-soft btn-primary btn-square btn-sm';

const PREVIEW_DEBOUNCE_MS = 250;

/**
 * The create-features toolbar group (Extrude, for now). Unlike the modify
 * group it registers as `immune`, staying visible while the exclusive sketch
 * toolbar owns the bar — extruding is how a sketch gets finished: applying
 * writes `extrude(25)` after the active sketch, whose consumption is also
 * what exits sketch mode. Outside sketch mode the button shows whenever an
 * unconsumed sketch renders; the dialog's dropdown offers those sketches and
 * a chosen one is bound to a variable (`const s = sketch(…)` → `extrude(25,
 * s)`). No 3D picking is involved — the re-render is the preview and editor
 * undo is the rollback, as on the modify rails.
 */
export class ExtrudeFeatureService {
  private panel: ExtrudePanel;
  private button: HTMLButtonElement;
  private armed = false;
  private available = false;
  private options: SketchProfileOption[] = [];
  private sceneObjects: SceneObjectRender[] = [];
  private labelSignature = '';
  private applying = false;
  /** Statement being edited in place (timeline double-click), or null. */
  private editTarget: FeatureEditTarget | null = null;
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
    } = {},
  ) {
    const group = navbar.addGroup('create', { visible: false, immune: true });
    this.button = document.createElement('button');
    this.button.className = BTN_BASE;
    this.button.title = 'Extrude a sketch';
    this.button.innerHTML = `<img src="/icons/extrude.png" ${ICON_IMG_FALLBACK} class="w-4 h-4 object-contain" alt="" />`;
    this.button.addEventListener('click', () => {
      if (this.armed) {
        this.exit();
      } else {
        this.enter();
      }
    });
    group.appendChild(this.button);

    this.panel = new ExtrudePanel(container);
    this.panel.onApply = () => this.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.schedulePreview();
    };
  }

  get isActive(): boolean {
    return this.armed;
  }

  /**
   * Scene re-rendered: recompute the offered profiles and button visibility.
   * The dialog stays open across re-renders — in sketch mode every drawn
   * entity re-renders the scene, and closing would fight the user.
   */
  update(sceneObjects: SceneObjectRender[]): void {
    this.sceneObjects = sceneObjects;
    this.options = collectSketchProfiles(sceneObjects);
    this.available = this.options.length > 0;
    // The group is shared with the Sketch button — vote via our own slot and
    // hide our own button; the group shows while either contributor needs it.
    this.navbar.setGroupVisible('create', this.available, 'extrude');
    this.syncButton();
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
      this.exit();
      return;
    }
    this.viewer.pickSketchWires = true;
    this.panel.setOptions(this.options);
    this.refreshSketchLabels();
    this.refreshHighlight();
    this.schedulePreview();
  }

  /**
   * Open the dialog over an existing extrude/cut statement (timeline
   * double-click). No picking is involved — the profile is fixed to the
   * statement's own — and Apply rewrites the statement in place.
   */
  enterEdit(target: FeatureEditTarget, parsed: Extract<ParsedFeatureStatement, { feature: 'extrude' }>): void {
    if (this.armed) {
      this.exit();
    }
    this.hooks.onEnter?.();
    this.armed = true;
    this.editTarget = target;
    this.syncButton();
    this.panel.showEdit({
      op: parsed.op,
      distance: parsed.distance,
      distance2: parsed.distance2,
      symmetric: parsed.symmetric,
      draft: parsed.draft,
      drill: parsed.drill,
      thin: parsed.thin,
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
    // Clicking a sketch's wires in the 3D view selects it as the profile.
    this.viewer.pickSketchWires = true;
    this.syncButton();
    this.panel.show(this.options);
    this.refreshSketchLabels();
    this.refreshHighlight();
    this.schedulePreview();
  }

  /**
   * Async label pass: sketches bound to variables show their names in the
   * dropdown ("spine — line 3"). Applied only if the dialog is still armed
   * on the same option set when the lookup lands.
   */
  private async refreshSketchLabels(): Promise<void> {
    const signature = optionsSignature(this.options);
    this.labelSignature = signature;
    const labeled = await labelWithSketchNames(this.options);
    if (!this.armed || this.labelSignature !== signature) {
      return;
    }
    this.options = labeled;
    this.panel.setOptions(labeled);
  }

  exit(): void {
    if (!this.armed) {
      return;
    }
    this.armed = false;
    this.editTarget = null;
    this.viewer.pickSketchWires = false;
    this.viewer.clearHighlight();
    this.syncButton();
    this.cancelPreview();
    this.panel.hide();
  }

  /**
   * Highlight the selected profile's wires in the 3D view. The active sketch
   * is skipped: extrude never suspends sketch editing, and painting the
   * sketch being edited would fight the sketch tools' own rendering.
   */
  private refreshHighlight(): void {
    if (!this.armed) {
      return;
    }
    const option = this.panel.selectedOption();
    const wireIds = option && option.kind === 'other'
      ? sketchWireShapeIds(option, this.sceneObjects)
      : [];
    if (wireIds.length > 0) {
      this.viewer.highlightEntities([], wireIds);
    } else {
      this.viewer.clearHighlight();
    }
  }

  private syncButton(): void {
    this.button.className = this.armed ? BTN_ACTIVE : BTN_BASE;
    this.button.classList.toggle('hidden', !this.available);
    // Every armed flip lands here — the Sketch button disables while a
    // create dialog is up.
    this.hooks.onActiveChange?.();
  }

  /**
   * A timeline row was clicked while the dialog is armed. A sketch row (or a
   * child entity of one — the rect/circle rows nested under it) selects that
   * sketch as the profile. Returns true to consume the click — including on
   * an already-consumed sketch, where the timeline's default rollback would
   * otherwise close the dialog mid-flow.
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

  /** A sketch wire was clicked in the 3D view: selects it as the profile. */
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
    const index = this.options.findIndex(o => o.filePath === loc.filePath && o.line === loc.line);
    if (index < 0) {
      this.panel.setMessage('That sketch was already consumed — only sketches still rendered in the scene can be extruded.');
      return;
    }
    this.panel.selectProfile(index);
    this.panel.setMessage(null);
    this.refreshHighlight();
    this.schedulePreview();
  }

  private async apply(): Promise<void> {
    if (!this.armed || this.applying) {
      return;
    }
    const values = this.panel.values();
    if ('error' in values) {
      this.panel.setMessage(values.error);
      return;
    }
    if (this.editTarget) {
      this.applying = true;
      this.panel.setApplyEnabled(false);
      try {
        const result = await applyExtrudeEdit(this.editTarget, values);
        if (result.success) {
          this.exit();
        } else {
          this.panel.setMessage(result.reason ?? 'Could not apply the edit.');
        }
      } finally {
        this.applying = false;
        this.panel.setApplyEnabled(true);
      }
      return;
    }
    const option = this.panel.selectedOption();
    if (!option) {
      this.panel.setMessage('No sketch to extrude.');
      return;
    }
    if (!option.hasGeometry) {
      this.panel.setMessage('Draw a profile in the sketch first.');
      return;
    }

    this.applying = true;
    this.panel.setApplyEnabled(false);
    try {
      const result = await applyExtrude({ ...values, profile: profileRef(option) });
      if (result.success) {
        // The editor round-trip re-renders the scene; that render is the
        // preview and editor undo is the rollback.
        this.exit();
      } else {
        this.panel.setMessage(result.reason ?? 'Could not apply the extrude.');
      }
    } finally {
      this.applying = false;
      this.panel.setApplyEnabled(true);
    }
  }

  // -------------------------------------------------------------------------
  // Statement preview: debounced server render, so a bound profile shows the
  // variable name the transform will actually write.
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
    const values = this.panel.values();
    const option = this.editTarget ? null : this.panel.selectedOption();
    if ('error' in values || (!this.editTarget && !option)) {
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
        ? await applyExtrudeEdit(this.editTarget, { ...values, preview: true, signal: abort.signal })
        : await applyExtrude({
          ...values,
          profile: profileRef(option!),
          preview: true,
          signal: abort.signal,
        });
    } catch {
      return; // aborted
    }
    if (seq !== this.previewSeq || !this.armed) {
      return;
    }
    this.panel.setPreview(result.success ? result.preview ?? null : null);
    if (this.editTarget && !result.success && result.reason) {
      // The statement changed shape under the dialog (an undo, a concurrent
      // edit) — surface the refusal before Apply.
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

function profileRef(option: SketchProfileOption): ExtrudeProfileRef {
  return {
    mode: option.kind === 'active' ? 'active' : 'bound',
    filePath: option.filePath,
    line: option.line,
    column: option.column,
  };
}

