import { Box3 } from 'three';
import { SketchTool, InsertGeometryFn, type ToolId } from '../sketch-tool';
import { SceneContext } from '../../scene/scene-context';
import { PlaneData, SceneObjectRender } from '../../types';
import { SnapController } from '../../snapping/snap-controller';
import { ICON_FILE_IMPORT } from '../../ui/icons';
import { sceneUnit } from '../../units/scene-unit';
import { MM_PER_UNIT, UNIT_DISPLAY_DECIMALS, type LengthUnit } from '../../units/units';
import { localToWorld, pixelToSketchThreshold, projectToSketch } from '../sketch-plane-utils';
import type { Curve2D, DrawingBounds, Vec2 } from '../../../../lib/io/drawing/drawing.js';
import { Affine } from '../../../../lib/io/drawing/affine.js';
import { DxfReader } from '../../../../lib/io/drawing/dxf-reader.js';
import { SvgReader } from '../../../../lib/io/drawing/svg-reader.js';
import { ImportedDrawings, type ImportedConstructionLine, type ImportedDrawing } from '../../../../lib/io/drawing/import.js';
import { SketchImport, type SketchImportPlan } from '../../../../lib/io/drawing/sketch-import.js';
import { ConstructionLines, type CutLine } from '../../../../lib/io/drawing/construction-lines.js';
import { DrawingImportPanel, type DrawingImportFormat, type DrawingUnitChoice } from './drawing-import-panel';
import { DrawingImportPreview } from './drawing-import-preview';
import { DrawingImportEmission } from './drawing-import-emission';
import { DrawingPlacements, type DrawingPlacement } from './drawing-import-placement';
import { ReferenceImageFrame, type FrameHit, type FrameTolerances, type Point2 } from './reference-image-frame';
import { HANDLE_PX, KNOB_PX, ReferenceImageHandles, STEM_PX } from './reference-image-handles';
import type { SolvedEmissionRequest, SolvedEmitResult } from './solved-emission';

/** A press that moves less than this is a click, not a drag. */
const DRAG_THRESHOLD_PX = 3;
/** Shift while rotating snaps to this step. */
const ROTATE_SNAP_DEGREES = 15;

/** A drawing farther from its file's origin than this many times its own size is not placed by its coordinates. */
const FAR_FROM_ORIGIN = 10;

/** How far an approximating bezier may be from its curve, and what has no length: a tenth of a micron. */
const TOLERANCE_MM = 1e-4;
/** Ends this close are one meeting point: a micron, wider than what any writer's rounding leaves between them. */
const JOIN_TOLERANCE_MM = 1e-3;
/** Decimals past the ones a length is shown with that an imported coordinate is written with. */
const EXTRA_DECIMALS = 4;

/**
 * The most statements one import writes. Each curve becomes a statement and
 * a row of the sketch; past this a sketch stops being something to edit, and
 * the drawing is better cut down by layer first.
 */
export const MAX_IMPORT_STATEMENTS = 2000;

/** A kind of file the tool imports: its dialog texts and how its text is read. */
export type DrawingImportSource = DrawingImportFormat & {
  id: ToolId;
  label: string;
  /** The largest file read, in bytes. */
  maxBytes: number;
  /** The file's bytes as curves; throws with a sentence for the user when it is not that kind of file. */
  read: (bytes: Uint8Array) => ImportedDrawing;
};

export const DXF_IMPORT: DrawingImportSource = {
  id: 'dxf',
  label: 'Import DXF',
  title: 'Import DXF',
  chooseLabel: 'Choose DXF…',
  accept: '.dxf',
  icon: 'dxf',
  hiddenLayer: 'off or frozen in the file',
  guides: {
    label: 'Construction lines',
    title: 'Bring in the file\'s construction lines as guide lines: drawn dashed, and left out of profiles. They have no ends in the file, so each one is cut a little past the drawing.',
    only: 'Only construction lines on the ticked layers. Turn on Construction lines to import them.',
  },
  maxBytes: 32 * 1024 * 1024,
  read: (bytes) => DxfReader.readBytes(bytes),
};

/**
 * An SVG's numbers are in units no document is in. Its page says how long
 * one is — when it does not, or says it wrong, these are what it may be.
 */
export const SVG_IMPORT: DrawingImportSource = {
  id: 'svg',
  label: 'Import SVG',
  title: 'Import SVG',
  chooseLabel: 'Choose SVG…',
  accept: '.svg,image/svg+xml',
  icon: 'svg',
  hiddenLayer: 'hidden in the file',
  guides: {
    label: 'Guides',
    title: 'Bring in the guides the file keeps beside its drawing as guide lines: drawn dashed, and left out of profiles. They have no ends in the file, so each one is cut a little past the drawing.',
    only: 'Only guides here. Turn on Guides to import them.',
  },
  units: [
    { key: 'px', label: 'Pixel, 96 to the inch', mm: 25.4 / 96 },
    { key: 'pt', label: 'Point, 72 to the inch', mm: 25.4 / 72 },
    { key: 'px90', label: 'Pixel, 90 to the inch', mm: 25.4 / 90 },
  ],
  maxBytes: 32 * 1024 * 1024,
  read: (bytes) => SvgReader.readBytes(bytes),
};

/** What the pointer is doing to the drawing. */
type Drag =
  | { kind: 'move'; grab: Point2 }
  | { kind: 'corner'; corner: Exclude<FrameHit, { part: 'body' } | { part: 'rotate' }>['corner'] }
  | { kind: 'rotate' };

/** A press on the drawing that may turn into a drag once the pointer moves. */
type Pending = { hit: FrameHit; point: Point2; clientX: number; clientY: number };

/** What the tool needs beyond a drawing tool's basics. The I/O is injectable so the flows run under test. */
export type DrawingImportToolDeps = {
  source: DrawingImportSource;
  onRequestExit: () => void;
  readBytes?: (file: File) => Promise<Uint8Array>;
};

/**
 * Imports a 2D drawing file — a DXF, an SVG — into the sketch as the
 * sketch's own entities.
 *
 * The file is read in the page and shown at once: where the file has it
 * when it is drawn around the file's origin, in the middle of the view when
 * it is drawn far from it, the camera zooming out to it if it has to. It is placed by
 * hand like a reference picture: drag it to move it, a corner to scale it,
 * the knob above it to rotate (Shift snaps to 15°). The dialog holds the
 * file, the unit its numbers are in, a scale, the layers, whether ends that
 * meet are joined and whether the geometry is fixed in place. Import writes
 * one statement per curve — `line`, `arc`, `circle`, `ellipse`, `bezier` —
 * a `point` per point of the file, a `coincident` per join and, when asked, the constraints that pin it all,
 * in one edit; the file itself is not kept or linked.
 *
 * A file's construction lines (lines with no end) come in when the dialog's
 * toggle asks for them: as guide lines, cut a little past the rest of the
 * drawing. They do not size the frame the drawing is placed by, unless
 * they are all there is.
 */
export class DrawingImportTool extends SketchTool {
  readonly id: ToolId;
  readonly label: string;
  readonly icon = ICON_FILE_IMPORT;
  /** The dialog takes the sketch dialog's dock while the tool is up. */
  override readonly docksDialog = true;

  private readonly source: DrawingImportSource;
  private readonly panel: DrawingImportPanel;
  private readonly preview: DrawingImportPreview;
  private readonly handles: ReferenceImageHandles;
  private readonly onRequestExit: () => void;
  private readonly readBytes: (file: File) => Promise<Uint8Array>;

  private drawing: ImportedDrawing | null = null;
  /** The names of the layers that come in. */
  private layers = new Set<string>();
  /** The curves and the points of those layers, in the file's coordinates, and their bounds together. */
  private curves: Curve2D[] = [];
  private points: Vec2[] = [];
  /** The construction lines of those layers, cut to a length; none unless they are asked for. */
  private guides: CutLine[] = [];
  private bounds: DrawingBounds | null = null;
  private placement: DrawingPlacement | null = null;
  private unitChoice: DrawingUnitChoice = 'file';
  /** The scale asked for on top of the unit conversion. */
  private userScale = 1;
  private pending: Pending | null = null;
  private drag: Drag | null = null;
  private hover: FrameHit | null = null;
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
    deps: DrawingImportToolDeps,
  ) {
    super(ctx, plane, snapController, insertGeometry, container);
    this.source = deps.source;
    this.id = deps.source.id;
    this.label = deps.source.label;
    this.onRequestExit = deps.onRequestExit;
    this.readBytes = deps.readBytes ?? (async (file) => new Uint8Array(await file.arrayBuffer()));
    this.panel = new DrawingImportPanel(container, deps.source);
    this.panel.onFile = (file) => void this.chooseFile(file);
    this.panel.onUnit = (unit) => this.setUnit(unit);
    this.panel.onScale = (scale) => this.setUserScale(scale);
    this.panel.onLayers = (layers) => this.setLayers(layers);
    this.panel.onGuides = () => this.retake();
    this.panel.onJoins = () => this.refreshSummary();
    this.panel.onFix = () => this.refreshSummary();
    this.panel.onAsDrawn = () => this.placeAsDrawn();
    this.panel.onCenter = () => this.placeInView();
    this.panel.onApply = () => void this.apply();
    this.panel.onExit = () => this.onRequestExit();
    this.preview = new DrawingImportPreview(plane);
    this.handles = new ReferenceImageHandles(plane);
    this.boundPointerDown = this.handlePointerDown.bind(this);
    this.boundPointerMove = this.handlePointerMove.bind(this);
    this.boundPointerUp = this.handlePointerUp.bind(this);
  }

  // ------------------------------------------------------------ lifecycle

  protected onActivate(): void {
    this.ctx.scene.add(this.preview.group);
    this.ctx.scene.add(this.handles.group);
    this.canvas.addEventListener('pointerdown', this.boundPointerDown, { capture: true });
    window.addEventListener('pointermove', this.boundPointerMove);
    window.addEventListener('pointerup', this.boundPointerUp, { capture: true });
    // Handles keep their pixel size, but the knob's stem is a sketch length: redo it on zoom.
    this.unsubscribeCamera = this.ctx.subscribeCameraChange(() => this.refreshHandles());
    this.panel.setJoins(this.autoConstraintsEnabled());
    this.panel.show();
    this.refresh();
  }

  // No exit of its own on Escape: the toolbar's Escape deactivates the tool,
  // which drops the preview — the same exit Cancel takes.
  protected onDeactivate(): void {
    this.canvas.removeEventListener('pointerdown', this.boundPointerDown, { capture: true });
    window.removeEventListener('pointermove', this.boundPointerMove);
    window.removeEventListener('pointerup', this.boundPointerUp, { capture: true });
    this.unsubscribeCamera?.();
    this.unsubscribeCamera = null;
    this.endDrag();
    this.canvas.style.cursor = '';
    this.handles.dispose();
    this.preview.dispose();
    this.panel.destroy();
    this.ctx.requestRender();
  }

  onSceneUpdate(_sceneObjects: SceneObjectRender[], _sketchId: string): void {
    // Nothing of the import depends on the rendered sketch.
  }

  override updatePlane(plane: PlaneData): void {
    super.updatePlane(plane);
    this.preview.updatePlane(plane);
    this.handles.updatePlane(plane);
    this.refresh();
  }

  /** A drag in progress folds first; otherwise the toolbar's Escape leaves the tool. */
  handleEscape(): boolean {
    if (this.drag || this.pending) {
      this.endDrag();
      return true;
    }
    return false;
  }

  // ----------------------------------------------------------------- file

  private async chooseFile(file: File): Promise<void> {
    this.panel.setMessage(null);
    if (file.size > this.source.maxBytes) {
      this.panel.setMessage(`The file is ${(file.size / (1024 * 1024)).toFixed(1)} MB; the limit is ${this.source.maxBytes / (1024 * 1024)} MB.`);
      return;
    }
    let drawing: ImportedDrawing;
    try {
      drawing = this.source.read(await this.readBytes(file));
    } catch (error) {
      this.panel.setMessage(error instanceof Error ? error.message : String(error));
      return;
    }
    if (drawing.entities.length === 0 && drawing.points.length === 0 && drawing.constructionLines.length === 0) {
      const skipped = ImportedDrawings.describeSkipped(drawing.skipped);
      this.panel.setMessage(skipped
        ? `The file has no lines, curves or points to import (it holds ${skipped}).`
        : 'The file has no lines, curves or points to import.');
      return;
    }
    this.drawing = drawing;
    // What the file's author was looking at: every layer that is on — or all of them when none is.
    const shown = drawing.layers.filter((layer) => !layer.hidden);
    this.layers = new Set((shown.length > 0 ? shown : drawing.layers).map((layer) => layer.name));
    this.unitChoice = 'file';
    this.userScale = 1;
    this.panel.setFile(file.name, drawing.unit?.name ?? null, drawing.layers, this.layers, {
      constructionLines: drawing.constructionLines.length,
    });
    this.panel.setScale(1);
    this.takeLayers();
    this.placement = this.bounds ? this.initialPlacement(this.bounds) : null;
    this.refresh();
    this.refreshSummary();
    this.bringIntoView();
  }

  /**
   * The curves, points and bounds of the ticked layers — and their
   * construction lines when those are asked for, cut to the rest. The
   * bounds are the curves' and the points': what the drawing is placed and
   * measured by. Construction lines reach past them, and only stand in
   * when nothing else is ticked.
   */
  private takeLayers(): void {
    this.curves = (this.drawing?.entities ?? [])
      .filter((entity) => this.layers.has(entity.layer))
      .map((entity) => entity.curve);
    this.points = (this.drawing?.points ?? [])
      .filter((point) => this.layers.has(point.layer))
      .map((point) => point.at);
    const content = ImportedDrawings.bounds(this.curves, this.points);
    this.guides = this.panel.guides ? ConstructionLines.segments(this.tickedConstructionLines(), content) : [];
    this.bounds = content ?? ImportedDrawings.bounds([], this.guides.flatMap((guide) => [guide.a, guide.b]));
    this.preview.setDrawing(this.curves, this.points, this.bounds, this.guides);
  }

  private tickedConstructionLines(): ImportedConstructionLine[] {
    // One on no layer belongs to the page: it comes with whatever is ticked.
    return (this.drawing?.constructionLines ?? []).filter((line) => line.layer === null || this.layers.has(line.layer));
  }

  private setLayers(layers: Set<string>): void {
    this.layers = layers;
    this.retake();
  }

  /** What comes in changed: layers ticked, construction lines asked for. */
  private retake(): void {
    if (!this.drawing) {
      return;
    }
    // The drawing stays put while layers come and go: the map from file to
    // sketch is kept, and the frame re-centres on what is left.
    const before = this.placement && this.bounds ? DrawingPlacements.affine(this.placement, this.bounds) : null;
    this.takeLayers();
    if (!this.bounds) {
      this.placement = null;
    } else if (before && this.placement) {
      const center = DrawingPlacements.center(this.bounds);
      const at = Affine.point(before, center);
      this.placement = { ...this.placement, at: [at.x, at.y] };
    } else {
      this.placement = this.initialPlacement(this.bounds);
    }
    this.refresh();
    this.refreshSummary();
  }

  // ---------------------------------------------------------------- scale

  /** Sketch units per file unit, before the user's own scale. */
  private unitFactor(): number {
    const documentMm = MM_PER_UNIT[sceneUnit.current];
    if (this.unitChoice === 'file') {
      // What the file says, or — when it says nothing — its numbers as they are.
      return (this.drawing?.unit?.mm ?? documentMm) / documentMm;
    }
    const ofFile = this.source.units?.find((unit) => unit.key === this.unitChoice);
    return (ofFile?.mm ?? MM_PER_UNIT[this.unitChoice as LengthUnit] ?? documentMm) / documentMm;
  }

  private setUnit(unit: DrawingUnitChoice): void {
    this.unitChoice = unit;
    this.rescale();
  }

  private setUserScale(scale: number): void {
    this.userScale = scale;
    this.rescale();
  }

  private rescale(): void {
    if (this.placement && this.bounds) {
      this.placement = DrawingPlacements.rescaled(this.placement, this.unitFactor() * this.userScale, this.bounds);
    }
    this.refresh();
    this.refreshSummary();
  }

  // ------------------------------------------------------------ placement

  /**
   * Where a newly read drawing goes. A drawing means its coordinates when
   * it is made anywhere near its file's origin — an exported view, a part
   * drawn at zero, a hole pattern beside it — and lands as drawn. One drawn
   * many times its own size away (a detail somewhere on a big sheet, a site
   * plan in survey coordinates) does not: it goes to the middle of the view,
   * where the sketch is being worked on.
   */
  private initialPlacement(bounds: DrawingBounds): DrawingPlacement {
    const asDrawn = DrawingPlacements.asDrawn(bounds, this.unitFactor() * this.userScale);
    const away = Math.hypot(
      Math.max(bounds.min.x, 0, -bounds.max.x),
      Math.max(bounds.min.y, 0, -bounds.max.y),
    );
    const span = Math.hypot(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y);
    const view = this.viewRect();
    // A lone point has no size to be far by: its coordinates are all it says.
    if (!(span > 0) || away <= span * FAR_FROM_ORIGIN || !view) {
      return asDrawn;
    }
    return DrawingPlacements.centeredOn(asDrawn, [(view.min[0] + view.max[0]) / 2, (view.min[1] + view.max[1]) / 2]);
  }

  private placeAsDrawn(): void {
    if (!this.bounds) {
      return;
    }
    this.placement = DrawingPlacements.asDrawn(this.bounds, this.unitFactor() * this.userScale);
    this.refresh();
    this.bringIntoView();
  }

  private placeInView(): void {
    const view = this.viewRect();
    if (!this.placement || !view) {
      return;
    }
    this.placement = DrawingPlacements.centeredOn(this.placement, [(view.min[0] + view.max[0]) / 2, (view.min[1] + view.max[1]) / 2]);
    this.refresh();
  }

  /**
   * Zoom out to the whole drawing when part of its frame is off screen — a
   * drawing larger than what the view showed, or one put back where the
   * file has it. A drawing already in full view leaves the camera alone.
   */
  private bringIntoView(): void {
    const frame = this.frame();
    const view = this.viewRect();
    if (!frame || !view) {
      return;
    }
    const corners = (['tl', 'tr', 'br', 'bl'] as const).map((id) => frame.corner(id));
    const inside = corners.every((corner) => corner[0] >= view.min[0] && corner[0] <= view.max[0]
      && corner[1] >= view.min[1] && corner[1] <= view.max[1]);
    if (inside) {
      return;
    }
    const box = new Box3();
    for (const corner of corners) {
      box.expandByPoint(localToWorld(corner, this.plane));
    }
    this.ctx.fitToBox(box, true);
  }

  /**
   * The part of the sketch plane the canvas shows clear of the dialog, as a
   * box in sketch coordinates; null when it cannot be told.
   */
  private viewRect(): { min: Point2; max: Point2 } | null {
    const rect = this.canvas.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) {
      return null;
    }
    // The dialog docks over the right of the canvas: what is under it is not in view.
    const dialog = this.panel.clientLeft;
    const right = dialog !== null && dialog > rect.left + rect.width / 2
      ? Math.min(rect.left + rect.width, dialog)
      : rect.left + rect.width;
    const corners = [
      projectToSketch(this.ctx, this.plane, rect.left, rect.top),
      projectToSketch(this.ctx, this.plane, right, rect.top),
      projectToSketch(this.ctx, this.plane, rect.left, rect.top + rect.height),
      projectToSketch(this.ctx, this.plane, right, rect.top + rect.height),
    ];
    if (corners.some((corner) => corner === null)) {
      return null;
    }
    const xs = corners.map((corner) => corner![0]);
    const ys = corners.map((corner) => corner![1]);
    return { min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] };
  }

  // -------------------------------------------------------------- pointer

  private handlePointerDown(e: PointerEvent): void {
    if (e.button !== 0 || !this.placement) {
      return;
    }
    const point = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!point) {
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
    this.setHover(this.frame()?.hitTest(point, this.tolerances()) ?? null);
  }

  private handlePointerUp(e: PointerEvent): void {
    if (e.button !== 0) {
      return;
    }
    const scaled = this.drag?.kind === 'corner';
    if (this.drag) {
      e.stopPropagation();
      e.preventDefault();
    }
    this.endDrag();
    if (scaled) {
      // A corner drag changed the scale: what the import writes may have changed with it.
      this.refreshSummary();
    }
    // The drawing moved under a still pointer: re-read what is under it now.
    const point = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (point) {
      this.setHover(this.frame()?.hitTest(point, this.tolerances()) ?? null);
    }
  }

  private setHover(hit: FrameHit | null): void {
    if (DrawingImportTool.sameHit(hit, this.hover)) {
      return;
    }
    this.hover = hit;
    this.handles.setHover(hit);
    this.canvas.style.cursor = ReferenceImageFrame.cursorFor(hit, this.placement?.angle ?? 0);
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
    if (!frame || !this.drag || !this.bounds) {
      return;
    }
    switch (this.drag.kind) {
      case 'move':
        this.placement = DrawingPlacements.fromFrame(frame.move(this.drag.grab, point), this.bounds);
        this.drag = { kind: 'move', grab: point };
        break;
      case 'corner':
        // Always in proportion: a drawing stretched one way is another drawing.
        this.placement = DrawingPlacements.fromFrame(frame.resizeFromCorner(this.drag.corner, point, true), this.bounds);
        this.userScale = this.placement.scale / this.unitFactor();
        this.panel.setScale(this.userScale);
        break;
      case 'rotate':
        this.placement = DrawingPlacements.fromFrame(frame.rotateTo(point, shift ? ROTATE_SNAP_DEGREES : null), this.bounds);
        break;
    }
    this.refresh();
  }

  private endDrag(): void {
    if (this.drag || this.pending) {
      this.ctx.cameraControls.enabled = true;
    }
    this.drag = null;
    this.pending = null;
    this.canvas.style.cursor = ReferenceImageFrame.cursorFor(this.hover, this.placement?.angle ?? 0);
  }

  // -------------------------------------------------------------- refresh

  private frame(): ReferenceImageFrame | null {
    return this.placement && this.bounds ? DrawingPlacements.frame(this.placement, this.bounds) : null;
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

  /** Preview, handles and read-out from the placement as it stands. */
  private refresh(): void {
    this.preview.setPlacement(this.placement);
    if (this.placement && this.bounds) {
      this.panel.setReadout(DrawingPlacements.size(this.placement, this.bounds), this.placement.at, this.placement.angle);
    } else {
      this.panel.setReadout(null, [0, 0], 0);
    }
    this.refreshHandles();
  }

  private refreshHandles(): void {
    this.handles.rebuild(this.frame(), this.stem());
    this.ctx.requestRender();
  }

  // ----------------------------------------------------------------- plan

  /** A length in millimetres, in the document's unit. */
  private static fromMm(mm: number): number {
    return mm / MM_PER_UNIT[sceneUnit.current];
  }

  /** The statements the placed drawing becomes; null with nothing placed. */
  private plan(): SketchImportPlan | null {
    if (!this.placement || !this.bounds) {
      return null;
    }
    const tolerance = DrawingImportTool.fromMm(TOLERANCE_MM);
    const m = DrawingPlacements.affine(this.placement, this.bounds);
    const placed: Curve2D[] = [];
    for (const curve of this.curves) {
      const mapped = Affine.curve(m, curve, tolerance * 1e-3);
      if (mapped) {
        placed.push(mapped);
      }
    }
    return SketchImport.plan(placed, {
      tolerance,
      joinTolerance: DrawingImportTool.fromMm(JOIN_TOLERANCE_MM),
      decimals: DrawingImportTool.decimals(),
    }, this.points.map((point) => Affine.point(m, point)), {
      guides: this.guides.map((guide) => ({ a: Affine.point(m, guide.a), b: Affine.point(m, guide.b) })),
    });
  }

  /** The decimals an imported coordinate is written with, in the document's unit. */
  private static decimals(): number {
    return UNIT_DISPLAY_DECIMALS[sceneUnit.current] + EXTRA_DECIMALS;
  }

  /** What Import would write, as the dialog's summary. Not run while dragging: a move or a turn changes none of it. */
  private refreshSummary(): void {
    const drawing = this.drawing;
    if (!drawing) {
      this.panel.setSummary(null);
      return;
    }
    const plan = this.plan();
    const notes = [...drawing.warnings];
    const skipped = ImportedDrawings.describeSkipped(drawing.skipped);
    if (skipped) {
      notes.push(`Not curves, left out: ${skipped}.`);
    }
    if (plan && plan.approximated > 0) {
      notes.push(`${plan.approximated} ${plan.approximated === 1 ? 'curve has' : 'curves have'} no sketch statement of ${plan.approximated === 1 ? 'its' : 'their'} own (an elliptical arc, a weighted or high-degree spline) and ${plan.approximated === 1 ? 'is' : 'are'} written as cubic beziers.`);
    }
    if (plan && plan.duplicates > 0) {
      notes.push(`${plan.duplicates} ${plan.duplicates === 1 ? 'curve is' : 'curves are'} drawn twice in the file and written once.`);
    }
    const entities = plan?.primitives.length ?? 0;
    let blocked: string | null = null;
    if (entities === 0) {
      if (!this.panel.guides && this.tickedConstructionLines().length > 0) {
        blocked = this.source.guides.only;
      } else if (this.layers.size === 0) {
        blocked = 'Tick at least one layer.';
      } else {
        blocked = 'Nothing to import on the ticked layers.';
      }
    } else if (entities > MAX_IMPORT_STATEMENTS) {
      blocked = `This would write ${entities.toLocaleString('en-US')} sketch entities; one import takes up to ${MAX_IMPORT_STATEMENTS.toLocaleString('en-US')}.`
        + (drawing.layers.length > 1 ? ' Untick layers to bring in less.' : '');
    }
    const joined = this.panel.joins;
    const pins = plan && this.panel.fix
      ? SketchImport.pins(plan, { joined, decimals: DrawingImportTool.decimals() }).length
      : 0;
    const guides = plan?.primitives.filter((primitive) => SketchImport.isGuide(primitive)).length ?? 0;
    this.panel.setSummary({ entities, guides, joins: joined ? plan?.joins.length ?? 0 : 0, pins, notes, blocked });
  }

  // --------------------------------------------------------------- commit

  private async apply(): Promise<void> {
    if (this.busy) {
      return;
    }
    const plan = this.plan();
    if (!plan || plan.primitives.length === 0 || plan.primitives.length > MAX_IMPORT_STATEMENTS) {
      return;
    }
    if (!this.solvedCtx) {
      this.panel.setMessage('This sketch cannot take an import.');
      return;
    }
    this.setBusy(true);
    try {
      const result = await this.emit(DrawingImportEmission.request(plan, {
        joins: this.panel.joins,
        fix: this.panel.fix,
        decimals: DrawingImportTool.decimals(),
      }));
      if (!result.success) {
        this.panel.setMessage(result.reason ?? 'The drawing could not be written to the sketch.');
        return;
      }
      this.onRequestExit();
    } catch (error) {
      this.panel.setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      this.setBusy(false);
    }
  }

  private emit(request: SolvedEmissionRequest): Promise<SolvedEmitResult> {
    return this.solvedCtx!.emit(request);
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.panel.setBusy(busy);
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
}
