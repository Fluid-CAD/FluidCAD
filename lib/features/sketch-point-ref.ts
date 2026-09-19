import { SceneObject } from "../common/scene-object.js";
import { Vertex } from "../common/vertex.js";
import { Point2D } from "../math/point.js";
import { Sketch } from "./2d/sketch.js";
import { LazyVertex } from "./lazy-vertex.js";

/** A point whose coordinates are local to the sketch containing its owner. */
export interface SketchPointRef {
  readonly owner: SceneObject;
  readonly role: string;
  localPoint(): Point2D;
}

/** Shared lifecycle for the sketch's different kinds of point references. */
export abstract class SketchPointVertex extends LazyVertex implements SketchPointRef {
  constructor(
    readonly owner: SceneObject,
    readonly role: string,
    protected readonly referenceName: string,
    private readonly readPoint: () => Point2D,
  ) {
    super(referenceName, () => [Vertex.fromPoint2D(readPoint())]);
  }

  localPoint(): Point2D {
    return this.readPoint();
  }

  // A point can be read while constructing constraints, before the solve.
  // Never let the lazy shape cache turn that early guess into its final value.
  override asPoint2D(): Point2D {
    return this.localPoint();
  }

  override asPoint() {
    return this.localPoint().toPoint();
  }

  getSketch(): Sketch | null {
    for (let parent = this.owner.getParent(); parent; parent = parent.getParent()) {
      if (parent instanceof Sketch) {
        return parent;
      }
    }
    return null;
  }

  override getDependencies(): SceneObject[] {
    // Cloning the sketch also clones its plane and entity children, so the
    // copied reference can resolve against the transformed profile.
    return [this.getSketch() ?? this.owner];
  }

  override compareTo(other: LazyVertex): boolean {
    return other instanceof SketchPointVertex
      && super.compareTo(other)
      && this.role === other.role
      && this.owner.getOrder() === other.owner.getOrder()
      && this.owner.compareTo(other.owner);
  }

  override serialize() {
    return {
      kind: 'sketch-point',
      ownerType: this.owner.getType(),
      ownerOrder: this.owner.getOrder(),
      role: this.role,
      reference: this.referenceName,
    };
  }
}
