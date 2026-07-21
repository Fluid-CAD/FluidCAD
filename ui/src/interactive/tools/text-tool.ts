import { Vector3 } from 'three';
import { SketchTool, InsertGeometryFn } from '../sketch-tool';
import { SceneContext } from '../../scene/scene-context';
import { PlaneData, SceneObjectRender } from '../../types';
import { SnapController } from '../../snapping/snap-controller';
import { SnapManager } from '../../snapping/snap-manager';
import { projectToSketch, roundPoint } from '../sketch-plane-utils';
import { ICON_TEXT } from '../../ui/icons';
import { getTextPreview, TextOptionValues } from '../../api';
import { TextPanel } from './text-panel';
import { TextPreviewMesh } from './text-preview-mesh';
import { START_POINT_COLOR, addDot } from './tool-preview-utils';

const PREVIEW_DEBOUNCE_MS = 200;

/**
 * The Text tool: opens the options dialog (string, font, size, weight,
 * italic, align, spacing) and shows the laid-out glyph outlines in the
 * viewport — re-fetched from the server on every option edit, so the
 * preview is the exact geometry `text()` will build. A viewport click
 * moves the anchor (snapped); Apply inserts the `text(…)` statement —
 * prefixed with `move(…)` when the anchor left the sketch cursor — and
 * the scene re-render replaces the preview with the real feature.
 */
export class TextTool extends SketchTool {
  readonly id = 'text' as const;
  readonly label = 'Text';
  readonly icon = ICON_TEXT;

  private panel: TextPanel;
  private onRequestExit: () => void;
  private anchor: [number, number];
  /** True once the user clicked an anchor; stops cursor-following. */
  private placed = false;

  private previewTimer: number | null = null;
  private previewAbort: AbortController | null = null;
  private previewSeq = 0;

  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;
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
    super(ctx, plane, snapController, insertGeometry);
    this.onRequestExit = onRequestExit;
    this.anchor = this.currentPosition ?? [0, 0];
    this.panel = new TextPanel(container);
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.syncStatementPreview();
      this.schedulePreview();
    };
    this.panel.onApply = () => this.commit();
    this.panel.onExit = () => this.onRequestExit();
    this.boundMouseDown = this.handleMouseDown.bind(this);
    this.boundMouseUp = this.handleMouseUp.bind(this);
  }

  activate(): void {
    this.addPreviewToScene();
    this.canvas.addEventListener('mousedown', this.boundMouseDown);
    this.canvas.addEventListener('mouseup', this.boundMouseUp);
    this.anchor = this.currentPosition ?? [0, 0];
    this.panel.show();
    void TextPanel.loadFontFamilies().then((families) => this.panel.setFonts(families));
    this.syncStatementPreview();
    this.schedulePreview();
  }

  deactivate(): void {
    this.canvas.removeEventListener('mousedown', this.boundMouseDown);
    this.canvas.removeEventListener('mouseup', this.boundMouseUp);
    this.cancelPreview();
    this.panel.destroy();
    this.removePreviewFromScene();
  }

  onSceneUpdate(sceneObjects: SceneObjectRender[], sketchId: string): void {
    const snapManager = SnapManager.fromSceneObjects(sceneObjects, sketchId, this.plane, this.ctx);
    this.updateSnapManager(snapManager);
  }

  override updatePlane(plane: PlaneData): void {
    super.updatePlane(plane);
    this.schedulePreview();
  }

  override updateCurrentPosition(worldPos: Parameters<SketchTool['updateCurrentPosition']>[0]): void {
    const hadCursor = this.currentPosition !== null;
    super.updateCurrentPosition(worldPos);
    // The anchor starts on the sketch cursor; follow it until the user
    // explicitly places the text with a click.
    if (!hadCursor && this.currentPosition && !this.placed) {
      this.anchor = this.currentPosition;
      this.schedulePreview();
    }
  }

  private handleMouseDown(e: MouseEvent): void {
    this.downX = e.clientX;
    this.downY = e.clientY;
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
    const result = this.snapController.snap(raw);
    this.anchor = roundPoint(result.point2d);
    this.placed = true;
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

  /** `move(…)` first when the anchor is away from the sketch cursor. */
  private needsMove(): boolean {
    if (this.currentPosition) {
      return !this.isAtCurrentPosition(this.anchor);
    }
    return this.anchor[0] !== 0 || this.anchor[1] !== 0;
  }

  private fullStatement(values: TextOptionValues): string {
    const statement = this.buildStatement(values);
    return this.needsMove()
      ? `move(${this.formatPoint(this.anchor)});\n${statement}`
      : statement;
  }

  private syncStatementPreview(): void {
    const values = this.panel.values();
    if ('error' in values || values.text.trim() === '') {
      this.panel.setPreview(null);
      return;
    }
    this.panel.setPreview(this.fullStatement(values));
  }

  private commit(): void {
    const values = this.panel.values();
    if ('error' in values) {
      this.panel.setMessage(values.error);
      return;
    }
    if (values.text.trim() === '') {
      this.panel.setMessage('Enter the text to render.');
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

    const planeNormal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);
    addDot(this.previewGroup, this.anchor, START_POINT_COLOR, this.ctx.camera, planeNormal, this.plane);

    this.requestRender();
  }
}
