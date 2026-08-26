import { Group, Vector3 } from 'three';
import { SketchTool, InsertGeometryFn, PickedPoint } from '../sketch-tool';
import { SceneContext } from '../../scene/scene-context';
import { PlaneData, SceneObjectRender } from '../../types';
import { SnapController } from '../../snapping/snap-controller';
import { SnapManager } from '../../snapping/snap-manager';
import { SnapType } from '../../snapping/types';
import { pixelToSketchThreshold, projectToSketch } from '../sketch-plane-utils';
import { buildPathTargetIndex, hitTestPathTargets, PathTargetEntry } from '../sketch-edge-utils';
import { ICON_TEXT } from '../../ui/icons';
import { applyTextToPath, getTextPreview, TextOptionValues } from '../../api';
import { PathHighlight } from './path-highlight';
import { TextPanel } from './text-panel';
import { TextPreviewMesh } from './text-preview-mesh';
import { START_POINT_COLOR, addDot, snapDotColor } from './tool-preview-utils';

const PREVIEW_DEBOUNCE_MS = 200;

/**
 * The Text tool: opens the options dialog (string, font, size, weight,
 * italic, align, spacing) and shows the laid-out glyph outlines in the
 * viewport — re-fetched from the server on every option edit, so the
 * preview is the exact geometry `text()` will build. A viewport click
 * moves the preview anchor (snapped); Apply inserts the `text(…)`
 * statement and the scene re-render replaces the preview with the real
 * feature.
 *
 * The dialog's Path slot picks the `text("…", path)` overload instead:
 * arming it turns viewport clicks into whole-geometry picks (text lays its
 * glyphs along ALL edges of the picked curve), the anchor and its outline
 * preview stand down (the path owns placement; the layout needs the path's
 * geometry), and Apply goes through `/api/apply-feature` — the server binds
 * the picked statement to a variable and writes `text("Hi", c)`.
 */
export class TextTool extends SketchTool {
  readonly id = 'text' as const;
  readonly label = 'Text';
  readonly icon = ICON_TEXT;

  private panel: TextPanel;
  private onRequestExit: () => void;
  private anchor: [number, number];

  /** The picked path geometry (`text("…", path)`), or null for anchored text.
   * The shape ids are re-resolved by owner line on every scene update —
   * shape ids are per-render. */
  private path: { shapeId: string; shapeIds: string[]; line: number; label: string } | null = null;
  /** True while the Path slot awaits a viewport pick. */
  private pathArmed = false;
  /** Whole-geometry pick candidates of the current sketch scene. */
  private pathIndex: PathTargetEntry[] = [];
  /** The picked geometry's selection tint in the viewport. */
  private pathHighlight: PathHighlight;

  private previewTimer: number | null = null;
  private previewAbort: AbortController | null = null;
  private previewSeq = 0;

  private mousePoint: [number, number] | null = null;
  private lastSnapType: SnapType = 'none';
  /** The hover snap dot, kept out of `previewGroup` so mouse moves don't
   * force a rebuild of the server-fetched glyph outline mesh. */
  private snapDotGroup: Group;

  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;
  private downX = 0;
  private downY = 0;

  /** Compact numeric literal for emitted statements (no float noise). */
  private static fmt(value: number): string {
    return String(Math.round(value * 1000) / 1000);
  }

  private static quoteSingle(value: string): string {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }

  constructor(
    ctx: SceneContext,
    plane: PlaneData,
    snapController: SnapController,
    insertGeometry: InsertGeometryFn,
    container: HTMLElement,
    onRequestExit: () => void,
  ) {
    super(ctx, plane, snapController, insertGeometry, container);
    this.onRequestExit = onRequestExit;
    this.anchor = [0, 0];
    this.panel = new TextPanel(container);
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.syncStatementPreview();
      this.schedulePreview();
    };
    this.panel.onApply = () => void this.commit();
    this.panel.onExit = () => this.onRequestExit();
    this.panel.pathSlot.onArm = () => this.togglePathArmed();
    this.panel.pathSlot.onRemove = () => this.clearPath();
    this.pathHighlight = new PathHighlight(ctx);
    this.snapDotGroup = new Group();
    this.snapDotGroup.userData.isMetaShape = true;
    this.snapDotGroup.renderOrder = 3;
    this.boundMouseDown = this.handleMouseDown.bind(this);
    this.boundMouseUp = this.handleMouseUp.bind(this);
    this.boundMouseMove = this.handleMouseMove.bind(this);
  }

  protected onActivate(): void {
    this.addPreviewToScene();
    this.ctx.scene.add(this.snapDotGroup);
    this.canvas.addEventListener('mousedown', this.boundMouseDown);
    this.canvas.addEventListener('mouseup', this.boundMouseUp);
    this.canvas.addEventListener('mousemove', this.boundMouseMove);
    this.panel.show();
    void TextPanel.loadFontFamilies().then((families) => this.panel.setFonts(families));
    this.syncStatementPreview();
    this.schedulePreview();
  }

  protected onDeactivate(): void {
    this.canvas.removeEventListener('mousedown', this.boundMouseDown);
    this.canvas.removeEventListener('mouseup', this.boundMouseUp);
    this.canvas.removeEventListener('mousemove', this.boundMouseMove);
    this.pathHighlight.clear();
    this.setPickCursor(false);
    this.clearSnapDot();
    this.ctx.scene.remove(this.snapDotGroup);
    this.cancelPreview();
    this.panel.destroy();
    this.removePreviewFromScene();
  }

  onSceneUpdate(sceneObjects: SceneObjectRender[], sketchId: string): void {
    const snapManager = SnapManager.fromSceneObjects(sceneObjects, sketchId, this.plane, this.ctx);
    this.updateSnapManager(snapManager);
    this.pathIndex = buildPathTargetIndex(sceneObjects, sketchId, this.plane);
    if (this.path) {
      // Shape ids are per-render — re-resolve the held pick by its owner's
      // source line, and drop it when the statement is gone. The render also
      // replaced the line meshes, so the highlight re-applies either way.
      const entry = this.pathIndex.find(e => e.owner.sourceLocation!.line === this.path!.line);
      if (entry) {
        this.path.shapeId = entry.shapeId;
        this.path.shapeIds = entry.shapeIds;
        this.pathHighlight.set(entry.shapeIds);
      } else {
        this.clearPath();
      }
    }
  }

  override updatePlane(plane: PlaneData): void {
    super.updatePlane(plane);
    this.schedulePreview();
  }

  private handleMouseDown(e: MouseEvent): void {
    this.downX = e.clientX;
    this.downY = e.clientY;
  }

  private handleMouseMove(e: MouseEvent): void {
    const raw = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!raw) {
      this.mousePoint = null;
      this.lastSnapType = 'none';
      this.setPickCursor(false);
      this.renderSnapDot();
      return;
    }
    // An armed Path slot: the hand cursor marks a pickable curve under the
    // mouse — the click affordance the snap dot is not.
    if (this.pathArmed) {
      const hit = hitTestPathTargets(this.pathIndex, raw, pixelToSketchThreshold(this.ctx, 12));
      this.setPickCursor(hit !== null);
      return;
    }
    this.setPickCursor(false);
    const result = this.snapController.snap(raw);
    this.mousePoint = result.point2d;
    this.lastSnapType = result.snapType;
    this.renderSnapDot();
  }

  /** The hand cursor while a pickable path is hovered (armed slot only). */
  private setPickCursor(active: boolean): void {
    this.canvas.style.cursor = active ? 'pointer' : '';
  }

  private clearSnapDot(): void {
    while (this.snapDotGroup.children.length > 0) {
      const child = this.snapDotGroup.children[0];
      this.snapDotGroup.remove(child);
      const obj = child as any;
      obj.geometry?.dispose();
      obj.material?.dispose();
    }
  }

  /** The dot marking where a click would land while a snap is active. The
   * anchor has no meaning while a path is armed or picked, so no dot then. */
  private renderSnapDot(): void {
    this.clearSnapDot();
    if (this.mousePoint && this.lastSnapType !== 'none' && !this.pathArmed && !this.path) {
      const planeNormal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);
      addDot(
        this.snapDotGroup, this.mousePoint, snapDotColor(this.lastSnapType),
        this.ctx.camera, planeNormal, this.plane, 0.6,
      );
    }
    this.requestRender();
  }

  private handleMouseUp(e: MouseEvent): void {
    const dx = e.clientX - this.downX;
    const dy = e.clientY - this.downY;
    if (dx * dx + dy * dy > 64) {
      return;
    }
    const raw = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!raw) {
      return;
    }
    // An armed Path slot owns the click: a hit picks the whole geometry, a
    // miss keeps the slot armed (and moves no anchor).
    if (this.pathArmed) {
      const hit = hitTestPathTargets(this.pathIndex, raw, pixelToSketchThreshold(this.ctx, 12));
      if (hit) {
        this.setPath(hit);
      }
      return;
    }
    // With a path picked, the path owns placement — clicks move no anchor.
    if (this.path) {
      return;
    }
    const result = this.snapController.snap(raw);
    this.setAnchor(this.applyPointInput(result.point2d));
    this.syncStatementPreview();
    this.schedulePreview();
  }

  // ---------------------------------------------------------------------
  // Path pick (`text("…", path)`)
  // ---------------------------------------------------------------------

  private togglePathArmed(): void {
    this.pathArmed = !this.pathArmed;
    this.panel.pathSlot.setArmed(this.pathArmed);
    if (!this.pathArmed) {
      this.setPickCursor(false);
    }
    this.renderSnapDot();
  }

  private setPath(entry: PathTargetEntry): void {
    this.path = {
      shapeId: entry.shapeId,
      shapeIds: entry.shapeIds,
      line: entry.owner.sourceLocation!.line,
      label: entry.owner.name || 'Curve',
    };
    this.pathArmed = false;
    this.panel.pathSlot.setArmed(false);
    this.panel.pathSlot.setChip(this.path.label);
    this.panel.setPathMode(true);
    this.pathHighlight.set(entry.shapeIds);
    this.setPickCursor(false);
    this.panel.setMessage(null);
    this.syncStatementPreview();
    this.schedulePreview();
  }

  private clearPath(): void {
    if (!this.path) {
      return;
    }
    this.path = null;
    this.pathHighlight.clear();
    this.panel.pathSlot.setChip(null);
    this.panel.setPathMode(false);
    this.panel.setMessage(null);
    this.syncStatementPreview();
    this.schedulePreview();
  }

  // ---------------------------------------------------------------------
  // Statement
  // ---------------------------------------------------------------------

  private buildStatement(values: TextOptionValues): string {
    let statement = `text(${JSON.stringify(values.text)})`;
    if (values.font) {
      statement += `.font(${TextTool.quoteSingle(values.font)})`;
    }
    if (values.size !== 10) {
      statement += `.size(${TextTool.fmt(values.size)})`;
    }
    if (values.weight === 700) {
      statement += '.bold()';
    } else if (values.weight !== 400) {
      statement += `.weight(${values.weight})`;
    }
    if (values.italic) {
      statement += '.italic()';
    }
    if (values.align !== 'left') {
      statement += `.align('${values.align}')`;
    }
    if (values.lineSpacing !== 1) {
      statement += `.lineSpacing(${TextTool.fmt(values.lineSpacing)})`;
    }
    if (values.letterSpacing !== 0) {
      statement += `.letterSpacing(${TextTool.fmt(values.letterSpacing)})`;
    }
    return statement;
  }

  /** The anchor is re-placeable for as long as the tool is armed — unless a
   * path is picked, which owns placement. Numbers only: the text panel owns
   * the tool's dialog, so there is no in-scope variable list to autocomplete
   * against. */
  protected override awaitingPoint(): boolean {
    return this.path === null;
  }

  protected override pointInputNumericOnly(): boolean {
    return true;
  }

  protected override onTypedPoint(point: PickedPoint): void {
    if (this.path) {
      return;
    }
    this.setAnchor(point);
    this.syncStatementPreview();
    this.schedulePreview();
  }

  private setAnchor(picked: PickedPoint): void {
    this.anchor = picked.value;
  }

  /** The pen died with the sketch-solver rewrite (P7): text renders at the
   * plane origin, so the statement carries no `move(…)` prefix. The anchor
   * still positions the viewport preview. */
  private fullStatement(values: TextOptionValues): string {
    return this.buildStatement(values);
  }

  private syncStatementPreview(): void {
    const values = this.panel.values();
    if ('error' in values || values.text.trim() === '') {
      this.panel.setPreview(null);
      return;
    }
    if (this.path) {
      // The path variable is the server's to name — the debounced preview
      // round-trip fills the statement in.
      return;
    }
    this.panel.setPreview(this.fullStatement(values));
  }

  private async commit(): Promise<void> {
    const values = this.panel.values();
    if ('error' in values) {
      this.panel.setMessage(values.error);
      return;
    }
    if (values.text.trim() === '') {
      this.panel.setMessage('Enter the text to render.');
      return;
    }
    if (this.path) {
      // The server binds the picked statement to a variable and writes
      // `text("…", c)` into the sketch body; the re-render is the result.
      const result = await applyTextToPath(this.path.shapeId, values);
      if (!result.success) {
        this.panel.setMessage(result.reason ?? 'Could not apply the text.');
        return;
      }
      this.onRequestExit();
      return;
    }
    this.insertGeometry(this.fullStatement(values));
    // The editor round-trip re-renders the scene with the real feature;
    // the tool's job is done.
    this.onRequestExit();
  }

  // ---------------------------------------------------------------------
  // Viewport preview: debounced server layout → outline polylines
  // ---------------------------------------------------------------------

  private schedulePreview(): void {
    if (this.previewTimer !== null) {
      window.clearTimeout(this.previewTimer);
    }
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = null;
      void this.runPreview();
    }, PREVIEW_DEBOUNCE_MS);
  }

  private async runPreview(): Promise<void> {
    const values = this.panel.values();
    if ('error' in values || values.text === '') {
      this.renderPreview([]);
      return;
    }
    const seq = ++this.previewSeq;
    this.previewAbort?.abort();
    const abort = new AbortController();
    this.previewAbort = abort;

    if (this.path) {
      // Path mode: the statement preview comes from the server (it names the
      // path variable the transform will bind), then the glyph outlines laid
      // along the picked geometry — both under the same cancellation scope.
      let result: Awaited<ReturnType<typeof applyTextToPath>>;
      try {
        result = await applyTextToPath(this.path.shapeId, values, { preview: true, signal: abort.signal });
      } catch {
        return; // aborted
      }
      if (seq !== this.previewSeq) {
        return;
      }
      this.panel.setPreview(result.success ? result.preview ?? null : null);
      if (!result.success && result.reason) {
        this.panel.setMessage(result.reason);
      }
      const { text, ...options } = values;
      const outline = await getTextPreview(
        { text, path: { shapeId: this.path.shapeId }, options },
        abort.signal,
      );
      if (seq !== this.previewSeq) {
        return;
      }
      this.renderPreview(outline?.polylines ?? []);
      return;
    }

    const { text, ...options } = values;
    const result = await getTextPreview({
      text,
      position: this.anchor,
      plane: {
        origin: this.plane.origin,
        normal: this.plane.normal,
        xDirection: this.plane.xDirection,
      },
      options,
    }, abort.signal);

    if (seq !== this.previewSeq) {
      return;
    }
    this.renderPreview(result?.polylines ?? []);
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

  private renderPreview(polylines: number[][]): void {
    this.disposePreview();

    const mesh = TextPreviewMesh.build(polylines);
    if (mesh) {
      this.previewGroup.add(mesh);
    }

    // The anchor dot only means something for anchored text.
    if (!this.path) {
      const planeNormal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);
      addDot(this.previewGroup, this.anchor, START_POINT_COLOR, this.ctx.camera, planeNormal, this.plane);
    }

    this.requestRender();
  }
}
