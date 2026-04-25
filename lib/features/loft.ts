import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Explorer } from "../oc/explorer.js";
import { LoftOps } from "../oc/loft-ops.js";
import { Wire } from "../common/wire.js";
import { Face } from "../common/face.js";
import { Extrudable } from "../helpers/types.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { FaceOps } from "../oc/face-ops.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { Plane } from "../math/plane.js";
import { ILoft } from "../core/interfaces.js";
import { fuseWithSceneObjects, cutWithSceneObjects } from "../helpers/scene-helpers.js";
import { ExtrudeBase } from "./extrude-base.js";
import { ThinFaceMaker } from "../oc/thin-face-maker.js";
import { Shape } from "../common/shape.js";

export class Loft extends ExtrudeBase implements ILoft {
  private _profiles: SceneObject[] = [];

  constructor(...profiles: SceneObject[]) {
    super();
    this._profiles = profiles;
  }

  get profiles(): SceneObject[] {
    return this._profiles;
  }

  build(context: BuildSceneObjectContext) {
    if (this.profiles.length < 2) {
      throw new Error("Loft requires at least two profiles.");
    }

    const p = context.getProfiler();
    let newShapes: Shape[];

    if (this.isThin()) {
      newShapes = p.record('Build thin loft', () => this.buildThinLoft());
    } else {
      const allWires: Wire[] = [];

      for (const profile of this.profiles) {
        const wires = p.record('Get profile wires', () => this.getWiresFromSceneObject(profile));

        if (wires.length === 0) {
          throw new Error("Could not extract wire from profile.");
        }

        for (const wire of wires) {
          allWires.push(wire);
        }
      }

      newShapes = p.record('Make loft', () => LoftOps.makeLoft(allWires));
    }

    for (const profile of this.profiles) {
      profile.removeShapes(this);
    }

    // Classify faces into start/end/side using profile planes
    const firstPlane = this.getProfilePlane(this.profiles[0]);
    const lastPlane = this.getProfilePlane(this.profiles[this.profiles.length - 1]);

    const startFaces: Face[] = [];
    const endFaces: Face[] = [];
    const sideFaces: Face[] = [];

    for (const shape of newShapes) {
      const faces = Explorer.findFacesWrapped(shape);
      for (const f of faces) {
        if (firstPlane && FaceOps.faceOnPlaneWrapped(f as Face, firstPlane)) {
          startFaces.push(f as Face);
        } else if (lastPlane && FaceOps.faceOnPlaneWrapped(f as Face, lastPlane)) {
          endFaces.push(f as Face);
        } else {
          sideFaces.push(f as Face);
        }
      }
    }

    this.setState('start-faces', startFaces);
    this.setState('end-faces', endFaces);
    this.setState('side-faces', sideFaces);

    // Handle boolean operation based on operation mode
    if (this._operationMode === 'remove') {
      const scope = p.record('Resolve fusion scope', () => this.resolveFusionScope(context.getSceneObjects()));
      const plane = firstPlane || lastPlane;
      p.record('Cut with scene objects', () => {
        cutWithSceneObjects(scope, newShapes, plane, 0, this, { recordHistoryFor: this });
      });
      this.setFinalShapes(this.getShapes());
      return;
    }

    const sceneObjects = p.record('Resolve fusion scope', () => this.resolveFusionScope(context.getSceneObjects()));

    if (sceneObjects.length === 0) {
      this.addShapes(newShapes);
      this.recordShapeFacesAndEdgesAsAdditions(newShapes);
      this.classifyExtrudeEdges();
      this.setFinalShapes(this.getShapes());
      return;
    }

    const fusionResult = p.record('Fuse with scene objects', () => fuseWithSceneObjects(sceneObjects, newShapes, {
      recordHistoryFor: this,
    }));

    for (const modifiedShape of fusionResult.modifiedShapes) {
      if (modifiedShape.object) {
        modifiedShape.object.removeShape(modifiedShape.shape, this);
      }
    }

    this.addShapes(fusionResult.newShapes);

    if (fusionResult.toolHistory) {
      this.remapClassifiedFaces(fusionResult.toolHistory);
    }
    this.classifyExtrudeEdges();
    this.setFinalShapes(this.getShapes());
  }

  private buildThinLoft(): Shape[] {
    const outerWires: Wire[] = [];
    const innerWires: Wire[] = [];

    for (const profile of this.profiles) {
      if (!profile.isExtrudable()) {
        throw new Error("Thin loft requires all profiles to be sketches.");
      }
      const extrudable = profile as unknown as Extrudable;
      const profilePlane = extrudable.getPlane();
      const thinResult = ThinFaceMaker.make(
        extrudable.getGeometries(), profilePlane, this._thin[0], this._thin[1]
      );
      for (const face of thinResult.faces) {
        const wires = face.getWires();
        outerWires.push(wires[0]);
        if (wires.length > 1) {
          innerWires.push(wires[1]);
        }
      }
    }

    const outerSolids = LoftOps.makeLoft(outerWires);

    if (innerWires.length > 0 && innerWires.length === outerWires.length) {
      const innerSolids = LoftOps.makeLoft(innerWires);
      const outerFuse = BooleanOps.fuse(outerSolids);
      const innerFuse = BooleanOps.fuse(innerSolids);
      const cutResult = BooleanOps.cutShapes(outerFuse.result[0], innerFuse.result[0]);
      outerFuse.dispose();
      innerFuse.dispose();
      return [cutResult];
    }

    return outerSolids;
  }

  private getProfilePlane(profile: SceneObject): Plane | null {
    if ('getPlane' in profile && typeof (profile as any).getPlane === 'function') {
      return (profile as Extrudable).getPlane();
    }
    return null;
  }

  private getWiresFromSceneObject(obj: SceneObject): Wire[] {
    const shapes = obj.getShapes({ excludeMeta: false });

    // If shapes are faces, extract their outer wires
    const faceShapes = shapes.filter(s => s.isFace()) as Face[];
    if (faceShapes.length > 0) {
      const wires: Wire[] = [];
      for (const face of faceShapes) {
        const faceWires = face.getWires();
        if (faceWires.length > 0) {
          wires.push(faceWires[0]); // outer wire
        }
      }
      return wires;
    }

    // If shapes are wires directly
    const wireShapes = shapes.filter(s => s.isWire()) as Wire[];
    if (wireShapes.length > 0) {
      return wireShapes;
    }

    // If it's an extrudable (sketch), get geometries and make faces to get wires
    if ('getGeometries' in obj && 'getPlane' in obj) {
      const extrudable = obj as unknown as Extrudable;
      const geometries = extrudable.getGeometries();
      const plane = extrudable.getPlane();
      const faces = FaceMaker2.getRegions(geometries, plane);
      const wires: Wire[] = [];
      for (const face of faces) {
        const faceWires = face.getWires();
        if (faceWires.length > 0) {
          wires.push(faceWires[0]);
        }
      }
      return wires;
    }

    // Try to extract wires from solid shapes
    const solidShapes = shapes.filter(s => s.isSolid());
    if (solidShapes.length > 0) {
      const wires: Wire[] = [];
      for (const solid of solidShapes) {
        const solidWires = Explorer.findWiresWrapped(solid);
        if (solidWires.length > 0) {
          wires.push(solidWires[0]);
        }
      }
      return wires;
    }

    return [];
  }

  override getDependencies(): SceneObject[] {
    return [...this._profiles];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const profiles = this._profiles.map(p => remap.get(p) || p);
    return new Loft(...profiles).syncWith(this);
  }

  compareTo(other: Loft): boolean {
    if (!(other instanceof Loft)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.profiles.length !== other.profiles.length) {
      return false;
    }

    for (let i = 0; i < this.profiles.length; i++) {
      if (!this.profiles[i].compareTo(other.profiles[i])) {
        return false;
      }
    }

    return true;
  }

  getType(): string {
    return "loft";
  }

  serialize() {
    return {
      profiles: this.profiles.map(f => f.serialize()),
      operationMode: this._operationMode !== 'add' ? this._operationMode : undefined,
      thin: this._thin,
    }
  }
}
