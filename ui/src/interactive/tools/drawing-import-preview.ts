import { BufferGeometry, Float32BufferAttribute, Group, Line, Matrix4, Points, PointsMaterial, ShaderMaterial, Vector3 } from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineResolutionRegistry } from '../../meshes/shape-meshes/line-resolution';
import { createDashDotLine } from '../../meshes/dash-dot-line';
import { trackPixelsPerWorld } from '../../meshes/screen-scale';
import type { Curve2D, DrawingBounds, Vec2 } from '../../../../lib/io/drawing/drawing.js';
import { Curves } from '../../../../lib/io/drawing/drawing.js';
import type { CutLine } from '../../../../lib/io/drawing/construction-lines.js';
import { ImportedTexts, type ResolvedText } from '../../../../lib/io/drawing/imported-text.js';
import type { PlaneData } from '../../types';
import { themeColors } from '../../scene/theme-colors';
import { DrawingPlacements, type DrawingPlacement } from './drawing-import-placement';

/** Above the sketch's own lines, under the frame's handles. */
const RENDER_ORDER = 4;

/** The preview's stroke, in pixels: as present as the sketch's own lines, whatever the display's density. */
const LINE_WIDTH_PX = 1.5;

/** The box that stands for a line of text is drawn this thin, in pixels. */
const TEXT_BOX_WIDTH_PX = 1;

/** A point of the file is a dot this many pixels across, whatever the zoom. */
const POINT_SIZE_PX = 7;

/** Segments a full turn of a circle or an ellipse is drawn with. */
const TURN_SEGMENTS = 96;

/**
 * The drawing being imported, drawn on the sketch plane while it is placed.
 *
 * The curves are sampled once, in the file's coordinates about the centre of
 * their bounds, and the file's points are dots among them; a placement only
 * sets the group's matrix. Dragging a drawing
 * of thousands of curves is then one matrix per frame, with nothing rebuilt.
 *
 * Construction lines are drawn the way a sketch draws its guides — dash,
 * dot, dash — in the preview's own colour: what they will be once imported.
 *
 * A text is a box on each of its lines, from the baseline to the top of
 * its capitals and as wide as the line is in its font: where the letters
 * will land, without laying them out.
 */
export class DrawingImportPreview {
  readonly group: Group;
  private lines: LineSegments2 | null = null;
  private dots: Points<BufferGeometry, PointsMaterial> | null = null;
  private guides: Line<BufferGeometry, ShaderMaterial>[] = [];
  private textBoxes: LineSegments2 | null = null;
  private texts = 0;
  private segments = 0;
  private plane: PlaneData;
  private placement: DrawingPlacement | null = null;

  constructor(plane: PlaneData) {
    this.plane = plane;
    this.group = new Group();
    this.group.userData.isMetaShape = true;
    this.group.renderOrder = RENDER_ORDER;
    this.group.matrixAutoUpdate = false;
  }

  updatePlane(plane: PlaneData): void {
    this.plane = plane;
    this.applyMatrix();
  }

  /**
   * Draw `curves`, `points`, `guides` (construction lines, cut to a
   * length) and `texts`; `bounds` are what the drawing is placed by. Null
   * or nothing to draw clears the preview.
   */
  setDrawing(
    curves: readonly Curve2D[],
    points: readonly Vec2[],
    bounds: DrawingBounds | null,
    guides: readonly CutLine[] = [],
    texts: readonly ResolvedText[] = [],
  ): void {
    this.clear();
    if (!bounds) {
      return;
    }
    const center = DrawingPlacements.center(bounds);
    if (curves.length > 0) {
      this.drawCurves(curves, center);
    }
    if (points.length > 0) {
      this.drawPoints(points, center);
    }
    for (const guide of guides) {
      this.drawGuide(guide, center);
    }
    if (texts.length > 0) {
      this.drawTexts(texts, center);
    }
  }

  private drawCurves(curves: readonly Curve2D[], center: Vec2): void {
    const positions: number[] = [];
    for (const curve of curves) {
      const points = Curves.sample(curve, DrawingImportPreview.segmentsOf(curve));
      for (let i = 0; i + 1 < points.length; i++) {
        positions.push(
          points[i].x - center.x, points[i].y - center.y, 0,
          points[i + 1].x - center.x, points[i + 1].y - center.y, 0,
        );
      }
    }
    this.lines = this.strokes(positions, LINE_WIDTH_PX);
    this.segments = positions.length / 6;
  }

  /** The box of every line of every text. */
  private drawTexts(texts: readonly ResolvedText[], center: Vec2): void {
    const positions: number[] = [];
    for (const text of texts) {
      for (const box of ImportedTexts.boxes(text)) {
        box.forEach((corner, i) => {
          const next = box[(i + 1) % box.length];
          positions.push(corner.x - center.x, corner.y - center.y, 0, next.x - center.x, next.y - center.y, 0);
        });
      }
    }
    // Thinner than the curves: a box stands for letters, it is not one of the drawing's lines.
    this.textBoxes = this.strokes(positions, TEXT_BOX_WIDTH_PX);
    this.texts = texts.length;
  }

  /** Line segments in the preview's colour, added to the group. */
  private strokes(positions: number[], width: number): LineSegments2 {
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(positions);
    // The feature dialogs' ghost blue: what an apply would add.
    const material = new LineMaterial({
      color: themeColors.ghostWireColor.getHex(),
      linewidth: width,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
    });
    LineResolutionRegistry.register(material);
    const lines = new LineSegments2(geometry, material);
    lines.renderOrder = RENDER_ORDER;
    // The matrix moves the drawing anywhere: culling on the unplaced bounds would hide it.
    lines.frustumCulled = false;
    this.group.add(lines);
    return lines;
  }

  private drawPoints(points: readonly Vec2[], center: Vec2): void {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(points.flatMap((p) => [p.x - center.x, p.y - center.y, 0]), 3));
    const material = new PointsMaterial({
      color: themeColors.ghostWireColor.getHex(),
      size: POINT_SIZE_PX,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
    });
    this.dots = new Points(geometry, material);
    this.dots.renderOrder = RENDER_ORDER;
    this.dots.frustumCulled = false;
    this.group.add(this.dots);
  }

  /** One construction line, in the sketch's guide pattern. */
  private drawGuide(guide: CutLine, center: Vec2): void {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([
      guide.a.x - center.x, guide.a.y - center.y, 0,
      guide.b.x - center.x, guide.b.y - center.y, 0,
    ], 3));
    const line = createDashDotLine(geometry, themeColors.ghostWireColor, { depthTest: false }) as Line<BufferGeometry, ShaderMaterial>;
    // The pattern is measured along the line in file units, and the
    // placement scales those: the dashes keep their size on screen only
    // when that scale is counted in.
    trackPixelsPerWorld(line, (pixelsPerWorld) => {
      line.material.uniforms.pixelsPerWorld.value = pixelsPerWorld * (this.placement?.scale ?? 1);
    });
    line.renderOrder = RENDER_ORDER;
    line.frustumCulled = false;
    this.guides.push(line);
    this.group.add(line);
  }

  setPlacement(placement: DrawingPlacement | null): void {
    this.placement = placement;
    this.applyMatrix();
  }

  /** How many line segments are on screen — what a test reads. */
  get segmentCount(): number {
    return this.lines ? this.segments : 0;
  }

  /** How many texts are boxed on screen — what a test reads. */
  get textCount(): number {
    return this.textBoxes ? this.texts : 0;
  }

  /** How many construction lines are on screen — what a test reads. */
  get guideCount(): number {
    return this.guides.length;
  }

  /** How many dots are on screen — what a test reads. */
  get pointCount(): number {
    return this.dots ? this.dots.geometry.getAttribute('position').count : 0;
  }

  dispose(): void {
    this.clear();
    this.group.removeFromParent();
  }

  private clear(): void {
    if (this.lines) {
      this.group.remove(this.lines);
      this.lines.geometry.dispose();
      this.lines.material.dispose();
      this.lines = null;
      this.segments = 0;
    }
    if (this.dots) {
      this.group.remove(this.dots);
      this.dots.geometry.dispose();
      this.dots.material.dispose();
      this.dots = null;
    }
    for (const guide of this.guides) {
      this.group.remove(guide);
      guide.geometry.dispose();
      guide.material.dispose();
    }
    this.guides = [];
    if (this.textBoxes) {
      this.group.remove(this.textBoxes);
      this.textBoxes.geometry.dispose();
      this.textBoxes.material.dispose();
      this.textBoxes = null;
      this.texts = 0;
    }
  }

  /** plane frame · move to `at` · turn · scale — the drawing's centre is the group's origin. */
  private applyMatrix(): void {
    const placement = this.placement;
    this.group.visible = placement !== null;
    if (!placement) {
      return;
    }
    const { origin, xDirection, yDirection, normal } = this.plane;
    const frame = new Matrix4().makeBasis(
      new Vector3(xDirection.x, xDirection.y, xDirection.z),
      new Vector3(yDirection.x, yDirection.y, yDirection.z),
      new Vector3(normal.x, normal.y, normal.z),
    ).setPosition(origin.x, origin.y, origin.z);
    const local = new Matrix4()
      .makeRotationZ((placement.angle * Math.PI) / 180)
      .scale(new Vector3(placement.scale, placement.scale, 1))
      .setPosition(placement.at[0], placement.at[1], 0);
    this.group.matrix.multiplyMatrices(frame, local);
    this.group.matrixWorldNeedsUpdate = true;
  }

  /** Enough segments for the curve to read as a curve: straight pieces take one each. */
  private static segmentsOf(curve: Curve2D): number {
    switch (curve.kind) {
      case 'line':
        return 1;
      case 'circle':
        return TURN_SEGMENTS;
      case 'arc':
      case 'ellipse':
        return Math.max(6, Math.ceil(((curve.end - curve.start) / (2 * Math.PI)) * TURN_SEGMENTS));
      case 'bspline':
        return Math.max(16, curve.poles.length * 8);
      case 'polyline':
        return 1;
    }
  }
}
