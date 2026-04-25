import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { ExtrudeBase } from "./extrude-base.js";
import { fuseWithSceneObjects, cutWithSceneObjects } from "../helpers/scene-helpers.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { Explorer } from "../oc/explorer.js";
import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { Extrudable } from "../helpers/types.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { Extruder } from "./simple-extruder.js";
import { ThinFaceMaker } from "../oc/thin-face-maker.js";

export class ExtrudeTwoDistances extends ExtrudeBase {

  constructor(
    public distance1: number,
    public distance2: number,
    source?: Extrudable | SceneObject) {

    super(source);
  }

  build(context: BuildSceneObjectContext) {
    const p = context.getProfiler();

    const plane = p.record('Get source plane', () => this.getSourcePlane());

    const pickedFaces = p.record('Resolve picked faces', () => this.resolvePickedFaces(plane));
    if (pickedFaces !== null && pickedFaces.length === 0) {
      return;
    }

    let faces: Face[];
    let inwardEdges: Edge[] | undefined;
    let outwardEdges: Edge[] | undefined;

    faces = p.record('Resolve faces', () => {
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
        return pickedFaces ?? FaceMaker2.getRegions(this.extrudable.getGeometries(), plane, this.getDrill());
      }
    });

    const draft = this.getDraft();
    const draft1 = draft ? [draft[0], draft[0]] as [number, number] : undefined;
    const draft2 = draft ? [draft[1], draft[1]] as [number, number] : undefined;

    const extruder1 = new Extruder(faces, plane, this.distance1, draft1, this.getEndOffset(), p);
    const extrusions1 = p.record('Extrude direction 1', () => extruder1.extrude());
    const startFaces = extruder1.getEndFaces();

    const extruder2 = new Extruder(faces, plane, -this.distance2, draft2, this.getEndOffset(), p);
    const extrusions2 = p.record('Extrude direction 2', () => extruder2.extrude());
    const endFaces = extruder2.getEndFaces();

    const all = [...extrusions1, ...extrusions2];
    const halvesFuse = p.record('Fuse halves', () => BooleanOps.fuse(all));
    const extrusions = halvesFuse.result;
    halvesFuse.dispose();

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
      const result = this.reclassifyThinFaces(
        remainingFaces, [...fusedStartFaces, ...fusedEndFaces], plane, inwardEdges, outwardEdges || []
      );
      sideFaces = result.sideFaces;
      internalFaces = result.internalFaces;
      capFaces = result.capFaces;
    } else {
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

    if (this._operationMode === 'remove') {
      const scope = p.record('Resolve fusion scope', () => this.resolveFusionScope(context.getSceneObjects()));
      p.record('Cut with scene objects', () => {
        cutWithSceneObjects(scope, extrusions, plane, this.distance1 + this.distance2, this, {
          recordHistoryFor: this,
        });
      });
      this.setFinalShapes(this.getShapes());
      return;
    }

    const sceneObjects = p.record('Resolve fusion scope', () => this.resolveFusionScope(context.getSceneObjects()));

    if (extrusions.length === 0 || sceneObjects.length === 0) {
      this.addShapes(extrusions);
      this.recordShapeFacesAndEdgesAsAdditions(extrusions);
      this.classifyExtrudeEdges();
      this.setFinalShapes(this.getShapes());
      return;
    }

    const fusionResult = p.record('Fuse with scene objects', () => fuseWithSceneObjects(sceneObjects, extrusions, {
      recordHistoryFor: this,
    }));

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
    this.setFinalShapes(this.getShapes());
  }

  override getDependencies(): SceneObject[] {
    const source = this.getSource();
    return source ? [source] : [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const source = this.getSource();
    const remapped = source ? (remap.get(source) || source) : undefined;
    return new ExtrudeTwoDistances(this.distance1, this.distance2, remapped).syncWith(this);
  }

  compareTo(other: ExtrudeTwoDistances): boolean {
    if (!(other instanceof ExtrudeTwoDistances)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.distance1 !== other.distance1 || this.distance2 !== other.distance2) {
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

    return true;
  }

  getUniqueType(): string {
    if (this._operationMode === 'remove') {
      return 'cut';
    }
    return 'extrude-by-two-distance';
  }

  serialize() {
    return {
      extrudable: this.getSource()?.serialize(),
      distance1: this.distance1,
      distance2: this.distance2,
      operationMode: this._operationMode !== 'add' ? this._operationMode : undefined,
      thin: this._thin,
      ...this.serializePickFields(),
    }
  }
}
