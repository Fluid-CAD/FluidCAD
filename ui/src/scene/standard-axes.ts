import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  Group,
  Line,
  LineBasicMaterial,
  Object3D,
  Scene,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineResolutionRegistry } from '../meshes/shape-meshes/line-resolution';
import { worldFromMm } from '../units/scene-scale';
import { themeColors } from './theme-colors';

export type StandardAxisId = 'x' | 'y' | 'z';

/** Axis-colored like the origin planes' normals: x red, y green, z blue. */
const AXIS_COLORS: Record<StandardAxisId, number> = {
  x: 0xd45d5d,
  y: 0x5fad63,
  z: 0x4f83cc,
};

const AXIS_DIRECTIONS: Record<StandardAxisId, Vector3> = {
  x: new Vector3(1, 0, 0),
  y: new Vector3(0, 1, 0),
  z: new Vector3(0, 0, 1),
};

const LINE_OPACITY = 0.5;
const LINE_OPACITY_ACTIVE = 1;
/** Line width in pixels — the resting stroke and the hovered one. */
const LINE_WIDTH = 1.5;
const LINE_WIDTH_HOVER = 2.5;
/** Half-length when the scene gives no bounds (empty scene), in mm —
 * converted to the document unit at show time. */
const DEFAULT_HALF_SIZE_MM = 50;
const MIN_HALF_SIZE_MM = 10;
/** How far past the scene bounds the axes reach — enough to stick out of
 * the model on both sides so they stay clickable around it. */
const BOUNDS_MARGIN = 1.5;
const LABEL_CANVAS = 64;
/** Label size relative to the half-length. */
const LABEL_SCALE = 0.08;

/** What one axis currently looks like (the visual line's material). */
export type StandardAxisStyle = { linewidth: number; opacity: number; color: number };

/**
 * The three world axes as viewport pick targets for the axis-consuming
 * dialogs (revolve, helix, repeat, rotate, copy). Shown only while a dialog
 * has its axis slot armed; each axis runs through the origin in both
 * directions, sized past the scene bounds, with an axis-colored letter at
 * its positive end. Every axis is two objects: a fat screen-space line
 * (`Line2`, pixel-wide like the solid edges) that is what the user sees —
 * it thickens on hover and the chosen axis is tinted at full strength — and
 * a hidden 1px `Line` that is what the viewer raycasts (`pickTargets`,
 * carrying `userData.standardAxis`): three's legacy line raycast takes the
 * same world-unit threshold the edge picks use, while `Line2` raycasts in
 * screen space and needs a camera. Both are sized by rewriting geometry,
 * never by scaling a parent — the legacy raycast divides its threshold by
 * the line's OWN scale only, so a scaled group would inflate it by the
 * scene's size. The visuals render depth-tested, so an axis passing through
 * a solid is hidden — and, via the viewer's visibility test, not pickable —
 * inside it.
 */
export class StandardAxes {
  private group: Group | null = null;
  /** The hidden raycast targets. */
  private pickLines = new Map<StandardAxisId, Line>();
  /** The fat lines the user sees. */
  private visuals = new Map<StandardAxisId, Line2>();
  private labels = new Map<StandardAxisId, Sprite>();
  private hovered: StandardAxisId | null = null;
  private selected = new Set<StandardAxisId>();
  private halfSize = 0;

  get visible(): boolean {
    return this.group?.parent != null;
  }

  /** How far each axis reaches from the origin, in world units. */
  get reach(): number {
    return this.halfSize;
  }

  /** Raycast targets — the three hidden lines while shown, nothing otherwise. */
  get pickTargets(): Line[] {
    return this.visible ? [...this.pickLines.values()] : [];
  }

  axisIdFor(obj: Object3D): StandardAxisId | null {
    const id = obj.userData.standardAxis;
    return id === 'x' || id === 'y' || id === 'z' ? id : null;
  }

  /** The visual line's current stroke, for tests and debugging. */
  styleOf(id: StandardAxisId): StandardAxisStyle | null {
    const visual = this.visuals.get(id);
    if (!visual) {
      return null;
    }
    const material = visual.material as LineMaterial;
    return { linewidth: material.linewidth, opacity: material.opacity, color: material.color.getHex() };
  }

  /**
   * Add (or re-size) the axes. `bounds` is the scene's non-meta bounding
   * box, or null for an empty scene; the axes always pass through the
   * origin, so the reach covers the box's farthest coordinate from it.
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
    this.resize(halfSize);
    if (!this.group.parent) {
      scene.add(this.group);
    }
  }

  hide(): void {
    if (!this.group) {
      return;
    }
    this.setHover(null);
    this.setSelected([]);
    this.group.parent?.remove(this.group);
  }

  /** Returns true when the hover state (and thus the render) changed. */
  setHover(id: StandardAxisId | null): boolean {
    if (id === this.hovered) {
      return false;
    }
    this.hovered = id;
    this.applyStyles();
    return true;
  }

  /** The dialog's chosen axes (both directions of a grid repeat can be standard). */
  setSelected(ids: readonly StandardAxisId[]): boolean {
    const next = new Set(ids);
    if (next.size === this.selected.size && [...next].every(id => this.selected.has(id))) {
      return false;
    }
    this.selected = next;
    this.applyStyles();
    return true;
  }

  /**
   * Resting: the axis color at half strength. Selected: full strength.
   * Hovered: the highlight color, full strength, and a thicker stroke.
   */
  private applyStyles(): void {
    for (const [id, visual] of this.visuals) {
      const material = visual.material as LineMaterial;
      const hovered = id === this.hovered;
      const active = hovered || this.selected.has(id);
      material.opacity = active ? LINE_OPACITY_ACTIVE : LINE_OPACITY;
      material.linewidth = hovered ? LINE_WIDTH_HOVER : LINE_WIDTH;
      if (hovered) {
        material.color.copy(themeColors.highlightColor);
      } else {
        material.color.set(AXIS_COLORS[id]);
      }
    }
  }

  /** Rewrite every line to span ±halfSize and move the letters past the + ends. */
  private resize(halfSize: number): void {
    if (halfSize === this.halfSize) {
      return;
    }
    this.halfSize = halfSize;
    for (const [id, pickLine] of this.pickLines) {
      const dir = AXIS_DIRECTIONS[id];
      const from = [-dir.x * halfSize, -dir.y * halfSize, -dir.z * halfSize];
      const to = [dir.x * halfSize, dir.y * halfSize, dir.z * halfSize];

      const position = pickLine.geometry.getAttribute('position') as BufferAttribute;
      position.setXYZ(0, from[0], from[1], from[2]);
      position.setXYZ(1, to[0], to[1], to[2]);
      position.needsUpdate = true;
      pickLine.geometry.computeBoundingSphere();

      // A fat line's positions live in instanced buffers — a fresh geometry
      // is the supported way to change them.
      const visual = this.visuals.get(id)!;
      visual.geometry.dispose();
      visual.geometry = new LineGeometry().setPositions([...from, ...to]);

      const label = this.labels.get(id);
      if (label) {
        const labelSize = halfSize * LABEL_SCALE;
        label.position.copy(dir).multiplyScalar(halfSize + labelSize);
        label.scale.set(labelSize, labelSize, 1);
      }
    }
  }

  private build(): Group {
    const group = new Group();
    group.name = 'standardAxes';
    // Scene furniture, not model content — keep it out of camera fits.
    group.userData.isMetaShape = true;
    for (const id of ['x', 'y', 'z'] as StandardAxisId[]) {
      const dir = AXIS_DIRECTIONS[id];
      // Placeholder extents; show() sizes them to the scene through resize().
      const pickLine = new Line(
        new BufferGeometry().setFromPoints([dir.clone().multiplyScalar(-1), dir.clone()]),
        new LineBasicMaterial(),
      );
      pickLine.visible = false;
      pickLine.userData.standardAxis = id;
      this.pickLines.set(id, pickLine);
      group.add(pickLine);

      const material = new LineMaterial({
        color: AXIS_COLORS[id],
        linewidth: LINE_WIDTH,
        transparent: true,
        opacity: LINE_OPACITY,
        depthWrite: false,
      });
      LineResolutionRegistry.register(material);
      const visual = new Line2(new LineGeometry().setPositions([-dir.x, -dir.y, -dir.z, dir.x, dir.y, dir.z]), material);
      visual.userData.standardAxis = id;
      const label = this.buildLabel(id);
      if (label) {
        visual.add(label);
        this.labels.set(id, label);
      }
      this.visuals.set(id, visual);
      group.add(visual);
    }
    return group;
  }

  /** The axis letter just past the positive end, always facing the camera. */
  private buildLabel(id: StandardAxisId): Sprite | null {
    const canvas = document.createElement('canvas');
    canvas.width = LABEL_CANVAS;
    canvas.height = LABEL_CANVAS;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      // No 2D canvas (a test DOM) — the line still picks, only the tag is gone.
      return null;
    }
    ctx.fillStyle = `#${new Color(AXIS_COLORS[id]).getHexString()}`;
    ctx.font = `bold ${LABEL_CANVAS * 0.7}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(id.toUpperCase(), canvas.width / 2, canvas.height / 2);

    const sprite = new Sprite(new SpriteMaterial({
      map: new CanvasTexture(canvas),
      transparent: true,
      depthTest: false,
      depthWrite: false,
    }));
    return sprite;
  }
}
