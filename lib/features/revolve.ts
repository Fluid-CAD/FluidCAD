import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { rad } from "../helpers/math-helpers.js";
import { Solid } from "../common/shapes.js";
import { Axis } from "../math/axis.js";
import { RevolveOptions } from "./revolve-options.js";
import { fuseWithSceneObjects } from "../helpers/scene-helpers.js";
import { Convert } from "../math/convert.js";
import { FaceMaker } from "../core/2d/face-maker.js";
import { ExtrudeOps } from "../oc/extrude-ops.js";
import { Explorer } from "../oc/explorer.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { Extrudable } from "../helpers/types.js";
import { AxisObjectBase } from "./axis-renderable-base.js";

export class Revolve extends SceneObject {
  private _extrudable: Extrudable | null = null;

  constructor(
    public axis: AxisObjectBase,
    public angle: number,
    public options: RevolveOptions,
    extrudable?: Extrudable) {
    super();
    this._extrudable = extrudable ?? null;
  }

  get extrudable(): Extrudable {
    return this._extrudable;
  }

  build(context: BuildSceneObjectContext) {
    console.log('Revolve settings:');
    console.log('Revolve: Angle:', this.angle);
    console.log('Revolve: Axis:', this.axis);
    console.log('Revolve: Options:', this.options);

    const solids: Solid[] = [];
    const wires = this.extrudable.getGeometries();
    const plane = this.extrudable.getPlane();
    const faces = FaceMaker.getFaces(wires, plane);

    const axis = this.axis.getAxis();
    for (const face of faces) {
      const solid = ExtrudeOps.makeRevol(face, axis, rad(this.angle));

      if (this.options.symmetric) {
        const rotated = ShapeOps.rotateShape(solid.getShape(), axis, -rad(this.angle) / 2);
        solids.push(Solid.fromTopoDSSolid(Explorer.toSolid(rotated)));
      }
      else {
        solids.push(Solid.fromTopoDSSolid(Explorer.toSolid(solid.getShape())));
      }
    }

    this.extrudable.removeShapes(this);
    this.axis.removeShapes(this);

    const sceneObjects = context.getSceneObjects();

    if (this.options.mergeScope === 'none' || !sceneObjects.length) {
      this.addShapes(solids);
      return;
    }

    const fusionResult = fuseWithSceneObjects(sceneObjects, solids)

    for (const modifiedShape of fusionResult.modifiedShapes) {
      modifiedShape.object.removeShape(modifiedShape.shape, this);
    }

    this.addShapes(fusionResult.extrusions);
  }

  compareTo(other: SceneObject): boolean {
    if (!(other instanceof Revolve)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.angle !== other.angle) {
      return false;
    }

    if (!this.axis.compareTo(other.axis)) {
      return false;
    }

    if (JSON.stringify(this.options) !== JSON.stringify(other.options)) {
      return false;
    }

    if (!this.extrudable.compareTo(other.extrudable)) {
      return false;
    }

    return true;
  }

  getType(): string {
    return "revolve";
  }

  serialize() {
    return {
      angle: this.angle,
      axis: this.axis.serialize(),
    }
  }
}
