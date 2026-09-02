import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Plane } from "../math/plane.js";
import { Point, Point2D } from "../math/point.js";
import { Axis } from "../math/axis.js";
import { ScaleOps } from "../oc/scale-ops.js";
import { SceneDisposal } from "../rendering/scene-disposal.js";
import type { Scene } from "../rendering/scene.js";
import type { Part } from "./part.js";

/**
 * State entries that hold DIRECTIONS as points — a uniform scale leaves
 * them alone. Everything else point-shaped in a state map is a position.
 */
const DIRECTION_KEYS = new Set(['tangent']);

/**
 * Rescale a foreign-unit part's built geometry into the consuming scene's
 * unit — in place, member by member, once the whole part has built.
 *
 * Why in place, and why per member: every downstream consumer reads the
 * part through its members' state — the assembly render meshes each
 * feature's own shapes, picks resolve to the creating feature's row,
 * part-scoped rollback re-emits member state without rebuilding, a mate
 * reads the connector's frame, a tangent mate classifies the exposure's
 * source shapes, and a consuming part file reads `def.features.<name>`
 * straight off the donor object. Swapping the state under them keeps all
 * of that unchanged; a scaled compound at the Part level would have to be
 * re-threaded through each path.
 *
 * Why only after the LAST member built: a member's own numbers are in the
 * definition unit, so it must read its inputs (earlier members) in that
 * unit too. Scaling member by member would hand a 1 in extrude a 25.4 mm
 * sketch. The renderer therefore calls this right after the part's last
 * member builds — before the first consumer outside the part builds.
 *
 * Everything positional in a member's state map is rescaled: shape
 * wrappers (with colours, flags and pick-point metadata), the
 * added/modified/removed face+edge records, plane and axis frames (the
 * connector frame among them), points. Directions and dimensionless data
 * (the sketch solver's numeric snapshot, angles) are left as they are.
 * Instance poses are never touched — the mate solver and every writeback
 * assume rigid poses, so the scale is baked into geometry only.
 */
export function scaleForeignPart(part: Part, members: SceneObject[], scene: Scene): void {
  const factor = part.getUnitScaleFactor();
  const targetUnit = part.getTargetUnit();
  const scaler = new StateScaler(factor);

  for (const member of members) {
    const state = member.getFullState();
    const rescaled = new Map<string, unknown>();
    for (const [key, value] of state) {
      rescaled.set(key, DIRECTION_KEYS.has(key) ? value : scaler.scale(value));
    }
    member.restoreState(rescaled);
    // Mesh deflection and tolerances now belong to the consuming unit; the
    // marker rides the state through the compare caches (SceneObject.getUnit).
    member.setGeometryUnit(targetUnit);
  }

  // The wrappers we swapped out are unreachable from the scene now, unless
  // something outside the part captured one — the survivor check keeps those.
  SceneDisposal.releaseReplacedShapes(scaler.replaced, scene);
}

/**
 * Recursive value rescaler with identity memoization: the same Shape
 * wrapper referenced from several state entries (a member's addedShapes and
 * a sibling's removedShapes record, a snapshot map) maps to ONE scaled copy,
 * so identity-based lookups (`r.shape === s`) keep matching afterwards.
 */
class StateScaler {
  private readonly memo = new Map<Shape, Shape>();
  readonly replaced = new Set<Shape>();

  constructor(private readonly factor: number) {}

  scale(value: unknown): unknown {
    if (!value || typeof value !== 'object') {
      return value;
    }
    if (value instanceof Shape) {
      return this.scaleShape(value);
    }
    // Other scene objects are references, never owned geometry — each one's
    // state is rescaled from its own slot in the member list (or belongs
    // to another part and must not be touched).
    if (value instanceof SceneObject) {
      return value;
    }
    if (value instanceof Plane) {
      return new Plane(
        value.origin.multiplyScalar(this.factor),
        value.xDirection,
        value.normal,
        value.yDirection,
      );
    }
    if (value instanceof Axis) {
      return new Axis(value.origin.multiplyScalar(this.factor), value.direction);
    }
    if (value instanceof Point || value instanceof Point2D) {
      return value.multiplyScalar(this.factor);
    }
    if (Array.isArray(value)) {
      return value.map(item => this.scale(item));
    }
    if (value instanceof Map) {
      const out = new Map<unknown, unknown>();
      for (const [k, v] of value) {
        out.set(this.scale(k), this.scale(v));
      }
      return out;
    }
    if (value instanceof Set) {
      const out = new Set<unknown>();
      for (const item of value) {
        out.add(this.scale(item));
      }
      return out;
    }
    // Plain records only ({shape, removedBy}, {sources, results, ...}).
    // Other class instances (matrices, solver snapshots, raw OC handles)
    // carry no positional payload the scene reads back as geometry.
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = this.scale(v);
      }
      return out;
    }
    return value;
  }

  private scaleShape(shape: Shape): Shape {
    const existing = this.memo.get(shape);
    if (existing) {
      return existing;
    }
    const scaled = ScaleOps.scaleShape(shape, this.factor);
    // A pick cell's `metaData.pickPoint` is a position on the shape.
    if (shape.metaData) {
      scaled.metaData = this.scale(shape.metaData) as Record<string, unknown>;
    }
    this.memo.set(shape, scaled);
    this.replaced.add(shape);
    return scaled;
  }
}
