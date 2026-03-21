import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Axis } from "../math/axis.js";
import { Matrix4 } from "../math/matrix4.js";
import { rad } from "../helpers/math-helpers.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { GeometrySceneObject } from "./2d/geometry.js";
import { LazyVertex } from "./lazy-vertex.js";
import { CircularCopyOptions } from "./copy-circular.js";

export class CopyCircular2D extends GeometrySceneObject {
  constructor(
    public center: LazyVertex,
    public options: CircularCopyOptions,
    public targetObjects: SceneObject[] | null = null
    ) {
    super();
  }

  build(context: BuildSceneObjectContext) {
    let objects: SceneObject[];
    const allSiblings = this.sketch.getPreviousSiblings(this);

    if (this.targetObjects && this.targetObjects.length > 0) {
      objects = allSiblings.filter(obj => this.targetObjects.includes(obj));
    } else {
      objects = allSiblings;
    }

    const plane = this.sketch.getPlane();
    const origin = plane.localToWorld(this.center.asPoint2D());
    const direction = plane.normal;

    const { count, centered, skip } = this.options;

    let offset: number;
    if ('offset' in this.options && this.options.offset !== undefined) {
      offset = this.options.offset;
    } else {
      offset = this.options.angle / count;
    }

    const startOffset = centered ? -(count * offset) / 2 : 0;

    for (let i = 1; i < count; i++) {
      if (skip?.includes(i)) continue;

      const angle = startOffset + offset * i;
      const matrix = Matrix4.fromRotationAroundAxis(origin, direction, rad(angle));

      for (const obj of objects) {
        for (const shape of obj.getShapes()) {
          const transformed = ShapeOps.transform(shape, matrix);
          this.addShape(transformed);
        }
      }
    }

    this.setCurrentPosition(this.center.asPoint2D())
  }

  compareTo(other: CopyCircular2D): boolean {
    if (!(other instanceof CopyCircular2D)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (!this.center.compareTo(other.center)) {
      return false;
    }

    const thisTargetObjects = this.targetObjects || [];
    const otherTargetObjects = other.targetObjects || [];

    if (thisTargetObjects.length !== otherTargetObjects.length) {
      return false;
    }

    for (let i = 0; i < thisTargetObjects.length; i++) {
      if (!thisTargetObjects[i].compareTo(otherTargetObjects[i])) {
        return false;
      }
    }

    if (JSON.stringify(this.options) !== JSON.stringify(other.options)) {
      return false;
    }

    return true;
  }

  getType(): string {
    return "copy-circular";
  }

  getUniqueType(): string {
    return "copy-circular-2d";
  }

  serialize() {
    return {
    }
  }
}
