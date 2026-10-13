import { SketchTool, InsertGeometryFn } from '../sketch-tool';
import { SceneContext } from '../../scene/scene-context';
import { PlaneData, SceneObjectRender, SketchImageData } from '../../types';
import { SnapController } from '../../snapping/snap-controller';
import { ICON_IMAGE } from '../../ui/icons';
import { DimensionInput } from '../../ui/dimension-input';
import { addSketchImage, setSketchImage, type SketchImageEdit, type SetUnitResult, type SourceLocationParam } from '../../api';
import { writeWorkspaceBinaryFile, type BinaryWriteResult } from '../../editor/editor-api';
import { Base64 } from '../../helpers/base64';
import { pixelToSketchThreshold, projectToSketch, sketchToClient } from '../sketch-plane-utils';
import {
  MAX_REFERENCE_IMAGE_BYTES,
  REFERENCE_IMAGE_TYPES,
  ReferenceImageLoader,
  type LoadedImage,
  type PixelSize,
} from '../../scene/reference-image-loader';
import { ReferenceImageController, type ReferenceImageHost } from '../../scene/reference-image-controller';
import { ReferenceImagePanel, type CalibrateState } from './reference-image-panel';
import { ReferenceImageFrame, type FrameHit, type FrameTolerances, type Point2 } from './reference-image-frame';
import { HANDLE_PX, KNOB_PX, ReferenceImageHandles, STEM_PX } from './reference-image-handles';

/** The folder beside the model file that uploaded pictures land in. */
export const REFERENCE_IMAGE_FOLDER = 'images';

/** A press that moves less than this is a click, not a drag. */
const DRAG_THRESHOLD_PX = 3;
/** Shift while rotating snaps to this step. */
const ROTATE_SNAP_DEGREES = 15;
/** A freshly chosen picture opens this wide, as a share of the visible width. */
const INITIAL_WIDTH_SHARE = 0.5;

/** What the pointer is doing to the picture. */
type Drag =
  | { kind: 'move'; grab: Point2 }
  | { kind: 'corner'; corner: Exclude<FrameHit, { part: 'body' } | { part: 'rotate' }>['corner'] }
  | { kind: 'rotate' };

/** A press on the picture that may turn into a drag once the pointer moves. */
type Pending = { hit: FrameHit; point: Point2; clientX: number; clientY: number };

/** A statement location with the file it is in. */
type FileLocation = SourceLocationParam & { filePath: string };

/**
 * What Apply writes: a new `image()` statement in the sketch body, or the
 * re-opened statement rewritten.
 */
export type ReferenceImageCommit =
  | { kind: 'create'; sketch: FileLocation; image: SketchImageEdit }
  | { kind: 'update'; target: FileLocation; image: SketchImageEdit };

/**
 * What the tool needs beyond a drawing tool's basics. The I/O is
 * injectable so the apply flow runs under test without a server.
 */
export type ReferenceImageToolDeps = {
  /** The viewer's reference-image controller: the seed and the live preview. */
  host: ReferenceImageHost;
  /** The sketch being edited — where a new statement goes, and the model file the path is relative to. */
  sketchLocation: FileLocation;
  /** The `image()` statement re-opened from its timeline row, or null to place a new picture. */
  target: FileLocation | null;
  onRequestExit: () => void;
  upload?: (path: string, base64: string) => Promise<BinaryWriteResult>;
  commit?: (commit: ReferenceImageCommit) => Promise<SetUnitResult>;
  decode?: (blob: Blob) => Promise<LoadedImage>;
};

/**
 * The Image tool: the picture is placed by hand in the viewport. Drag it to
 * move it, a corner square to resize it (the opposite corner stays put;
 * Shift stretches), the knob above it to rotate (Shift snaps to 15°).
 * Calibrate takes two clicks on the picture and the real distance between
 * them, and scales the picture to match. The dialog holds what the
 * viewport cannot: the file, the opacity, Apply / Cancel. Every
 * change previews live on the viewer's quad; Apply uploads a newly chosen
 * file beside the model and writes an `image()` statement into the sketch
 * body — or, opened from a picture's timeline row, rewrites that statement.
 */
export class ReferenceImageTool extends SketchTool {
  readonly id = 'image' as const;
  readonly label = 'Image';
  readonly icon = ICON_IMAGE;
  /** The dialog takes the sketch dialog's dock while the tool is up. */
  override readonly docksDialog = true;

  private readonly panel: ReferenceImagePanel;
  private readonly handles: ReferenceImageHandles;
  private readonly distanceInput: DimensionInput;
  private readonly host: ReferenceImageHost;
  private readonly sketchLocation: FileLocation;
  private readonly target: FileLocation | null;
  private readonly onRequestExit: () => void;
  private readonly upload: (path: string, base64: string) => Promise<BinaryWriteResult>;
  private readonly commit: (commit: ReferenceImageCommit) => Promise<SetUnitResult>;
  private readonly decode: (blob: Blob) => Promise<LoadedImage>;

  /** The record as it stands in this session; null until a picture exists. */
  private spec: SketchImageData | null = null;
  /** The picture's pixels — the chosen file's, or the loaded model picture's once known. */
  private pixel: PixelSize | null = null;
  /** A picture chosen in this session, decoded in the page, not yet on disk. */
  private chosen: { file: File; image: LoadedImage } | null = null;
  private pending: Pending | null = null;
  private drag: Drag | null = null;
  private hover: FrameHit | null = null;
  private calibrate: { state: CalibrateState; points: Point2[] } = { state: 'idle', points: [] };
  private busy = false;
  private unsubscribeCamera: (() => void) | null = null;

  private boundPointerDown: (e: PointerEvent) => void;
  private boundPointerMove: (e: PointerEvent) => void;
  private boundPointerUp: (e: PointerEvent) => void;

  constructor(
    ctx: SceneContext,
    plane: PlaneData,
    snapController: SnapController,
    insertGeometry: InsertGeometryFn,
    container: HTMLElement,
    deps: ReferenceImageToolDeps,
  ) {
    super(ctx, plane, snapController, insertGeometry, container);
    this.host = deps.host;
    this.sketchLocation = deps.sketchLocation;
    this.target = deps.target;
    this.onRequestExit = deps.onRequestExit;
    this.upload = deps.upload ?? ((path, data) => writeWorkspaceBinaryFile(path, data, 'unique'));
    this.commit = deps.commit ?? ReferenceImageTool.writeCommit;
    this.decode = deps.decode ?? ReferenceImageLoader.decode;
    this.panel = new ReferenceImagePanel(container);
    this.panel.onOpacity = (opacity) => this.setSpec(this.spec ? { ...this.spec, opacity } : null);
    this.panel.onCalibrate = () => this.toggleCalibrate();
    this.panel.onApply = () => void this.apply();
    this.panel.onExit = () => this.cancel();
    this.panel.onFile = (file) => void this.chooseFile(file);
    this.handles = new ReferenceImageHandles(plane);
    this.distanceInput = new DimensionInput(container);
    this.boundPointerDown = this.handlePointerDown.bind(this);
    this.boundPointerMove = this.handlePointerMove.bind(this);
    this.boundPointerUp = this.handlePointerUp.bind(this);
  }

  // ------------------------------------------------------------ lifecycle

  protected onActivate(): void {
    this.seedFromRecord();
    this.ctx.scene.add(this.handles.group);
    this.canvas.addEventListener('pointerdown', this.boundPointerDown, { capture: true });
    window.addEventListener('pointermove', this.boundPointerMove);
    window.addEventListener('pointerup', this.boundPointerUp, { capture: true });
    // Handles keep their pixel size, but the knob's stem is a sketch length: redo it on zoom.
    this.unsubscribeCamera = this.ctx.subscribeCameraChange(() => this.refreshHandles());
    this.panel.show();
    this.refresh();
  }

  // No `handleEscape` exit: the toolbar's Escape deactivates the tool, and
  // deactivation drops the preview — the same exit Cancel takes. Escape
  // here only folds a gesture in progress.
  protected onDeactivate(): void {
    this.canvas.removeEventListener('pointerdown', this.boundPointerDown, { capture: true });
    window.removeEventListener('pointermove', this.boundPointerMove);
    window.removeEventListener('pointerup', this.boundPointerUp, { capture: true });
    this.unsubscribeCamera?.();
    this.unsubscribeCamera = null;
    this.endDrag();
    this.canvas.style.cursor = '';
    this.distanceInput.hide();
    this.handles.dispose();
    this.host.clearPreview();
    this.dropChosen();
    this.panel.destroy();
    this.ctx.requestRender();
  }

  onSceneUpdate(_sceneObjects: SceneObjectRender[], _sketchId: string): void {
    // A re-opened picture's record, or its bytes, may land after the dialog
    // opened: seed from it, or take its pixels (they size a one-sided
    // record), unless this session already moved past it.
    if (!this.spec) {
      this.seedFromRecord();
      if (this.spec) {
        this.refresh();
      }
      return;
    }
    const current = this.currentRecord();
    if (current?.pixel && !this.chosen && !this.pixel) {
      this.pixel = current.pixel;
      this.panel.setFile(current.spec.src.replace(/^.*\//, ''), current.pixel);
      this.refresh();
    }
  }

  /** Take the re-opened statement's record as the session's starting point, when there is one yet. */
  private seedFromRecord(): void {
    const current = this.currentRecord();
    if (!current) {
      return;
    }
    this.spec = current.spec;
    this.pixel = current.pixel;
    this.panel.setFile(current.spec.src.replace(/^.*\//, ''), current.pixel);
    this.panel.setOpacity(current.spec.opacity);
  }

  override updatePlane(plane: PlaneData): void {
    super.updatePlane(plane);
    this.handles.updatePlane(plane);
    this.refresh();
  }

  /** A gesture in progress folds first; otherwise the toolbar's Escape leaves the tool. */
  handleEscape(): boolean {
    if (this.calibrate.state !== 'idle') {
      this.setCalibrateState('idle');
      return true;
    }
    if (this.drag || this.pending) {
      this.endDrag();
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------- pointer

  private handlePointerDown(e: PointerEvent): void {
    if (e.button !== 0 || !this.spec) {
      return;
    }
    const point = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!point) {
      return;
    }
    if (this.calibrate.state === 'first' || this.calibrate.state === 'second') {
      this.takeCalibrationPoint(this.snapAt(e.clientX, e.clientY) ?? point, e.clientX, e.clientY);
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    if (this.calibrate.state === 'distance') {
      return;
    }
    const hit = this.frame()?.hitTest(point, this.tolerances()) ?? null;
    if (!hit) {
      return;
    }
    this.pending = { hit, point, clientX: e.clientX, clientY: e.clientY };
    this.ctx.cameraControls.enabled = false;
    e.stopPropagation();
    e.preventDefault();
  }

  private handlePointerMove(e: PointerEvent): void {
    if (this.pending && !this.drag) {
      const dx = e.clientX - this.pending.clientX;
      const dy = e.clientY - this.pending.clientY;
      if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
        return;
      }
      this.startDrag(this.pending);
      this.pending = null;
    }
    const point = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!point) {
      return;
    }
    if (this.drag) {
      this.applyDrag(point, e.shiftKey);
      return;
    }
    if (this.calibrate.state === 'second') {
      // Rubber-band the second leg so the distance being taken is visible.
      this.handles.rebuild(this.frame(), this.stem(), [this.calibrate.points[0], this.snapAt(e.clientX, e.clientY) ?? point]);
      this.ctx.requestRender();
      return;
    }
    if (this.calibrate.state !== 'idle') {
      return;
    }
    this.setHover(this.frame()?.hitTest(point, this.tolerances()) ?? null);
  }

  private handlePointerUp(e: PointerEvent): void {
    if (e.button !== 0) {
      return;
    }
    if (this.drag) {
      e.stopPropagation();
      e.preventDefault();
    }
    this.endDrag();
    // The picture moved under a still pointer: re-read what is under it now.
    const point = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (point && this.calibrate.state === 'idle') {
      this.setHover(this.frame()?.hitTest(point, this.tolerances()) ?? null);
    }
  }

  private setHover(hit: FrameHit | null): void {
    if (ReferenceImageTool.sameHit(hit, this.hover)) {
      return;
    }
    this.hover = hit;
    this.handles.setHover(hit);
    this.canvas.style.cursor = ReferenceImageFrame.cursorFor(hit, this.spec?.angle ?? 0);
    this.ctx.requestRender();
  }

  private startDrag(pending: Pending): void {
    switch (pending.hit.part) {
      case 'body':
        this.drag = { kind: 'move', grab: pending.point };
        this.canvas.style.cursor = 'move';
        break;
      case 'corner':
        this.drag = { kind: 'corner', corner: pending.hit.corner };
        break;
      case 'rotate':
        this.drag = { kind: 'rotate' };
        this.canvas.style.cursor = 'grabbing';
        break;
    }
  }

  private applyDrag(point: Point2, shift: boolean): void {
    const frame = this.frame();
    if (!frame || !this.drag) {
      return;
    }
    switch (this.drag.kind) {
      case 'move': {
        const next = frame.move(this.drag.grab, point);
        this.drag = { kind: 'move', grab: point };
        this.setSpec(next);
        break;
      }
      case 'corner':
        this.setSpec(frame.resizeFromCorner(this.drag.corner, point, !shift));
        break;
      case 'rotate':
        this.setSpec(frame.rotateTo(point, shift ? ROTATE_SNAP_DEGREES : null));
        break;
    }
  }

  private endDrag(): void {
    if (this.drag || this.pending) {
      this.ctx.cameraControls.enabled = true;
    }
    this.drag = null;
    this.pending = null;
    this.canvas.style.cursor = ReferenceImageFrame.cursorFor(this.hover, this.spec?.angle ?? 0);
  }

  // ------------------------------------------------------------ calibrate

  private toggleCalibrate(): void {
    this.setCalibrateState(this.calibrate.state === 'idle' ? 'first' : 'idle');
  }

  private setCalibrateState(state: CalibrateState): void {
    if (state === 'idle') {
      this.calibrate = { state, points: [] };
      this.distanceInput.hide();
      this.canvas.style.cursor = '';
    } else {
      this.calibrate.state = state;
      this.canvas.style.cursor = 'crosshair';
    }
    this.panel.setCalibrateState(state);
    this.refreshHandles();
  }

  private takeCalibrationPoint(point: Point2, clientX: number, clientY: number): void {
    const points = [...this.calibrate.points, point];
    this.calibrate.points = points;
    if (points.length < 2) {
      this.setCalibrateState('second');
      return;
    }
    const measured = ReferenceImageFrame.distance(points[0], points[1]);
    if (measured <= 0) {
      this.calibrate.points = [points[0]];
      return;
    }
    this.setCalibrateState('distance');
    const mid: Point2 = [(points[0][0] + points[1][0]) / 2, (points[0][1] + points[1][1]) / 2];
    const at = this.midpointClient(mid, clientX, clientY);
    this.distanceInput.show('Distance', measured, at.clientX, at.clientY, (actual) => this.finishCalibration(measured, actual));
  }

  private finishCalibration(measured: number, actual: number): void {
    const frame = this.frame();
    if (frame) {
      this.setSpec(frame.calibrate(measured, actual));
    }
    this.setCalibrateState('idle');
  }

  /** Where the distance field goes: over the measured line's midpoint. */
  private midpointClient(mid: Point2, fallbackX: number, fallbackY: number): { clientX: number; clientY: number } {
    try {
      return sketchToClient(this.ctx, this.plane, mid);
    } catch {
      return { clientX: fallbackX, clientY: fallbackY };
    }
  }

  // -------------------------------------------------------------- picture

  private async chooseFile(file: File): Promise<void> {
    this.panel.setMessage(null);
    if (file.type && !(REFERENCE_IMAGE_TYPES as readonly string[]).includes(file.type)) {
      this.panel.setMessage('Choose a PNG, JPEG, WebP, GIF or BMP image.');
      return;
    }
    if (file.size > MAX_REFERENCE_IMAGE_BYTES) {
      this.panel.setMessage(`The image is ${(file.size / (1024 * 1024)).toFixed(1)} MB; the limit is ${MAX_REFERENCE_IMAGE_BYTES / (1024 * 1024)} MB.`);
      return;
    }
    let image: LoadedImage;
    try {
      image = await this.decode(file);
    } catch (error) {
      this.panel.setMessage(error instanceof Error ? error.message : String(error));
      return;
    }
    this.dropChosen();
    this.chosen = { file, image };
    this.pixel = { width: image.width, height: image.height };
    this.panel.setFile(file.name, this.pixel);
    this.setCalibrateState('idle');
    this.setSpec(this.spec ? { ...this.spec, src: '' } : this.initialSpec());
  }

  /** A new picture opens centred on the view, half the visible width across. */
  private initialSpec(): SketchImageData {
    const rect = this.canvas.getBoundingClientRect();
    const center = projectToSketch(this.ctx, this.plane, rect.left + rect.width / 2, rect.top + rect.height / 2) ?? [0, 0];
    const visibleWidth = pixelToSketchThreshold(this.ctx, rect.width || 1);
    const width = Math.max(ReferenceImageTool.round(visibleWidth * INITIAL_WIDTH_SHARE), 1e-3);
    return {
      src: '',
      width,
      at: [ReferenceImageTool.round(center[0]), ReferenceImageTool.round(center[1])],
      angle: 0,
      opacity: this.panel.opacity,
    };
  }

  private dropChosen(): void {
    this.chosen?.image.close();
    this.chosen = null;
  }

  // -------------------------------------------------------------- refresh

  private frame(): ReferenceImageFrame | null {
    return this.spec ? new ReferenceImageFrame(this.spec, this.pixel) : null;
  }

  /** Handle reaches in sketch units for the current zoom. */
  private tolerances(): FrameTolerances {
    return {
      corner: pixelToSketchThreshold(this.ctx, HANDLE_PX),
      rotate: pixelToSketchThreshold(this.ctx, KNOB_PX),
      stem: this.stem(),
    };
  }

  private stem(): number {
    return pixelToSketchThreshold(this.ctx, STEM_PX);
  }

  /** The re-opened statement's record as the last render carried it; null for a new picture. */
  private currentRecord() {
    return this.target ? this.host.current(ReferenceImageController.keyOf(this.target)) : null;
  }

  private setSpec(spec: SketchImageData | null): void {
    this.spec = spec;
    this.refresh();
  }

  /** Preview, handles and read-out from the record as it stands. */
  private refresh(): void {
    if (this.spec) {
      this.host.preview({
        key: this.target ? ReferenceImageController.keyOf(this.target) : null,
        plane: this.plane,
        spec: this.spec,
        modelFile: this.sketchLocation.filePath,
        image: this.chosen?.image ?? null,
      });
      const frame = this.frame()!;
      this.panel.setReadout({ width: frame.width, height: frame.height }, this.spec.at, this.spec.angle);
    } else {
      this.host.clearPreview();
    }
    this.refreshHandles();
  }

  private refreshHandles(): void {
    this.handles.rebuild(this.frame(), this.stem(), this.calibrate.points);
    this.ctx.requestRender();
  }

  // --------------------------------------------------------------- commit

  private async apply(): Promise<void> {
    if (this.busy || !this.spec) {
      return;
    }
    this.setBusy(true);
    try {
      let src = this.spec.src;
      if (this.chosen) {
        const uploaded = await this.upload(this.uploadPath(this.chosen.file.name), await Base64.fromBlob(this.chosen.file));
        src = ReferenceImageTool.relativeSrc(this.sketchLocation.filePath, uploaded.absPath);
      }
      if (!src) {
        this.panel.setMessage('Choose an image first.');
        return;
      }
      const image = ReferenceImageTool.editOf({ ...this.spec, src });
      const result = await this.commit(this.target
        ? { kind: 'update', target: this.target, image }
        : { kind: 'create', sketch: this.sketchLocation, image });
      if (!result.success) {
        this.panel.setMessage(result.reason ?? 'The image could not be written to the sketch.');
        return;
      }
      // The re-render carries the record; the host shows it from the model.
      this.host.clearPreview();
      this.onRequestExit();
    } catch (error) {
      this.panel.setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      this.setBusy(false);
    }
  }

  private cancel(): void {
    this.host.clearPreview();
    this.onRequestExit();
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.panel.setBusy(busy);
  }

  /** Where a chosen file goes: `images/<name>` beside the model, the name made path-safe. */
  private uploadPath(fileName: string): string {
    const folder = ReferenceImageTool.folderOf(this.sketchLocation.filePath);
    return `${folder}/${REFERENCE_IMAGE_FOLDER}/${ReferenceImageTool.safeName(fileName)}`;
  }

  // ------------------------------------------------------------- statics

  /** The server round trip behind a commit: a create into the sketch body, or the statement's update. */
  static writeCommit(commit: ReferenceImageCommit): Promise<SetUnitResult> {
    return commit.kind === 'create'
      ? addSketchImage(commit.sketch, commit.image)
      : setSketchImage(commit.target, commit.image);
  }

  /** The statement's record: the session's fields with the written path, rounded to what the writer keeps. */
  static editOf(values: SketchImageData): SketchImageEdit {
    const r = ReferenceImageTool.round;
    return {
      src: values.src,
      ...(values.width !== undefined ? { width: r(values.width) } : {}),
      ...(values.height !== undefined ? { height: r(values.height) } : {}),
      at: [r(values.at[0]), r(values.at[1])],
      angle: r(values.angle),
      opacity: r(values.opacity),
    };
  }

  private static round(value: number): number {
    return Math.round(value * 1000) / 1000;
  }

  private static sameHit(a: FrameHit | null, b: FrameHit | null): boolean {
    if (a === b) {
      return true;
    }
    if (!a || !b || a.part !== b.part) {
      return false;
    }
    return a.part !== 'corner' || b.part !== 'corner' || a.corner === b.corner;
  }

  /** A file name with only letters, digits, dots, dashes and underscores. */
  static safeName(fileName: string): string {
    const base = fileName.replace(/\\/g, '/').replace(/^.*\//, '');
    const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '');
    return cleaned || 'image';
  }

  /** The folder of a model file path, forward slashes. */
  static folderOf(modelFile: string): string {
    return modelFile.replace(/\\/g, '/').replace(/\/[^/]*$/, '');
  }

  /**
   * The `src` to write for a picture the server put at `absPath`: relative
   * to the model file's folder when it sits beneath it (the normal case),
   * the absolute path otherwise.
   */
  static relativeSrc(modelFile: string, absPath: string): string {
    const folder = ReferenceImageTool.folderOf(modelFile);
    const posix = absPath.replace(/\\/g, '/');
    return posix.startsWith(`${folder}/`) ? posix.slice(folder.length + 1) : posix;
  }
}

