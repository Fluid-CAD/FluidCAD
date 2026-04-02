import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { rad } from "../helpers/math-helpers.js";
import { Solid } from "../common/shapes.js";
import { fuseWithSceneObjects } from "../helpers/scene-helpers.js";
import { ExtrudeOps } from "../oc/extrude-ops.js";
import { Explorer } from "../oc/explorer.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { Extrudable } from "../helpers/types.js";
import { AxisObjectBase } from "./axis-renderable-base.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { ExtrudeBase } from "./extrude-base.js";
import { IRevolve } from "../core/interfaces.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { Face } from "../common/face.js";

export class Revolve extends ExtrudeBase implements IRevolve {

  constructor(
    public axis: AxisObjectBase,
    public angle: number,
    public symmetric: boolean = false,
    extrudable?: Extrudable) {
    super(extrudable);
  }

  build(context: BuildSceneObjectContext) {
    const plane = this.extrudable.getPlane();

    const pickedFaces = this.resolvePickedFaces(plane);
    if (pickedFaces !== null && pickedFaces.length === 0) {
      return;
    }

    const solids: Solid[] = [];
    const faces = pickedFaces ?? FaceMaker2.getRegions(this.extrudable.getGeometries(), plane);
    const { result: fusedFaces } = BooleanOps.fuseFaces(faces);

    const axis = this.axis.getAxis();
    for (const face of fusedFaces) {
      const solid = ExtrudeOps.makeRevol(face, axis, rad(this.angle));

      if (this.symmetric) {
        const rotated = ShapeOps.rotateShape(solid.getShape(), axis, -rad(this.angle) / 2);
        solids.push(Solid.fromTopoDSSolid(Explorer.toSolid(rotated)));
      } else {
        solids.push(Solid.fromTopoDSSolid(Explorer.toSolid(solid.getShape())));
      }
    }

    this.extrudable.removeShapes(this);
    this.axis.removeShapes(this);

    const sceneObjects = context.getSceneObjects();

    if (this.getFusionScope() === 'none' || !sceneObjects.length) {
      this.addShapes(solids);
      return;
    }

    const fusionResult = fuseWithSceneObjects(sceneObjects, solids);

    for (const modifiedShape of fusionResult.modifiedShapes) {
      if (modifiedShape.object) {
        modifiedShape.object.removeShape(modifiedShape.shape, this);
      }
    }

    this.addShapes(fusionResult.newShapes);
  }

  override getDependencies(): SceneObject[] {
    return this.extrudable ? [this.extrudable] : [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const extrudable = this.extrudable
      ? (remap.get(this.extrudable) || this.extrudable) as Extrudable
      : undefined;
    return new Revolve(this.axis, this.angle, this.symmetric, extrudable).syncWith(this);
  }

  compareTo(other: Revolve): boolean {
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

    if (this.symmetric !== other.symmetric) {
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
      symmetric: this.symmetric || undefined,
      picking: this.isPicking() || undefined,
      pickPoints: this.isPicking()
        ? this._pickPoints.map(p => { const pt = p.asPoint2D(); return [pt.x, pt.y]; })
        : undefined,
    }
  }
}
