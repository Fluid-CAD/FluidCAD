import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Extruder } from "./simple-extruder.js";
import { fuseWithSceneObjects, cutWithSceneObjects } from "../helpers/scene-helpers.js";
import { Extrudable } from "../helpers/types.js";
import { ExtrudeBase } from "./extrude-base.js";
import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { Explorer } from "../oc/explorer.js";
import { ExtrudeThroughAll } from "./infinite-extrude.js";
import { ThinFaceMaker } from "../oc/thin-face-maker.js";

export class Extrude extends ExtrudeBase {
  constructor(public distance: number, source?: Extrudable | SceneObject) {
    super(source);
  }

  build(context: BuildSceneObjectContext) {
    const p = context.getProfiler();

    const plane = p.record('getSourcePlane', () => this.getSourcePlane());

    const pickedFaces = p.record('resolvePickedFaces', () => this.resolvePickedFaces(plane));
    if (pickedFaces !== null && pickedFaces.length === 0) {
      return;
    }

    let faces: Face[];
    let inwardEdges: Edge[] | undefined;
    let outwardEdges: Edge[] | undefined;

    faces = p.record('resolveFaces', () => {
      if (this.isFaceSourced()) {
        if (this.isThin()) {
          throw new Error("thin() is not supported with a face-sourced extrude");
        }
        return pickedFaces ?? this.getSourceFaces();
      } else if (this.isThin()) {
        const thinResult = ThinFaceMaker.make(this.extrudable.getGeometries(), plane, this._thin[0], this._thin[1]);
        inwardEdges = thinResult.inwardEdges;
        outwardEdges = thinResult.outwardEdges;
        return thinResult.faces;
      } else {
        return pickedFaces ?? FaceMaker2.getRegions(
          this.extrudable.getGeometries(),
          plane,
          this.getDrill()
        );
      }
    });

    if (this._operationMode === 'remove') {
      this.buildRemove(faces, plane, context);
    } else if (this._symmetric) {
      this.buildSymmetric(faces, plane, context, inwardEdges, outwardEdges);
    } else {
      this.buildAdd(faces, plane, context, inwardEdges, outwardEdges);
    }

    this.setFinalShapes(this.getShapes());
  }

  private buildAdd(faces: Face[], plane: any, context: BuildSceneObjectContext, inwardEdges?: Edge[], outwardEdges?: Edge[]) {
    const p = context.getProfiler();

    const sceneObjects = p.record('resolveFusionScope', () => this.resolveFusionScope(context.getSceneObjects()));

    const extruder = new Extruder(faces, plane, this.distance, this.getDraft(), this.getEndOffset());
    let extrusions = p.record('extruder.extrude', () => extruder.extrude());

    let sideFaces = extruder.getSideFaces();
    let internalFaces = extruder.getInternalFaces();
    let capFaces: Face[] = [];

    if (inwardEdges && inwardEdges.length > 0) {
      const result = this.reclassifyThinFaces(
        [...sideFaces, ...internalFaces], extruder.getStartFaces(), plane, inwardEdges, outwardEdges || []
      );
      sideFaces = result.sideFaces;
      internalFaces = result.internalFaces;
      capFaces = result.capFaces;
    }

    this.setState('start-faces', extruder.getStartFaces());
    this.setState('end-faces', extruder.getEndFaces());
    this.setState('side-faces', sideFaces);
    this.setState('internal-faces', internalFaces);
    this.setState('cap-faces', capFaces);

    this.getSource()?.removeShapes(this);

    console.log("Extrusions before fusion:", extrusions.length);
    if (extrusions.length === 0 || sceneObjects.length === 0) {
      this.addShapes(extrusions);
      this.recordShapeFacesAndEdgesAsAdditions(extrusions);
      this.classifyExtrudeEdges();
      return;
    }

    const fusionResult = p.record('fuseWithSceneObjects', () => fuseWithSceneObjects(
      sceneObjects,
      extrusions,
      {
        glue: this.isFaceSourced() ? 'full' : undefined,
        recordHistoryFor: this,
      },
    ));

    for (const modifiedShape of fusionResult.modifiedShapes) {
      if (!modifiedShape.object) {
        continue;
      }
      modifiedShape.object.removeShape(modifiedShape.shape, this);
    }

    this.addShapes(fusionResult.newShapes);

    if (fusionResult.toolHistory) {
      this.remapClassifiedFaces(fusionResult.toolHistory);
    }
    this.classifyExtrudeEdges();
  }

  private buildSymmetric(faces: Face[], plane: any, context: BuildSceneObjectContext, inwardEdges?: Edge[], outwardEdges?: Edge[]) {
    const sceneObjects = this.resolveFusionScope(context.getSceneObjects());

    const extruder1 = new Extruder(faces, plane, this.distance / 2, this.getDraft(), this.getEndOffset());
    const extrusions1 = extruder1.extrude();
    const startFaces = extruder1.getEndFaces();

    const extruder2 = new Extruder(faces, plane, -this.distance / 2, this.getDraft(), this.getEndOffset());
    const extrusions2 = extruder2.extrude();
    const endFaces = extruder2.getEndFaces();

    const all = [...extrusions1, ...extrusions2];
    const halvesFuse = BooleanOps.fuse(all);
    const extrusions = halvesFuse.result;
    halvesFuse.dispose();

    // Collect remaining faces and fused start/end faces from the fused solid.
    // We need the fused face objects (not pre-fusion) for IsPartner matching.
    const remainingFaces: Face[] = [];
    const fusedStartFaces: Face[] = [];
    const fusedEndFaces: Face[] = [];
    for (const solid of extrusions) {
      const allFaces = Explorer.findFacesWrapped(solid);
      for (const f of allFaces) {
        const isStart = startFaces.some(sf => f.getShape().IsSame(sf.getShape()));
        const isEnd = endFaces.some(ef => f.getShape().IsSame(ef.getShape()));
        if (isStart) {
          fusedStartFaces.push(f as Face);
        } else if (isEnd) {
          fusedEndFaces.push(f as Face);
        } else {
          remainingFaces.push(f as Face);
        }
      }
    }

    let sideFaces: Face[];
    let internalFaces: Face[];
    let capFaces: Face[] = [];

    if (inwardEdges && inwardEdges.length > 0) {
      // For thin open profiles: reclassify using 2D midpoint matching on the fused solid
      const result = this.reclassifyThinFaces(
        remainingFaces, [...fusedStartFaces, ...fusedEndFaces], plane, inwardEdges, outwardEdges || []
      );
      sideFaces = result.sideFaces;
      internalFaces = result.internalFaces;
      capFaces = result.capFaces;
    } else {
      // Detect inner wire edges from the extruder's firstFaces (at the sketch plane,
      // pre-fusion). These have the same wire orientation the Extruder uses internally.
      // Then map to fused solid edges using 2D midpoint matching, since SimplifyResult
      // merges half-faces and breaks TShape identity.
      const preInnerEdges: Edge[] = [];
      for (const sf of extruder1.getStartFaces()) {
        for (const wire of (sf as Face).getWires()) {
          if (!wire.isCW(plane.normal)) {
            for (const edge of wire.getEdges()) {
              preInnerEdges.push(edge as Edge);
            }
          }
        }
      }

      const fusedInnerEdges: Edge[] = [];
      if (preInnerEdges.length > 0) {
        const innerMids = preInnerEdges.map(e => plane.worldToLocal(EdgeOps.getEdgeMidPointRaw(e.getShape())));
        for (const sf of fusedStartFaces) {
          for (const sfe of sf.getEdges()) {
            const mid = plane.worldToLocal(EdgeOps.getEdgeMidPointRaw(sfe.getShape()));
            if (innerMids.some(im => mid.distanceTo(im) < 1e-4)) {
              fusedInnerEdges.push(sfe);
            }
          }
        }
      }

      sideFaces = [];
      internalFaces = [];
      for (const f of remainingFaces) {
        const isInternal = fusedInnerEdges.length > 0 && f.getEdges().some(fe =>
          fusedInnerEdges.some(ie => fe.getShape().IsPartner(ie.getShape()))
        );
        if (isInternal) {
          internalFaces.push(f);
        } else {
          sideFaces.push(f);
        }
      }
    }

    this.setState('start-faces', startFaces);
    this.setState('end-faces', endFaces);
    this.setState('side-faces', sideFaces);
    this.setState('internal-faces', internalFaces);
    this.setState('cap-faces', capFaces);

    this.getSource()?.removeShapes(this);

    if (extrusions.length === 0 || sceneObjects.length === 0) {
      this.addShapes(extrusions);
      this.recordShapeFacesAndEdgesAsAdditions(extrusions);
      this.classifyExtrudeEdges();
      return;
    }

    const fusionResult = fuseWithSceneObjects(sceneObjects, extrusions, {
      recordHistoryFor: this,
    });

    for (const modifiedShape of fusionResult.modifiedShapes) {
      if (!modifiedShape.object) {
        continue;
      }
      modifiedShape.object.removeShape(modifiedShape.shape, this);
    }

    this.addShapes(fusionResult.newShapes);

    if (fusionResult.toolHistory) {
      this.remapClassifiedFaces(fusionResult.toolHistory);
    }
    this.classifyExtrudeEdges();
  }

  private buildRemove(faces: Face[], plane: any, context: BuildSceneObjectContext) {
    const scope = this.resolveFusionScope(context.getSceneObjects());

    let toolShapes: any[];
    const isThroughAll = this.distance === 0;

    if (this._symmetric) {
      // Symmetric cut: create tool centered on sketch plane
      if (isThroughAll) {
        if (this.isFaceSourced()) {
          throw new Error("through-all is not supported with a face-sourced extrude");
        }
        const extrudeThroughAll = new ExtrudeThroughAll(this.extrudable, true, true, faces);
        toolShapes = extrudeThroughAll.build();
      } else {
        const extruder1 = new Extruder(faces, plane, -this.distance / 2, this.getDraft(), this.getEndOffset());
        const extrusions1 = extruder1.extrude();
        const extruder2 = new Extruder(faces, plane, this.distance / 2, this.getDraft(), this.getEndOffset());
        const extrusions2 = extruder2.extrude();
        const all = [...extrusions1, ...extrusions2];
        const halvesFuse = BooleanOps.fuse(all);
        toolShapes = halvesFuse.result;
        halvesFuse.dispose();
      }
    } else if (isThroughAll) {
      if (this.isFaceSourced()) {
        throw new Error("through-all is not supported with a face-sourced extrude");
      }
      const extrudeThroughAll = new ExtrudeThroughAll(this.extrudable, false, true, faces);
      toolShapes = extrudeThroughAll.build();
    } else {
      const distance = -this.distance;
      const extruder = new Extruder(faces, plane, distance, this.getDraft(), this.getEndOffset());
      toolShapes = extruder.extrude();
    }

    this.getSource()?.removeShapes(this);

    cutWithSceneObjects(scope, toolShapes, plane, this.distance, this, {
      recordHistoryFor: this,
    });
  }

  override getDependencies(): SceneObject[] {
    const source = this.getSource();
    return source ? [source] : [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const source = this.getSource();
    const remapped = source ? (remap.get(source) || source) : undefined;
    return new Extrude(this.distance, remapped).syncWith(this);
  }

  compareTo(other: Extrude): boolean {
    if (!(other instanceof Extrude)) {
      return false;
    }

    if (!super.compareTo(other)) {
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

    if (this.distance !== other.distance) {
      return false;
    }

    return true;
  }

  getUniqueType(): string {
    if (this._operationMode === 'remove') {
      if (this._symmetric) {
        return 'cut-symmetric';
      }
      return 'cut';
    }
    if (this._symmetric) {
      return 'extrude-symmetric';
    }
    return 'extrude-by-distance';
  }

  serialize() {
    return {
      extrudable: this.getSource()?.serialize(),
      distance: this.distance,
      operationMode: this._operationMode !== 'add' ? this._operationMode : undefined,
      symmetric: this._symmetric || undefined,
      draft: this.getDraft(),
      endOffset: this.getEndOffset(),
      thin: this._thin,
      ...this.serializePickFields(),
    }
  }
}
