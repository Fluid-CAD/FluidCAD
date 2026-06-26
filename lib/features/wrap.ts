import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Face } from "../common/face.js";
import { ClassifiedFaces, ExtrudeBase } from "./extrude-base.js";
import { Extrudable } from "../helpers/types.js";
import { cutWithSceneObjects } from "../helpers/scene-helpers.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { WrapOps } from "../oc/wrap-ops.js";
import { Plane } from "../math/plane.js";
import { IWrap } from "../core/interfaces.js";

/**
 * Wraps a sketch onto a curved face (cylindrical or conical) and thickens it
 * along the surface normal — emboss with `.add()` (default), deboss with
 * `.remove()`, standalone pad with `.new()`. The sketch is developed onto the
 * surface preserving lengths (a true wrap, not a projection).
 */
export class Wrap extends ExtrudeBase implements IWrap {
  constructor(
    public thickness: number,
    public face: SceneObject,
    source?: Extrudable | SceneObject,
  ) {
    super(source);
  }

  build(context: BuildSceneObjectContext) {
    const p = context.getProfiler();

    const plane = p.record('Get source plane', () => this.getSourcePlane());

    const pickedFaces = p.record('Resolve picked faces', () => this.resolvePickedFaces(plane));
    if (pickedFaces !== null && pickedFaces.length === 0) {
      return;
    }

    const regions = p.record('Resolve faces', () => this.resolveSourceFaces(plane, pickedFaces));
    const targetFace = this.getTargetFace();

    const isRemove = this._operationMode === 'remove';
    const result = p.record('Wrap faces', () =>
      WrapOps.wrap(regions, plane, targetFace, isRemove ? -this.thickness : this.thickness));

    this.getSource()?.removeShapes(this);
    this.face.removeShapes(this);

    if (isRemove) {
      const scope = this.resolveFusionScope(context.getSceneObjects());
      cutWithSceneObjects(scope, result.solids, plane, this.thickness, this, {
        recordHistoryFor: this,
      });
    } else {
      const classified: ClassifiedFaces = {
        startFaces: result.startFaces,
        endFaces: result.endFaces,
        sideFaces: result.sideFaces,
        internalFaces: result.internalFaces,
        capFaces: [],
      };
      this.finalizeAndFuse(result.solids, classified, context);
    }

    this.setFinalShapes(this.getShapes());
  }

  /** Resolve the planar sketch regions to wrap (same source rules as extrude). */
  private resolveSourceFaces(plane: Plane, pickedFaces: Face[] | null): Face[] {
    if (this.isFaceSourced()) {
      return pickedFaces ?? this.getSourceFaces();
    }
    return pickedFaces ?? FaceMaker2.getRegions(
      this.extrudable.getGeometries(),
      plane,
      this.getDrill(),
    );
  }

  private getTargetFace(): Face {
    const selection = this.face.getShapes();
    if (selection.length === 0) {
      throw new Error("wrap() target face selection is empty");
    }
    if (selection.length > 1) {
      throw new Error("wrap() target face selection has more than one shape");
    }

    const shape = selection[0];
    if (!(shape instanceof Face)) {
      throw new Error("wrap() target selection is not a face");
    }
    return shape;
  }

  override getDependencies(): SceneObject[] {
    return [...this.getSourceDependencies(), this.face];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const source = this.getSource();
    const remappedSource = source ? (remap.get(source) || source) : undefined;
    const remappedFace = remap.get(this.face) || this.face;
    return new Wrap(this.thickness, remappedFace, remappedSource).syncWith(this);
  }

  compareTo(other: Wrap): boolean {
    if (!(other instanceof Wrap)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.thickness !== other.thickness) {
      return false;
    }

    const thisSource = this.getSource();
    const otherSource = other.getSource();
    if (!thisSource !== !otherSource) {
      return false;
    }
    if (thisSource && otherSource && !thisSource.compareTo(otherSource)) {
      return false;
    }

    return this.face.compareTo(other.face);
  }

  getType(): string {
    return this._operationMode === 'remove' ? 'cut' : 'wrap';
  }

  getUniqueType(): string {
    return this._operationMode === 'remove' ? 'wrap-remove' : 'wrap';
  }

  serialize() {
    return {
      extrudable: this.getSource()?.serialize(),
      thickness: this.thickness,
      face: 'selection',
      operationMode: this._operationMode !== 'add' ? this._operationMode : undefined,
      ...this.serializePickFields(),
    };
  }
}
