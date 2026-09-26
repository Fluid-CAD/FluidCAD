import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Explorer } from "../oc/explorer.js";
import { SweepOps, type SweepResult } from "../oc/sweep-ops.js";
import { WireExtendOps } from "../oc/wire-extend-ops.js";
import { Wire } from "../common/wire.js";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { Shape } from "../common/shape.js";
import { Extrudable } from "../helpers/types.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { ClassifiedFaces, ExtrudeBase } from "./extrude-base.js";
import { ISweep, SweepSide } from "../core/interfaces.js";
import { type NumberParam, resolveParam } from "../core/param.js";
import { cutWithSceneObjects, wireFromSceneObjectEdges } from "../helpers/scene-helpers.js";
import { ThinFaceMaker, ThinFaceResult } from "../oc/thin-face-maker.js";
import { Plane } from "../math/plane.js";
import { requireShapes } from "../common/operand-check.js";
import { FaceOps } from "../oc/face-ops.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { mmTol } from "../units/tolerance.js";
import type { Point } from "../math/point.js";

export class Sweep extends ExtrudeBase implements ISweep {
  private _path: SceneObject;
  private _extendStart?: number;
  private _extendEnd?: number;

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

  /**
   * Extends the swept solid beyond the path at the given end by `amount`,
   * continuing straight along the path's tangent there. Chain twice for both ends.
   */
  extend(side: SweepSide, amount: NumberParam): this {
    const value = resolveParam(amount);
    if (side === "start") {
      this._extendStart = value;
    } else if (side === "end") {
      this._extendEnd = value;
    } else {
      throw new Error(`sweep.extend: side must be 'start' or 'end', got '${side}'.`);
    }
    return this;
  }

  override validate() {
    requireShapes(this._path, "path", "sweep");
  }

  build(context: BuildSceneObjectContext) {
    const p = context.getProfiler();
    const plane = this.extrudable.getPlane();

    const pickedFaces = p.record('Resolve picked faces', () => this.resolveRegionFaces(plane));
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
    const classified = this.classifySweepByInnerWires(swept);
    this.dispatchFinalize(swept.solids, classified, plane, context);
  }

  /** Thin sweep: shell-like profile with inward/outward offsets. */
  private buildSweepThin(thinResult: ThinFaceResult, plane: Plane, context: BuildSceneObjectContext) {
    const swept = this.runSweep(thinResult.faces, context);

    let classified: ClassifiedFaces;
    if (thinResult.inwardEdges.length > 0 && swept.generatedFaces.length > 0) {
      const inward = thinResult.inwardEdges.map(edge => plane.worldToLocal(EdgeOps.getEdgeMidPoint(edge)));
      const outward = thinResult.outwardEdges.map(edge => plane.worldToLocal(EdgeOps.getEdgeMidPoint(edge)));
      classified = { startFaces: swept.startFaces, endFaces: swept.endFaces,
        sideFaces: [], internalFaces: [], capFaces: [] };
      for (const { face, profileMidpoint } of swept.generatedFaces) {
        const midpoint = plane.worldToLocal(profileMidpoint);
        if (inward.some(p => p.distanceTo(midpoint) < mmTol(1e-4))) classified.internalFaces.push(face);
        else if (outward.some(p => p.distanceTo(midpoint) < mmTol(1e-4))) classified.sideFaces.push(face);
        else classified.capFaces.push(face);
      }
    } else if (thinResult.inwardEdges.length > 0) {
      const transform = swept.profileTransform;
      const inward = transform ? thinResult.inwardEdges.map(e => ShapeOps.transform(e, transform) as Edge) : thinResult.inwardEdges;
      const outward = transform ? thinResult.outwardEdges.map(e => ShapeOps.transform(e, transform) as Edge) : thinResult.outwardEdges;
      let reclass: ReturnType<Sweep["reclassifyThinFaces"]>;
      try {
        reclass = this.reclassifyThinFaces(swept.sideFaces, swept.startFaces,
          transform ? plane.applyMatrix(transform) : plane, inward, outward);
      } finally {
        if (transform) [...inward, ...outward].forEach(edge => edge.dispose());
      }
      classified = {
        startFaces: swept.startFaces,
        endFaces: swept.endFaces,
        sideFaces: reclass.sideFaces,
        internalFaces: reclass.internalFaces,
        capFaces: reclass.capFaces,
      };
    } else {
      classified = this.classifySweepByInnerWires(swept);
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
    let sweepResult: SweepResult;
    try {
      sweepResult = p.record('Make sweep', () => SweepOps.makeSweep(spineWire, profileFaces, this.extrudable.getPlane()));
    } finally {
      spineWire.dispose();
    }
    const solids = sweepResult.solids;

    const startFaces: Face[] = [];
    const endFaces: Face[] = [];
    const sideFaces: Face[] = [];
    const generatedFaces: { face: Face; profileMidpoint: Point; internal: boolean }[] = [];

    for (let solidIndex = 0; solidIndex < solids.length; solidIndex++) {
      const faces = Explorer.findFacesWrapped(solids[solidIndex]);
      for (let faceIndex = 0; faceIndex < faces.length; faceIndex++) {
        const f = faces[faceIndex];
        const role = sweepResult.faceRoles.find(role => role.solidIndex === solidIndex && role.faceIndex === faceIndex)!;
        if (role.kind === "start") {
          startFaces.push(f);
        } else if (role.kind === "end") {
          endFaces.push(f);
        } else {
          sideFaces.push(f);
          if (role.profileMidpoint) generatedFaces.push({ face: f, profileMidpoint: role.profileMidpoint, internal: role.kind === "inner" });
        }
      }
    }

    return { solids, startFaces, endFaces, sideFaces, generatedFaces, profileTransform: sweepResult.profileTransform };
  }

  /** Inner-wire classification used by both regular sweep and closed thin profiles. */
  private classifySweepByInnerWires(
    swept: ReturnType<Sweep['runSweep']>,
  ): ClassifiedFaces {
    if (swept.generatedFaces.length > 0) {
      const inner = new Set(swept.generatedFaces.filter(entry => entry.internal).map(entry => entry.face));
      return { startFaces: swept.startFaces, endFaces: swept.endFaces,
        sideFaces: swept.sideFaces.filter(face => !inner.has(face)), internalFaces: [...inner], capFaces: [] };
    }
    const innerWireEdges: Edge[] = [];
    for (const sf of swept.startFaces) {
      const outer = FaceOps.outerWireRaw(sf.getShape());
      try {
        for (const wire of sf.getWires()) {
          if (!wire.getShape().IsSame(outer)) {
            innerWireEdges.push(...wire.getEdges());
          }
        }
      } finally { outer.delete(); }
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
      cutWithSceneObjects(scope, solids, plane, 0, this, { recordHistoryFor: this, skipSimplify: true, validateResult: true });
      return;
    }

    // Sweep paths can produce tangent contact between the swept tube and
    // existing scene shapes (e.g., a helix sweep along a cylinder face).
    // SimplifyResult's face unification can iterate forever on the resulting
    // topology — skip it for sweep ops; downstream classification doesn't
    // need same-domain face merging.
    this.finalizeAndFuse(solids, classified, context, { skipSimplify: true, validateResult: true });
  }

  private getSpineWire(pathObj: SceneObject): Wire {
    let wire = wireFromSceneObjectEdges(pathObj, "sweep path");
    try {
      for (const [side, amount] of [["start", this._extendStart], ["end", this._extendEnd]] as const) {
        if (amount === undefined) continue;
        const extended = WireExtendOps.extendWire(wire, side, amount);
        if (extended !== wire) wire.dispose();
        wire = extended;
      }
      return wire;
    } catch (error) {
      wire.dispose();
      throw error;
    }
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
    const copy = new Sweep(path, extrudable);
    copy.syncWith(this);
    copy._extendStart = this._extendStart;
    copy._extendEnd = this._extendEnd;
    return copy;
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

    if (this._extendStart !== other._extendStart) {
      return false;
    }

    if (this._extendEnd !== other._extendEnd) {
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
      extendStart: this._extendStart,
      extendEnd: this._extendEnd,
      ...this.serializePickFields(),
    };
  }
}
