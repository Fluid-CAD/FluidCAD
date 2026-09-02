import {
  Box3,
  CanvasTexture,
  DoubleSide,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  Scene,
} from 'three';
import { worldFromMm } from '../units/scene-scale';

export type StandardPlaneId = 'xy' | 'xz' | 'yz';

/**
 * Axis-colored like the view gizmo, keyed by the plane's NORMAL: yz faces +x
 * (red), xz faces +y (green), xy faces +z (blue).
 */
const PLANE_COLORS: Record<StandardPlaneId, number> = {
  xy: 0x4f83cc,
  xz: 0x5fad63,
  yz: 0xd45d5d,
};

const FILL_OPACITY = 0.1;
const FILL_OPACITY_HOVER = 0.25;
const BORDER_OPACITY = 0.45;
const BORDER_OPACITY_HOVER = 0.9;
/** Half-extent when the scene gives no bounds (empty scene), in mm —
 * converted to the document unit at show time. */
const DEFAULT_HALF_SIZE_MM = 50;
const MIN_HALF_SIZE_MM = 10;
/** How far past the scene bounds the planes extend. */
const BOUNDS_MARGIN = 1.25;
const LABEL_CANVAS = 64;

/**
 * The three origin planes as viewport pick targets for the sketch-on-plane
 * flow. Shown only while the sketch pick mode is armed; each plane is a
 * translucent axis-colored quad (with a corner label) sized past the scene
 * bounds so it stays clickable around the model. Quads carry
 * `userData.standardPlane` and render depth-tested with a polygon offset, so
 * geometry lying ON a plane draws (and, via the picking tie-break, picks)
 * ahead of it.
 */
export class StandardPlanes {
  private group: Group | null = null;
  private quads = new Map<StandardPlaneId, Mesh>();
  private hovered: StandardPlaneId | null = null;

  get visible(): boolean {
    return this.group?.parent != null;
  }

  /** Raycast targets — the three quads while shown, nothing otherwise. */
  get pickTargets(): Mesh[] {
    return this.visible ? [...this.quads.values()] : [];
  }

  planeIdFor(obj: Object3D): StandardPlaneId | null {
    const id = obj.userData.standardPlane;
    return id === 'xy' || id === 'xz' || id === 'yz' ? id : null;
  }

  /**
   * Add (or re-size) the planes. `bounds` is the scene's non-meta bounding
   * box, or null for an empty scene; the planes always sit at the origin, so
   * the extent covers the box's farthest coordinate from it.
   */
  show(scene: Scene, bounds: Box3 | null): void {
    if (!this.group) {
      this.group = this.build();
    }
    let halfSize = worldFromMm(DEFAULT_HALF_SIZE_MM);
    if (bounds && !bounds.isEmpty()) {
      const maxAbs = Math.max(
        Math.abs(bounds.min.x), Math.abs(bounds.max.x),
        Math.abs(bounds.min.y), Math.abs(bounds.max.y),
        Math.abs(bounds.min.z), Math.abs(bounds.max.z),
      );
      halfSize = Math.max(maxAbs * BOUNDS_MARGIN, worldFromMm(MIN_HALF_SIZE_MM));
    }
    this.group.scale.setScalar(halfSize);
    if (!this.group.parent) {
      scene.add(this.group);
    }
  }

  hide(): void {
    if (!this.group) {
      return;
    }
    this.setHover(null);
    this.group.parent?.remove(this.group);
  }

  /** Returns true when the hover state (and thus the render) changed. */
  setHover(id: StandardPlaneId | null): boolean {
    if (id === this.hovered) {
      return false;
    }
    this.hovered = id;
    for (const [planeId, quad] of this.quads) {
      const active = planeId === id;
      (quad.material as MeshBasicMaterial).opacity = active ? FILL_OPACITY_HOVER : FILL_OPACITY;
      const border = quad.userData.border as LineSegments;
      (border.material as LineBasicMaterial).opacity = active ? BORDER_OPACITY_HOVER : BORDER_OPACITY;
    }
    return true;
  }

  private build(): Group {
    const group = new Group();
    group.name = 'standardPlanes';
    // Unit quads spanning -1..1; show() scales the group to the scene.
    for (const id of ['xy', 'xz', 'yz'] as StandardPlaneId[]) {
      const quad = new Mesh(
        new PlaneGeometry(2, 2),
        new MeshBasicMaterial({
          color: PLANE_COLORS[id],
          transparent: true,
          opacity: FILL_OPACITY,
          side: DoubleSide,
          depthWrite: false,
          // Recede behind coplanar scene faces instead of z-fighting them.
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        }),
      );
      quad.userData.standardPlane = id;
      if (id === 'xz') {
        quad.rotation.x = -Math.PI / 2;
      } else if (id === 'yz') {
        quad.rotation.y = Math.PI / 2;
      }

      const border = new LineSegments(
        new EdgesGeometry(quad.geometry),
        new LineBasicMaterial({
          color: PLANE_COLORS[id],
          transparent: true,
          opacity: BORDER_OPACITY,
        }),
      );
      quad.add(border);
      quad.userData.border = border;
      quad.add(this.buildLabel(id));

      this.quads.set(id, quad);
      group.add(quad);
    }
    return group;
  }

  /** Small in-plane name tag near the quad's top-right corner. */
  private buildLabel(id: StandardPlaneId): Mesh {
    const canvas = document.createElement('canvas');
    canvas.width = LABEL_CANVAS * 2;
    canvas.height = LABEL_CANVAS;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = `#${PLANE_COLORS[id].toString(16).padStart(6, '0')}`;
    ctx.font = `bold ${LABEL_CANVAS * 0.7}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(id.toUpperCase(), canvas.width / 2, canvas.height / 2);

    const label = new Mesh(
      new PlaneGeometry(0.3, 0.15),
      new MeshBasicMaterial({
        map: new CanvasTexture(canvas),
        transparent: true,
        side: DoubleSide,
        depthWrite: false,
      }),
    );
    // Local coordinates of the parent's unit quad, just inside the corner.
    label.position.set(0.8, 0.88, 0);
    return label;
  }
}
