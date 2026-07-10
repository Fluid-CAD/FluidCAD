import { applyExtrude, ApplyFeatureResponse, ExtrudeProfileRef } from '../../api';
import { isTopLevel } from '../../helpers/scene-utils';
import { SceneObjectRender } from '../../types';
import { Navbar } from '../../ui/navbar';
import { ICON_IMG_FALLBACK } from '../../ui/object-icons';
import { ExtrudePanel, SketchProfileOption } from './extrude-panel';

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
  private applying = false;
  private previewTimer: number | null = null;
  private previewAbort: AbortController | null = null;
  private previewSeq = 0;

  constructor(
    container: HTMLElement,
    private navbar: Navbar,
    private hooks: { onEnter?: () => void } = {},
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
    if (!this.available) {
      this.exit();
      return;
    }
    this.panel.setOptions(this.options);
    this.schedulePreview();
  }

  enter(): void {
    if (this.armed) {
      return;
    }
    this.hooks.onEnter?.();
    this.armed = true;
    this.syncButton();
    this.panel.show(this.options);
    this.schedulePreview();
  }

  exit(): void {
    if (!this.armed) {
      return;
    }
    this.armed = false;
    this.syncButton();
    this.cancelPreview();
    this.panel.hide();
  }

  private syncButton(): void {
    this.button.className = this.armed ? BTN_ACTIVE : BTN_BASE;
    this.button.classList.toggle('hidden', !this.available);
  }

  /**
   * A timeline row was clicked while the dialog is armed. A sketch row (or a
   * child entity of one — the rect/circle rows nested under it) selects that
   * sketch as the profile. Returns true to consume the click — including on
   * an already-consumed sketch, where the timeline's default rollback would
   * otherwise close the dialog mid-flow.
   */
  handleTimelinePick(obj: SceneObjectRender): boolean {
    if (!this.armed) {
      return false;
    }
    let sketch: SceneObjectRender | undefined =
      obj.type === 'sketch' ? obj : undefined;
    if (!sketch && obj.parentId != null) {
      const parent = this.sceneObjects.find(o => o.id === obj.parentId);
      if (parent?.type === 'sketch') {
        sketch = parent;
      }
    }
    if (!sketch?.sourceLocation) {
      return false;
    }
    const loc = sketch.sourceLocation;
    const index = this.options.findIndex(o => o.filePath === loc.filePath && o.line === loc.line);
    if (index < 0) {
      this.panel.setMessage('That sketch was already consumed — only sketches still rendered in the scene can be extruded.');
      return true;
    }
    this.panel.selectProfile(index);
    this.panel.setMessage(null);
    this.schedulePreview();
    return true;
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
    const option = this.panel.selectedOption();
    if (!option || 'error' in values) {
      this.panel.setPreview(null);
      return;
    }
    const seq = ++this.previewSeq;
    this.previewAbort?.abort();
    const abort = new AbortController();
    this.previewAbort = abort;

    let result: ApplyFeatureResponse;
    try {
      result = await applyExtrude({
        ...values,
        profile: profileRef(option),
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

/**
 * The sketches an extrude could consume right now: the active sketch (the
 * last top-level object, while sketch mode is on) plus every other sketch
 * still rendering geometry — a consumed sketch's shapes are removed by its
 * consumer, so "has visible shapes" is exactly "unconsumed". The active
 * sketch is offered even while empty; Apply refuses it with a hint.
 */
function collectSketchProfiles(sceneObjects: SceneObjectRender[]): SketchProfileOption[] {
  let lastTopLevel: SceneObjectRender | undefined;
  for (let i = sceneObjects.length - 1; i >= 0; i--) {
    if (isTopLevel(sceneObjects[i], sceneObjects)) {
      lastTopLevel = sceneObjects[i];
      break;
    }
  }
  const active = lastTopLevel?.type === 'sketch' && lastTopLevel.sourceLocation ? lastTopLevel : undefined;

  const options: SketchProfileOption[] = [];
  if (active) {
    options.push(toOption(active, 'active', sceneObjects));
  }
  for (const obj of sceneObjects) {
    if (obj === active || obj.type !== 'sketch' || !obj.sourceLocation) {
      continue;
    }
    if (!hasRenderedGeometry(obj, sceneObjects)) {
      continue;
    }
    options.push(toOption(obj, 'other', sceneObjects));
  }
  return options;
}

function toOption(
  obj: SceneObjectRender,
  kind: 'active' | 'other',
  sceneObjects: SceneObjectRender[],
): SketchProfileOption {
  const loc = obj.sourceLocation!;
  return {
    kind,
    label: kind === 'active' ? 'Active sketch' : `Sketch — line ${loc.line}`,
    filePath: loc.filePath,
    line: loc.line,
    column: loc.column,
    hasGeometry: hasRenderedGeometry(obj, sceneObjects),
  };
}

/**
 * A sketch's drawn geometry renders on its child objects (each entity — rect,
 * circle, line — is its own scene object under the sketch), so walk the
 * subtree, not just the sketch's own shapes.
 */
function hasRenderedGeometry(obj: SceneObjectRender, sceneObjects: SceneObjectRender[]): boolean {
  if ((obj.sceneShapes ?? []).some(s => !s.isMetaShape && !s.isGuide && (s.meshes?.length ?? 0) > 0)) {
    return true;
  }
  return sceneObjects.some(child =>
    child !== obj && child.parentId != null && child.parentId === obj.id
    && hasRenderedGeometry(child, sceneObjects));
}
