import { Group, LineSegments } from 'three';
import {
  applyTextEdit, FeatureEditTarget, fetchSketchFeatureSources, getTextPreview, ParsedFeatureStatement,
  TextEditOptions, TextEditPath,
} from '../../api';
import { DebouncedTask } from '../../helpers/debounced-task';
import { PlaneData, SceneObjectRender } from '../../types';
import { Viewer } from '../../viewer';
import { pixelToSketchThreshold, projectToSketch, worldToSketch2D } from '../sketch-plane-utils';
import { buildPathTargetIndex, hitTestPathTargets, PathTargetEntry } from '../sketch-edge-utils';
import { PathHighlight } from '../tools/path-highlight';
import { EditSession, EditSessionInfo } from '../edit-session';
import { TextPanel } from '../tools/text-panel';
import { TextPreviewMesh } from '../tools/text-preview-mesh';
import { ApplyRunner } from './apply-runner';
import { SketchUISuspender } from './sketch-suspender';

const PREVIEW_DEBOUNCE_MS = 250;

/**
 * The text edit dialog (timeline double-click on a text row). The session
 * rolls the viewport back to just before the statement — the old glyphs
 * vanish and the live outline preview renders in their place, so edits show
 * against exactly the scene the statement builds in. The preview frame
 * comes from the paused parent sketch: its plane, and its cursor — where
 * the text statement starts. While the session holds an in-sketch boundary,
 * the camera is held down the sketch plane like sketch mode's (the sketch
 * UI itself stays suspended). Apply rewrites the statement in place; the
 * rebuild is the confirmation.
 *
 * The dialog's Path slot edits the `text("…", path)` overload: the
 * statement's own path seeds the keep chip (its ✕ drops the path — back to
 * plain anchored text), and arming the slot turns viewport clicks into
 * whole-geometry picks over the paused sketch, re-targeting the statement.
 * The effective path — the statement's own (server-resolved onto the paused
 * sketch's shapes) or the re-pick — is tinted in the viewport, and the
 * glyph outlines preview laid along it.
 */
export class TextEditService {
  private panel: TextPanel;
  private session = new EditSession();
  private editTarget: FeatureEditTarget | null = null;
  private armed = false;
  /** The statement's own path argument; seeds the keep chip. */
  private pathText: string | null = null;
  /** The keep chip's ✕ was clicked — the statement's path drops on apply. */
  private keepRemoved = false;
  /** The re-picked path geometry, or null. The shape ids are re-resolved by
   * owner line on every render — shape ids are per-render. */
  private pickedPath: { shapeId: string; shapeIds: string[]; line: number; label: string } | null = null;
  /** The statement's own path resolved onto the paused sketch's shapes —
   * the keep chip's highlight and glyph preview. Null when the server can't
   * resolve it (an exotic expression, an old workspace kernel). */
  private seededPath: { shapeId: string; shapeIds: string[] } | null = null;
  /** True while the Path slot awaits a viewport pick. */
  private pathArmed = false;
  /** Whole-geometry pick candidates of the paused sketch, statements
   * preceding the edited one only. */
  private pathIndex: PathTargetEntry[] = [];
  /** The effective path geometry's selection tint in the viewport. */
  private pathHighlight: PathHighlight;
  private boundPathMouseDown: (e: MouseEvent) => void;
  private boundPathMouseUp: (e: MouseEvent) => void;
  private boundPathMouseMove: (e: MouseEvent) => void;
  private pathDownX = 0;
  private pathDownY = 0;
  private plane: PlaneData | null = null;
  private anchor: [number, number] | null = null;
  private previewGroup = new Group();
  private sketchUI: SketchUISuspender;
  private runner: ApplyRunner<TextEditOptions>;
  /**
   * The dual debounced preview: the statement text the transform will write
   * (also surfacing drift refusals before Apply), then the outline geometry
   * — both under one cancellation scope, so a newer edit drops both.
   */
  private preview: DebouncedTask;

  constructor(
    container: HTMLElement,
    private viewer: Viewer,
    private hooks: {
      /** Another dialog may own the view — let it release first. */
      onEnter?: () => void;
      /** An edit session armed while a sketch is edited — release the sketch UI. */
      onSuspendSketchUI?: () => void;
      /** The suspension ended without an apply — restore the sketch UI. */
      onResumeSketchUI?: () => void;
    } = {},
  ) {
    this.sketchUI = new SketchUISuspender(viewer, hooks);
    this.pathHighlight = new PathHighlight(viewer.sceneContext);
    this.previewGroup.userData.isMetaShape = true;
    this.previewGroup.renderOrder = 3;
    this.panel = new TextPanel(container);
    this.panel.onApply = () => void this.runner.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.schedulePreview();
    };
    this.panel.pathSlot.onArm = () => this.togglePathArmed();
    this.panel.pathSlot.onRemove = () => this.handlePathRemove();
    this.boundPathMouseDown = (e: MouseEvent) => {
      this.pathDownX = e.clientX;
      this.pathDownY = e.clientY;
    };
    this.boundPathMouseUp = this.handlePathMouseUp.bind(this);
    this.boundPathMouseMove = this.handlePathMouseMove.bind(this);

    this.runner = new ApplyRunner({
      panel: this.panel,
      isArmed: () => this.armed && this.editTarget !== null,
      build: () => this.buildRequest(),
      send: (request, extras) => applyTextEdit(this.editTarget!, { ...request, ...extras }),
      onApplied: () => this.exit('apply'),
      failMessage: () => 'Could not apply the edit.',
      // The statement preview rides the dual DebouncedTask below instead —
      // it chains the outline render under the same cancellation scope.
      validateApply: () => {
        const values = this.panel.values();
        return !('error' in values) && values.text.trim() === ''
          ? { error: 'Enter the text to render.' }
          : null;
      },
    });
    this.preview = new DebouncedTask(PREVIEW_DEBOUNCE_MS,
      (signal, isCurrent) => this.runPreview(signal, isCurrent));
  }

  get isActive(): boolean {
    return this.armed;
  }

  /**
   * Open the dialog over an existing text statement, prefilled from its
   * parsed options. The session places the viewport at the pre-statement
   * boundary; the preview frame resolves when that render lands.
   */
  enterEdit(
    target: FeatureEditTarget,
    parsed: Extract<ParsedFeatureStatement, { feature: 'text' }>,
    info: Omit<EditSessionInfo, 'target'>,
  ): void {
    if (this.armed) {
      this.exit();
    }
    this.hooks.onEnter?.();
    this.armed = true;
    this.editTarget = target;
    this.pathText = parsed.pathText;
    this.keepRemoved = false;
    this.pickedPath = null;
    this.seededPath = null;
    this.pathIndex = [];
    if (parsed.pathText !== null) {
      this.panel.pathSlot.seedKeep(parsed.pathText);
    } else {
      this.panel.pathSlot.reset();
    }
    this.plane = null;
    this.anchor = null;
    this.sketchUI.suspend();
    this.session.begin({ ...info, target });
    this.viewer.sceneContext.scene.add(this.previewGroup);
    this.panel.setTitle('Edit text');
    this.panel.setValues({
      text: parsed.text,
      size: parsed.size,
      font: parsed.font,
      weight: parsed.weight,
      italic: parsed.italic,
      align: parsed.align,
      lineSpacing: parsed.lineSpacing,
      letterSpacing: parsed.letterSpacing,
      offset: parsed.offset,
      startAt: parsed.startAt,
      flip: parsed.flip,
    });
    this.panel.setPathMode(this.hasEffectivePath());
    this.panel.show();
    void TextPanel.loadFontFamilies().then((families) => {
      if (this.armed) {
        this.panel.setFonts(families);
      }
    });
    this.schedulePreview();
  }

  /**
   * Every render lands here. The session keeps the viewport at the
   * pre-statement boundary; when it settles there, the preview frame is
   * re-derived from the paused parent sketch.
   */
  handleSceneRendered(sceneObjects: SceneObjectRender[], stop: number, isRollback: boolean): void {
    const state = this.session.onSceneRendered(sceneObjects, stop, isRollback);
    if (state === 'inactive') {
      return;
    }
    if (!this.armed) {
      this.session.end('gone');
      return;
    }
    if (state === 'gone') {
      this.exit('gone');
      return;
    }
    if (state === 'waiting') {
      return;
    }
    this.resolvePreviewFrame(sceneObjects);
    this.schedulePreview();
  }

  /**
   * The outline preview's frame: the parent sketch's plane, and its cursor
   * at the boundary — the sketch is paused just before the text statement,
   * so its cursor is exactly where the text starts. Standalone text (no
   * parent sketch) keeps the statement preview only.
   */
  private resolvePreviewFrame(sceneObjects: SceneObjectRender[]): void {
    this.plane = null;
    this.anchor = null;
    this.pathIndex = [];
    const index = this.session.boundary?.index ?? -1;
    const row = sceneObjects[index];
    const parent = row?.parentId
      ? sceneObjects.find(o => o.id === row.parentId)
      : null;
    const plane: PlaneData | undefined = parent?.object?.plane;
    if (!plane) {
      this.refreshPathPick();
      this.syncPathHighlight();
      return;
    }
    this.plane = plane;
    const cursor = parent!.object?.currentPosition;
    this.anchor = cursor ? worldToSketch2D(cursor, plane) : [0, 0];
    // The dialog reads a paused in-sketch statement — hold the camera down
    // the sketch plane like sketch mode would (the suspension freed it).
    this.viewer.holdSketchCamera(plane);
    // Path pick candidates: the paused sketch's geometries whose statements
    // precede the edited one (a statement cannot consume later results).
    this.pathIndex = buildPathTargetIndex(sceneObjects, parent!.id!, plane)
      .filter(e => e.owner.sourceLocation!.line < this.editTarget!.line);
    this.refreshPathPick();
    this.syncPathHighlight();
    void this.seedKeepPath();
  }

  // ---------------------------------------------------------------------
  // Path slot (`text("…", path)`)
  // ---------------------------------------------------------------------

  /** Whether the statement will render with a path argument as things stand. */
  private hasEffectivePath(): boolean {
    return this.pickedPath !== null || (!this.keepRemoved && this.pathText !== null);
  }

  /** The shapeId the glyph preview lays text along, or null (statement-only). */
  private effectivePathShapeId(): string | null {
    if (this.pickedPath) {
      return this.pickedPath.shapeId;
    }
    if (!this.keepRemoved && this.pathText !== null) {
      return this.seededPath?.shapeId ?? null;
    }
    return null;
  }

  /** Tint whichever geometry the statement would follow as things stand. */
  private syncPathHighlight(): void {
    if (this.pickedPath) {
      this.pathHighlight.set(this.pickedPath.shapeIds);
    } else if (!this.keepRemoved && this.pathText !== null && this.seededPath) {
      this.pathHighlight.set(this.seededPath.shapeIds);
    } else {
      this.pathHighlight.clear();
    }
  }

  /**
   * Resolve the statement's own path argument onto the paused sketch's
   * shapes — the keep chip's viewport highlight and the glyph preview's
   * addressable geometry. Re-runs on every settle (shape ids are
   * per-render); a refusal leaves the keep chip standing without either.
   */
  private async seedKeepPath(): Promise<void> {
    const target = this.editTarget;
    if (!target || this.pathText === null || this.keepRemoved) {
      return;
    }
    const result = await fetchSketchFeatureSources(target, this.session.expectedStatement);
    if (this.editTarget !== target || !this.armed || this.keepRemoved) {
      return;
    }
    this.seededPath = result.ok && result.shapeIds.length > 0
      ? { shapeId: result.shapeIds[0], shapeIds: result.shapeIds }
      : null;
    this.syncPathHighlight();
    if (this.seededPath && !this.pickedPath) {
      // The keep path just became addressable — draw its glyph preview.
      this.schedulePreview();
    }
  }

  /** The path field of an edit request; undefined keeps the statement's own. */
  private pathRequest(): TextEditPath | undefined {
    if (this.pickedPath) {
      return { kind: 'picked', shapeId: this.pickedPath.shapeId };
    }
    if (this.keepRemoved && this.pathText !== null) {
      return { kind: 'none' };
    }
    return undefined;
  }

  /** Re-resolve the held pick after a render — shape ids are per-render. */
  private refreshPathPick(): void {
    if (!this.pickedPath) {
      return;
    }
    const entry = this.pathIndex.find(e => e.owner.sourceLocation!.line === this.pickedPath!.line);
    if (entry) {
      this.pickedPath.shapeId = entry.shapeId;
      this.pickedPath.shapeIds = entry.shapeIds;
    } else {
      // The picked statement vanished with a re-render — back to the keep chip.
      this.pickedPath = null;
      this.panel.pathSlot.setChip(null);
      this.panel.setPathMode(this.hasEffectivePath());
    }
  }

  private togglePathArmed(): void {
    if (this.pathArmed) {
      this.disarmPathPick();
      return;
    }
    if (!this.armed) {
      return;
    }
    if (this.plane === null) {
      // Standalone text (no parent sketch): there is no sketch to pick in.
      this.panel.setMessage('Re-picking a path needs the parent sketch on screen.');
      return;
    }
    this.pathArmed = true;
    this.panel.pathSlot.setArmed(true);
    const canvas = this.viewer.sceneContext.renderer.domElement;
    canvas.addEventListener('mousedown', this.boundPathMouseDown);
    canvas.addEventListener('mouseup', this.boundPathMouseUp);
    canvas.addEventListener('mousemove', this.boundPathMouseMove);
  }

  private disarmPathPick(): void {
    if (!this.pathArmed) {
      return;
    }
    this.pathArmed = false;
    this.panel.pathSlot.setArmed(false);
    const canvas = this.viewer.sceneContext.renderer.domElement;
    canvas.removeEventListener('mousedown', this.boundPathMouseDown);
    canvas.removeEventListener('mouseup', this.boundPathMouseUp);
    canvas.removeEventListener('mousemove', this.boundPathMouseMove);
    canvas.style.cursor = '';
  }

  /** The hand cursor while a pickable path is hovered (armed slot only). */
  private handlePathMouseMove(e: MouseEvent): void {
    const ctx = this.viewer.sceneContext;
    const raw = this.plane ? projectToSketch(ctx, this.plane, e.clientX, e.clientY) : null;
    const hit = raw ? hitTestPathTargets(this.pathIndex, raw, pixelToSketchThreshold(ctx, 12)) : null;
    ctx.renderer.domElement.style.cursor = hit ? 'pointer' : '';
  }

  private handlePathMouseUp(e: MouseEvent): void {
    const dx = e.clientX - this.pathDownX;
    const dy = e.clientY - this.pathDownY;
    if (dx * dx + dy * dy > 64 || !this.plane) {
      return;
    }
    const ctx = this.viewer.sceneContext;
    const raw = projectToSketch(ctx, this.plane, e.clientX, e.clientY);
    if (!raw) {
      return;
    }
    const hit = hitTestPathTargets(this.pathIndex, raw, pixelToSketchThreshold(ctx, 12));
    if (!hit) {
      return;
    }
    this.pickedPath = {
      shapeId: hit.shapeId,
      shapeIds: hit.shapeIds,
      line: hit.owner.sourceLocation!.line,
      label: hit.owner.name || 'Curve',
    };
    this.panel.pathSlot.setChip(this.pickedPath.label);
    this.panel.setPathMode(true);
    this.syncPathHighlight();
    this.disarmPathPick();
    this.panel.setMessage(null);
    this.schedulePreview();
  }

  /** The ✕ on the picked chip reverts to the statement's own path; the ✕ on
   * the keep chip drops the path outright — plain anchored text on apply. */
  private handlePathRemove(): void {
    if (this.pickedPath) {
      this.pickedPath = null;
      this.panel.pathSlot.setChip(null);
    } else if (!this.keepRemoved && this.pathText !== null) {
      this.keepRemoved = true;
      this.panel.pathSlot.seedKeep(null);
    }
    this.panel.setPathMode(this.hasEffectivePath());
    this.syncPathHighlight();
    this.panel.setMessage(null);
    this.schedulePreview();
  }

  /** The edit request for the current form state, or the blocking message. */
  private buildRequest(): TextEditOptions | { error: string } {
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    return {
      ...values,
      path: this.pathRequest(),
      expectedStatement: this.session.expectedStatement,
    };
  }

  exit(editEnd: 'apply' | 'cancel' | 'continue' | 'gone' = 'cancel'): void {
    if (!this.armed) {
      return;
    }
    this.armed = false;
    this.session.end(editEnd);
    this.editTarget = null;
    this.disarmPathPick();
    this.pathHighlight.clear();
    this.viewer.releaseSketchCamera();
    this.pathText = null;
    this.keepRemoved = false;
    this.pickedPath = null;
    this.seededPath = null;
    this.pathIndex = [];
    this.panel.pathSlot.reset();
    this.panel.setPathMode(false);
    this.preview.cancel();
    this.panel.hide();
    this.panel.setTitle(null);
    this.clearPreviewMesh();
    this.viewer.sceneContext.scene.remove(this.previewGroup);
    // A render always follows the session end (the cancel path clears the
    // breakpoint, an apply rebuilds) — resume lazily and let it re-enter.
    this.sketchUI.resume(false);
  }

  private schedulePreview(): void {
    if (!this.armed) {
      return;
    }
    this.preview.schedule();
  }

  private async runPreview(signal: AbortSignal, isCurrent: () => boolean): Promise<void> {
    if (!this.armed || this.runner.isApplying || !this.editTarget) {
      return;
    }
    const values = this.panel.values();
    if ('error' in values) {
      this.panel.setPreview(null);
      this.renderPreviewMesh([]);
      return;
    }

    try {
      const result = await applyTextEdit(this.editTarget, {
        ...values,
        path: this.pathRequest(),
        expectedStatement: this.session.expectedStatement,
        preview: true,
        signal,
      });
      if (!isCurrent() || !this.armed) {
        return;
      }
      this.panel.setPreview(result.success ? result.preview ?? null : null);
      if (!result.success && result.reason) {
        // The statement changed shape under the dialog (an undo, a
        // concurrent edit) — surface the refusal before Apply.
        this.panel.setMessage(result.reason);
      }
    } catch {
      return; // aborted
    }

    if (values.text === '') {
      this.renderPreviewMesh([]);
      return;
    }
    const { text, ...options } = values;

    // An effective path lays the glyphs along its geometry; unresolvable
    // paths (a keep whose seed refused, standalone text) keep the statement
    // preview only.
    if (this.hasEffectivePath()) {
      const shapeId = this.effectivePathShapeId();
      if (shapeId === null) {
        this.renderPreviewMesh([]);
        return;
      }
      let geometry: Awaited<ReturnType<typeof getTextPreview>>;
      try {
        geometry = await getTextPreview({ text, path: { shapeId }, options }, signal);
      } catch {
        return; // aborted
      }
      if (!isCurrent() || !this.armed) {
        return;
      }
      this.renderPreviewMesh(geometry?.polylines ?? []);
      return;
    }

    if (!this.plane || this.anchor === null) {
      this.renderPreviewMesh([]);
      return;
    }
    let geometry: Awaited<ReturnType<typeof getTextPreview>>;
    try {
      geometry = await getTextPreview({
        text,
        position: this.anchor,
        plane: {
          origin: this.plane.origin,
          normal: this.plane.normal,
          xDirection: this.plane.xDirection,
        },
        options,
      }, signal);
    } catch {
      return; // aborted
    }
    if (!isCurrent() || !this.armed) {
      return;
    }
    this.renderPreviewMesh(geometry?.polylines ?? []);
  }

  private renderPreviewMesh(polylines: number[][]): void {
    this.clearPreviewMesh();
    const mesh = TextPreviewMesh.build(polylines);
    if (mesh) {
      this.previewGroup.add(mesh);
    }
    this.viewer.sceneContext.requestRender();
  }

  private clearPreviewMesh(): void {
    while (this.previewGroup.children.length > 0) {
      const child = this.previewGroup.children[0] as LineSegments;
      this.previewGroup.remove(child);
      child.geometry?.dispose();
      (child.material as { dispose?: () => void })?.dispose?.();
    }
  }
}
