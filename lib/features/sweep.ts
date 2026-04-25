import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Explorer } from "../oc/explorer.js";
import { SweepOps } from "../oc/sweep-ops.js";
import { WireOps } from "../oc/wire-ops.js";
import { Wire } from "../common/wire.js";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { Shape } from "../common/shape.js";
import { Extrudable } from "../helpers/types.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { ClassifiedFaces, ExtrudeBase } from "./extrude-base.js";
import { ISweep } from "../core/interfaces.js";
import { cutWithSceneObjects } from "../helpers/scene-helpers.js";
import { ThinFaceMaker, ThinFaceResult } from "../oc/thin-face-maker.js";
import { Plane } from "../math/plane.js";

export class Sweep extends ExtrudeBase implements ISweep {
  private _path: SceneObject;

  constructor(
    path: SceneObject,
    extrudable?: Extrudable,
  ) {
    super(extrudable);
    this._path = path;
  }

  get path(): SceneObject {
    return this._path;
  }

  build(context: BuildSceneObjectContext) {
    const p = context.getProfiler();
    const plane = this.extrudable.getPlane();

    const pickedFaces = p.record('Resolve picked faces', () => this.resolvePickedFaces(plane));
    if (pickedFaces !== null && pickedFaces.length === 0) {
      return;
    }

    if (this.isThin()) {
      const thinResult = p.record('Make thin faces', () => ThinFaceMaker.make(
        this.extrudable.getGeometries(), plane, this._thin[0], this._thin[1],
      ));
      this.buildSweepThin(thinResult, plane, context);
    } else {
      const profileFaces = pickedFaces ?? p.record('Resolve faces', () =>
        FaceMaker2.getRegions(this.extrudable.getGeometries(), plane, this.getDrill()),
      );
      this.buildSweep(profileFaces, plane, context);
    }

    this.setFinalShapes(this.getShapes());
  }

  /** Plain sweep: classify by inner-wire detection on the start face. */
  private buildSweep(profileFaces: Face[], plane: Plane, context: BuildSceneObjectContext) {
    const swept = this.runSweep(profileFaces, context);
    const classified = this.classifySweepByInnerWires(swept, plane);
    this.dispatchFinalize(swept.solids, classified, plane, context);
  }

  /** Thin sweep: shell-like profile with inward/outward offsets. */
  private buildSweepThin(thinResult: ThinFaceResult, plane: Plane, context: BuildSceneObjectContext) {
    const swept = this.runSweep(thinResult.faces, context);

    let classified: ClassifiedFaces;
    if (thinResult.inwardEdges.length > 0) {
      const reclass = this.reclassifyThinFaces(
        swept.sideFaces,
        swept.startFaces,
        plane,
        thinResult.inwardEdges,
        thinResult.outwardEdges,
      );
      classified = {
        startFaces: swept.startFaces,
        endFaces: swept.endFaces,
        sideFaces: reclass.sideFaces,
        internalFaces: reclass.internalFaces,
        capFaces: reclass.capFaces,
      };
    } else {
      classified = this.classifySweepByInnerWires(swept, plane);
    }

    this.dispatchFinalize(swept.solids, classified, plane, context);
  }

  /**
   * Run the sweep and split the resulting faces using OC's `FirstShape` /
   * `LastShape` (the profile at each end of the spine). Anything else is a
   * side face for the caller to refine.
   */
  private runSweep(profileFaces: Face[], context: BuildSceneObjectContext) {
    if (profileFaces.length === 0) {
      throw new Error("Could not extract profile faces from extrudable.");
    }

    const p = context.getProfiler();
    const spineWire = p.record('Get spine wire', () => this.getSpineWire(this._path));
    const sweepResult = p.record('Make sweep', () => SweepOps.makeSweep(spineWire, profileFaces));
    const solids = sweepResult.solids;

    const startFaces: Face[] = [];
    const endFaces: Face[] = [];
    const sideFaces: Face[] = [];
    const firstShapeFromOC = sweepResult.firstShape;
    const lastShapeFromOC = sweepResult.lastShape;

    for (const shape of solids) {
      for (const f of Explorer.findFacesWrapped(shape)) {
        const raw = f.getShape();
        if (firstShapeFromOC && raw.IsSame(firstShapeFromOC)) {
          startFaces.push(f as Face);
        } else if (lastShapeFromOC && raw.IsSame(lastShapeFromOC)) {
          endFaces.push(f as Face);
        } else {
          sideFaces.push(f as Face);
        }
      }
    }

    return { solids, startFaces, endFaces, sideFaces };
  }

  /** Inner-wire classification used by both regular sweep and closed thin profiles. */
  private classifySweepByInnerWires(
    swept: ReturnType<Sweep['runSweep']>,
    plane: Plane,
  ): ClassifiedFaces {
    const innerWireEdges: Edge[] = [];
    for (const sf of swept.startFaces) {
      for (const wire of sf.getWires()) {
        if (!wire.isCW(plane.normal)) {
          for (const edge of wire.getEdges()) {
            innerWireEdges.push(edge);
          }
        }
      }
    }

    const sideFaces: Face[] = [];
    const internalFaces: Face[] = [];

    if (innerWireEdges.length === 0) {
      sideFaces.push(...swept.sideFaces);
    } else {
      for (const f of swept.sideFaces) {
        const isInternal = f.getEdges().some(fe =>
          innerWireEdges.some(iwe => fe.getShape().IsPartner(iwe.getShape()))
        );
        if (isInternal) {
          internalFaces.push(f);
        } else {
          sideFaces.push(f);
        }
      }
    }

    return {
      startFaces: swept.startFaces,
      endFaces: swept.endFaces,
      sideFaces,
      internalFaces,
      capFaces: [],
    };
  }

  /** Remove source + path, then dispatch to cut or fuse path. */
  private dispatchFinalize(
    solids: Shape[],
    classified: ClassifiedFaces,
    plane: Plane,
    context: BuildSceneObjectContext,
  ) {
    this.extrudable.removeShapes(this);
    this._path.removeShapes(this);

    if (this._operationMode === 'remove') {
      const scope = this.resolveFusionScope(context.getSceneObjects());
      this.setState('start-faces', classified.startFaces);
      this.setState('end-faces', classified.endFaces);
      this.setState('side-faces', classified.sideFaces);
      this.setState('internal-faces', classified.internalFaces);
      this.setState('cap-faces', classified.capFaces);
      cutWithSceneObjects(scope, solids, plane, 0, this, { recordHistoryFor: this });
      return;
    }

    this.finalizeAndFuse(solids, classified, context);
  }

  private getSpineWire(pathObj: SceneObject): Wire {
    const shapes = pathObj.getShapes({ excludeMeta: false });

    const edges = shapes.flatMap(s => s.getSubShapes('edge')) as Edge[];
    console.log(`Sweep: Extracted ${edges.length} edges from path object for spine wire.`);

    return WireOps.makeWireFromEdges(edges);
  }

  override getDependencies(): SceneObject[] {
    const deps: SceneObject[] = [];
    if (this.extrudable) {
      deps.push(this.extrudable);
    }
    if (this._path) {
      deps.push(this._path);
    }
    return deps;
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const extrudable = this.extrudable
      ? (remap.get(this.extrudable) || this.extrudable) as Extrudable
      : undefined;
    const path = remap.get(this._path) || this._path;
    return new Sweep(path, extrudable).syncWith(this);
  }

  compareTo(other: Sweep): boolean {
    if (!(other instanceof Sweep)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (!this._path.compareTo(other._path)) {
      return false;
    }

    if (!this.extrudable.compareTo(other.extrudable)) {
      return false;
    }

    return true;
  }

  getType(): string {
    return "sweep";
  }

  serialize() {
    return {
      path: this._path.serialize(),
      extrudable: this.extrudable.serialize(),
      operationMode: this._operationMode !== 'add' ? this._operationMode : undefined,
      thin: this._thin,
      ...this.serializePickFields(),
    };
  }
}
