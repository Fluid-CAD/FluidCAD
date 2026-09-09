import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Camera,
  DoubleSide,
  Material,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Vector3,
} from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineResolutionRegistry } from './meshes/shape-meshes/line-resolution';
import { EntityGeometry } from './meshes/entity-geometry';
import { themeColors } from './scene/theme-colors';
import type { ScreenshotView } from './screenshot-view';

// Mirrored from server/src/ws-protocol.ts — the UI does not import the
// server's compilation graph; the shapes only ever cross as JSON.

/** A face or edge to draw highlighted, addressed as `measure` addresses entities. */
export type ScreenshotHighlightRef = {
  shapeId: string;
  kind: 'face' | 'edge';
  index: number;
  /** Assembly scenes: the instance group the entity is looked up in. */
  instanceId?: string;
};

/** A labelled line between two world points, in document units. */
export type ScreenshotAnnotation = {
  from: [number, number, number];
  to: [number, number, number];
  label?: string;
};

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/** Where an entity or a hide/focus id is looked up in the scene graph. */
export class ScreenshotScopes {

  /** The traversal roots for an entity: the whole scene, or the group(s) posed for `instanceId`. */
  static roots(scene: Object3D, instanceId: string | undefined): Object3D[] {
    if (!instanceId) {
      return [scene];
    }
    return ScreenshotScopes.matching(scene, new Set([instanceId]));
  }

  /**
   * Every object addressed by one of `ids`: shape groups (non-meta) whose
   * `shapeId` matches, and instance groups whose `instanceId` matches.
   */
  static matching(scene: Object3D, ids: ReadonlySet<string>): Object3D[] {
    const found: Object3D[] = [];
    scene.traverse((obj) => {
      const shapeId = obj.userData.shapeId;
      const instanceId = obj.userData.instanceId;
      const byShape = typeof shapeId === 'string' && ids.has(shapeId) && !obj.userData.isMetaShape;
      const byInstance = typeof instanceId === 'string' && ids.has(instanceId);
      if (byShape || byInstance) {
        found.push(obj);
      }
    });
    return found;
  }

  static isUnder(obj: Object3D, roots: ReadonlySet<Object3D>): boolean {
    let cur: Object3D | null = obj;
    while (cur) {
      if (roots.has(cur)) {
        return true;
      }
      cur = cur.parent;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Highlight overlay
// ---------------------------------------------------------------------------

/**
 * Overlay meshes for a capture's highlighted faces and edges. The geometry is
 * the viewer's own selection-highlight geometry (see {@link EntityGeometry});
 * the materials differ from the on-screen selection in one respect — depth
 * testing is off and the meshes render last — so a bore or a far-side face
 * shows through whatever occludes it. Faces get a translucent fill in the
 * theme's highlight colour, edges a thick line in it. Built after the
 * capture's visibility changes, disposed before they are undone.
 */
export class ScreenshotHighlightOverlay {

  static readonly FACE_OPACITY = 0.55;
  static readonly EDGE_LINE_WIDTH = 4;
  /** After every model object (solids draw at 1-2, select overlays at 999). */
  static readonly RENDER_ORDER = 1000;

  /** World bounds of everything drawn; empty when no ref matched. */
  readonly bounds = new Box3();
  private readonly added: Object3D[] = [];
  private readonly owned: Array<BufferGeometry | Material> = [];

  static build(scene: Object3D, refs: ScreenshotHighlightRef[]): ScreenshotHighlightOverlay {
    const overlay = new ScreenshotHighlightOverlay();
    for (const ref of refs) {
      for (const root of ScreenshotScopes.roots(scene, ref.instanceId)) {
        if (ref.kind === 'face') {
          overlay.addFace(root, ref.shapeId, ref.index);
        } else {
          overlay.addEdge(root, ref.shapeId, ref.index);
        }
      }
    }
    return overlay;
  }

  dispose(): void {
    for (const obj of this.added) {
      obj.parent?.remove(obj);
    }
    for (const resource of this.owned) {
      resource.dispose();
    }
    this.added.length = 0;
    this.owned.length = 0;
  }

  private addFace(root: Object3D, shapeId: string, faceIndex: number): void {
    for (const { mesh, positions } of EntityGeometry.faceTriangles(root, shapeId, faceIndex)) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(positions, 3));
      const material = new MeshBasicMaterial({
        color: themeColors.highlightColor,
        transparent: true,
        opacity: ScreenshotHighlightOverlay.FACE_OPACITY,
        depthTest: false,
        depthWrite: false,
        side: DoubleSide,
      });
      const overlay = new Mesh(geometry, material);
      overlay.renderOrder = ScreenshotHighlightOverlay.RENDER_ORDER;
      this.attach(overlay, mesh.parent ?? root);
      this.owned.push(geometry, material);
    }
  }

  private addEdge(root: Object3D, shapeId: string, edgeIndex: number): void {
    for (const line of EntityGeometry.edgeLines(root, shapeId, edgeIndex)) {
      const source = line as LineSegments2;
      if (!source.geometry) {
        continue;
      }
      const material = new LineMaterial({
        color: themeColors.highlightColor.getHex(),
        linewidth: ScreenshotHighlightOverlay.EDGE_LINE_WIDTH,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: DoubleSide,
      });
      LineResolutionRegistry.register(material);
      // The source geometry is shared, not copied — only the material is ours.
      const overlay = new LineSegments2(source.geometry, material);
      overlay.renderOrder = ScreenshotHighlightOverlay.RENDER_ORDER + 1;
      this.attach(overlay, line.parent ?? root);
      this.owned.push(material);
    }
  }

  private attach(overlay: Object3D, parent: Object3D): void {
    parent.add(overlay);
    overlay.updateWorldMatrix(true, false);
    const geometry = (overlay as Mesh).geometry;
    geometry.computeBoundingBox();
    if (geometry.boundingBox) {
      this.bounds.union(geometry.boundingBox.clone().applyMatrix4(overlay.matrixWorld));
    }
    this.added.push(overlay);
  }
}

// ---------------------------------------------------------------------------
// Hide / focus
// ---------------------------------------------------------------------------

type GhostedMaterial = { material: any; transparent: boolean; opacity: number; depthWrite: boolean };

/**
 * A capture's `hide` (drop these shapes/instances from the render) and
 * `focus` (ghost everything else in place — faint faces, fainter edges, so
 * the context stays readable around the kept objects). Returns the undo.
 */
export class ScreenshotVisibility {

  static readonly GHOST_FACE_OPACITY = 0.1;
  static readonly GHOST_EDGE_OPACITY = 0.3;
  /** Helpers the ghosting leaves alone — they are toggled by their own options. */
  private static readonly UNTOUCHED = new Set(['grid', 'defaultAxesHelper', 'sketchAxesHelper']);

  static apply(scene: Object3D, hide: string[], focus: string[]): () => void {
    const undos: Array<() => void> = [];
    if (hide.length > 0) {
      undos.push(ScreenshotVisibility.hide(scene, hide));
    }
    if (focus.length > 0) {
      undos.push(ScreenshotVisibility.focus(scene, focus));
    }
    return () => {
      for (const undo of undos.reverse()) {
        undo();
      }
    };
  }

  private static hide(scene: Object3D, ids: string[]): () => void {
    const hidden: Object3D[] = [];
    for (const obj of ScreenshotScopes.matching(scene, new Set(ids))) {
      if (obj.visible) {
        obj.visible = false;
        hidden.push(obj);
      }
    }
    return () => {
      for (const obj of hidden) {
        obj.visible = true;
      }
    };
  }

  private static focus(scene: Object3D, ids: string[]): () => void {
    const kept = new Set(ScreenshotScopes.matching(scene, new Set(ids)));
    const ghosted = new Map<any, GhostedMaterial>();
    const ghost = (node: Object3D): void => {
      if (ScreenshotVisibility.UNTOUCHED.has(node.name) || kept.has(node)) {
        return;
      }
      const o = node as any;
      const isLine = !!(o.isLine || node.userData.isEdgeLine);
      if ((o.isMesh || isLine || o.isPoints || o.isSprite) && o.material && !ScreenshotScopes.isUnder(node, kept)) {
        const materials: any[] = Array.isArray(o.material) ? o.material : [o.material];
        for (const material of materials) {
          if (ghosted.has(material)) {
            continue;
          }
          ghosted.set(material, {
            material,
            transparent: material.transparent,
            opacity: material.opacity,
            depthWrite: material.depthWrite,
          });
          material.transparent = true;
          material.opacity = isLine ? ScreenshotVisibility.GHOST_EDGE_OPACITY : ScreenshotVisibility.GHOST_FACE_OPACITY;
          material.depthWrite = false;
        }
      }
      for (const child of node.children) {
        ghost(child);
      }
    };
    ghost(scene);
    return () => {
      for (const { material, transparent, opacity, depthWrite } of ghosted.values()) {
        material.transparent = transparent;
        material.opacity = opacity;
        material.depthWrite = depthWrite;
      }
    };
  }
}

// ---------------------------------------------------------------------------
// Annotations — projection, then painting on the 2D output
// ---------------------------------------------------------------------------

/** A projected annotation, in drawing-buffer pixels of the rendered canvas. */
export type PlannedAnnotation = {
  from: [number, number];
  to: [number, number];
  label?: string;
};

/**
 * Projects annotations through the export camera while it is still posed for
 * the capture. The result is painted onto the 2D output canvas afterwards,
 * so an annotation is never occluded and its line and text are exact pixels
 * rather than a world-unit sprite.
 */
export class ScreenshotAnnotationPlan {

  static project(annotations: ScreenshotAnnotation[], camera: Camera, width: number, height: number): PlannedAnnotation[] {
    return annotations.map((annotation) => ({
      from: ScreenshotAnnotationPlan.pixel(annotation.from, camera, width, height),
      to: ScreenshotAnnotationPlan.pixel(annotation.to, camera, width, height),
      ...(annotation.label !== undefined ? { label: annotation.label } : {}),
    }));
  }

  static pixel(point: [number, number, number], camera: Camera, width: number, height: number): [number, number] {
    const ndc = new Vector3(point[0], point[1], point[2]).project(camera);
    return [((ndc.x + 1) / 2) * width, ((1 - ndc.y) / 2) * height];
  }

  /** Both endpoints of every annotation, for framing. */
  static points(annotations: ScreenshotAnnotation[]): Vector3[] {
    const points: Vector3[] = [];
    for (const annotation of annotations) {
      points.push(new Vector3(...annotation.from), new Vector3(...annotation.to));
    }
    return points;
  }
}

/**
 * Paints screen-space overlays onto a finished capture: annotation lines
 * with end markers and a label pill at the midpoint, and the view label of a
 * multi-view cell. Sizes follow `pixelRatio` the way the sketch readouts do,
 * so a 2× export shown at half size carries on-screen-sized text.
 */
export class ScreenshotPainter {

  static readonly LINE_COLOR = '#1f6feb';
  static readonly LABEL_TEXT_COLOR = '#1b1f24';
  static readonly LABEL_FILL = 'rgba(255, 255, 255, 0.88)';
  static readonly FONT_PX = 13;
  static readonly LINE_WIDTH = 2;
  static readonly MARKER_RADIUS = 3.5;
  static readonly LABEL_PADDING = 5;
  static readonly LABEL_OFFSET = 10;
  static readonly CELL_LABEL_INSET = 8;

  static paintAnnotations(
    canvas: HTMLCanvasElement,
    annotations: PlannedAnnotation[],
    pixelRatio: number,
    offset: { x: number; y: number } = { x: 0, y: 0 },
  ): void {
    if (annotations.length === 0) {
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    const pr = Math.max(1, pixelRatio);
    ctx.save();
    ctx.translate(-offset.x, -offset.y);
    ctx.lineCap = 'round';
    for (const annotation of annotations) {
      const [x0, y0] = annotation.from;
      const [x1, y1] = annotation.to;
      ctx.strokeStyle = ScreenshotPainter.LINE_COLOR;
      ctx.fillStyle = ScreenshotPainter.LINE_COLOR;
      ctx.lineWidth = ScreenshotPainter.LINE_WIDTH * pr;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      for (const [x, y] of [[x0, y0], [x1, y1]]) {
        ctx.beginPath();
        ctx.arc(x, y, ScreenshotPainter.MARKER_RADIUS * pr, 0, Math.PI * 2);
        ctx.fill();
      }
      if (annotation.label) {
        const [ax, ay] = ScreenshotPainter.labelAnchor(annotation.from, annotation.to, pr);
        ScreenshotPainter.paintPill(ctx, annotation.label, ax, ay, pr, 'center');
      }
    }
    ctx.restore();
  }

  static paintViewLabel(canvas: HTMLCanvasElement, label: string, pixelRatio: number): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    const pr = Math.max(1, pixelRatio);
    const inset = ScreenshotPainter.CELL_LABEL_INSET * pr;
    ctx.save();
    ScreenshotPainter.paintPill(ctx, label, inset, inset, pr, 'top-left');
    ctx.restore();
  }

  /**
   * Where a line's label sits: at the midpoint, pushed off the line along
   * its screen normal so the text does not cover the dimension it names.
   */
  static labelAnchor(from: [number, number], to: [number, number], pr: number): [number, number] {
    const mx = (from[0] + to[0]) / 2;
    const my = (from[1] + to[1]) / 2;
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) {
      return [mx, my - ScreenshotPainter.LABEL_OFFSET * pr];
    }
    // The normal that points up the page, so the label tends to sit above.
    let nx = -dy / length;
    let ny = dx / length;
    if (ny > 0) {
      nx = -nx;
      ny = -ny;
    }
    return [mx + nx * ScreenshotPainter.LABEL_OFFSET * pr, my + ny * ScreenshotPainter.LABEL_OFFSET * pr];
  }

  private static paintPill(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    pr: number,
    anchor: 'center' | 'top-left',
  ): void {
    const fontPx = ScreenshotPainter.FONT_PX * pr;
    const pad = ScreenshotPainter.LABEL_PADDING * pr;
    ctx.font = `600 ${fontPx}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const textWidth = ctx.measureText(text).width;
    const w = textWidth + pad * 2;
    const h = fontPx + pad * 2;
    const left = anchor === 'center' ? x - w / 2 : x;
    const top = anchor === 'center' ? y - h / 2 : y;
    const r = Math.min(h / 2, 6 * pr);
    ctx.beginPath();
    ctx.moveTo(left + r, top);
    ctx.lineTo(left + w - r, top);
    ctx.quadraticCurveTo(left + w, top, left + w, top + r);
    ctx.lineTo(left + w, top + h - r);
    ctx.quadraticCurveTo(left + w, top + h, left + w - r, top + h);
    ctx.lineTo(left + r, top + h);
    ctx.quadraticCurveTo(left, top + h, left, top + h - r);
    ctx.lineTo(left, top + r);
    ctx.quadraticCurveTo(left, top, left + r, top);
    ctx.closePath();
    ctx.fillStyle = ScreenshotPainter.LABEL_FILL;
    ctx.fill();
    ctx.lineWidth = Math.max(1, pr);
    ctx.strokeStyle = ScreenshotPainter.LINE_COLOR;
    ctx.stroke();
    ctx.fillStyle = ScreenshotPainter.LABEL_TEXT_COLOR;
    ctx.fillText(text, left + pad, top + h / 2);
  }
}

// ---------------------------------------------------------------------------
// Multi-view layout
// ---------------------------------------------------------------------------

export type LayoutCell = { x: number; y: number; width: number; height: number };

/**
 * The grid a multi-view capture lays its cells on, and the label burned into
 * each cell's corner. Pure arithmetic so the layout is testable without a
 * canvas.
 */
export class MultiViewLayout {

  static readonly COLUMNS = 2;
  static readonly MIN_VIEWS = 2;
  static readonly MAX_VIEWS = 6;
  /** Two opposed isometrics show every face in at least one cell; top and front read like a drawing. */
  static readonly DEFAULT_VIEWS: ScreenshotView[] = [
    { kind: 'named', name: 'iso-ftr' },
    { kind: 'named', name: 'iso-bbl' },
    { kind: 'named', name: 'top' },
    { kind: 'named', name: 'front' },
  ];

  /**
   * `count` equal cells on `columns` columns inside a `width` × `height`
   * canvas, row-major. The composite's own size is the cells' exact sum, so
   * every cell is whole pixels and the last row is never clipped.
   */
  static cells(count: number, width: number, height: number, columns = MultiViewLayout.COLUMNS): { cells: LayoutCell[]; width: number; height: number } {
    const cols = Math.max(1, Math.min(columns, count));
    const rows = Math.max(1, Math.ceil(count / cols));
    const cellWidth = Math.max(1, Math.floor(width / cols));
    const cellHeight = Math.max(1, Math.floor(height / rows));
    const cells: LayoutCell[] = [];
    for (let i = 0; i < count; i++) {
      cells.push({
        x: (i % cols) * cellWidth,
        y: Math.floor(i / cols) * cellHeight,
        width: cellWidth,
        height: cellHeight,
      });
    }
    return { cells, width: cellWidth * cols, height: cellHeight * rows };
  }

  /** The text burned into a cell: the named view's name, else the vantage spelled out. */
  static labelFor(view: ScreenshotView): string {
    switch (view.kind) {
      case 'named':
        return view.name;
      case 'look-from':
        return `look-from [${view.eye.map(MultiViewLayout.round).join(', ')}]`;
      case 'orbit-from-current':
        return `orbit az ${MultiViewLayout.signed(view.azimuthDeg)}° el ${MultiViewLayout.signed(view.elevationDeg)}°`;
      case 'current':
      default:
        return 'current';
    }
  }

  /** Three significant figures — enough to tell vantages apart, short enough for a corner label. */
  static round(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }
    return Number(value.toPrecision(3));
  }

  private static signed(value: number): string {
    const rounded = MultiViewLayout.round(value);
    return rounded > 0 ? `+${rounded}` : `${rounded}`;
  }
}
