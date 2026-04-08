import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Explorer } from "../oc/explorer.js";
import { LoftOps } from "../oc/loft-ops.js";
import { Wire } from "../common/wire.js";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { Shape } from "../common/shape.js";
import { Extrudable } from "../helpers/types.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { LazySelectionSceneObject } from "./lazy-scene-object.js";
import { FaceFilterBuilder } from "../filters/face/face-filter.js";
import { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";
import { ShapeFilter } from "../filters/filter.js";
import { Matrix4 } from "../math/matrix4.js";
import { FaceOps } from "../oc/face-ops.js";
import { Plane } from "../math/plane.js";
import { ILoft } from "../core/interfaces.js";

export class Loft extends SceneObject implements ILoft {
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

    const allWires: Wire[] = [];

    for (const profile of this.profiles) {
      const wires = this.getWiresFromSceneObject(profile);

      if (wires.length === 0) {
        throw new Error("Could not extract wire from profile.");
      }

      for (const wire of wires) {
        allWires.push(wire);
      }
    }

    const newShapes = LoftOps.makeLoft(allWires);

    for (const profile of this.profiles) {
      profile.removeShapes(this);
    }

    this.addShapes(newShapes);

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
  }

  private getProfilePlane(profile: SceneObject): Plane | null {
    if ('getPlane' in profile && typeof (profile as any).getPlane === 'function') {
      return (profile as Extrudable).getPlane();
    }
    return null;
  }

  startFaces(...args: (number | FaceFilterBuilder)[]): SceneObject {
    const suffix = this.buildSuffix('start-faces', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const faces = parent.getState('start-faces') as Face[] || [];
        const transform = parent.getTransform();
        const originalFaces = transform
          ? (this.getState('start-faces') as Face[] || [])
          : null;
        return this.resolveFaces(faces, args, transform, originalFaces);
      }, this);
  }

  endFaces(...args: (number | FaceFilterBuilder)[]): SceneObject {
    const suffix = this.buildSuffix('end-faces', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const faces = parent.getState('end-faces') as Face[] || [];
        const transform = parent.getTransform();
        const originalFaces = transform
          ? (this.getState('end-faces') as Face[] || [])
          : null;
        return this.resolveFaces(faces, args, transform, originalFaces);
      }, this);
  }

  sideFaces(...args: (number | FaceFilterBuilder)[]): SceneObject {
    const suffix = this.buildSuffix('side-faces', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const faces = parent.getState('side-faces') as Face[] || [];
        const transform = parent.getTransform();
        const originalFaces = transform
          ? (this.getState('side-faces') as Face[] || [])
          : null;
        return this.resolveFaces(faces, args, transform, originalFaces);
      }, this);
  }

  startEdges(...args: (number | EdgeFilterBuilder)[]): SceneObject {
    const suffix = this.buildSuffix('start-edges', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const faces = parent.getState('start-faces') as Face[] || [];
        const edges = faces.flatMap(f => f.getEdges());
        const transform = parent.getTransform();
        const originalEdges = transform
          ? (this.getState('start-faces') as Face[] || []).flatMap(f => f.getEdges())
          : null;
        return this.resolveEdges(edges, args, transform, originalEdges);
      }, this);
  }

  endEdges(...args: (number | EdgeFilterBuilder)[]): SceneObject {
    const suffix = this.buildSuffix('end-edges', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const faces = parent.getState('end-faces') as Face[] || [];
        const edges = faces.flatMap(f => f.getEdges());
        const transform = parent.getTransform();
        const originalEdges = transform
          ? (this.getState('end-faces') as Face[] || []).flatMap(f => f.getEdges())
          : null;
        return this.resolveEdges(edges, args, transform, originalEdges);
      }, this);
  }

  sideEdges(...args: (number | EdgeFilterBuilder)[]): SceneObject {
    const suffix = this.buildSuffix('side-edges', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const sideFaces = parent.getState('side-faces') as Face[] || [];
        const startFaces = parent.getState('start-faces') as Face[] || [];
        const endFaces = parent.getState('end-faces') as Face[] || [];
        const excludedEdges = [...startFaces, ...endFaces].flatMap(f => f.getEdges());
        const edges = sideFaces.flatMap(f => f.getEdges())
          .filter(e => !excludedEdges.some(ex => e.getShape().IsSame(ex.getShape())));
        return this.resolveEdges(edges, args);
      }, this);
  }

  private buildSuffix(prefix: string, args: any[]): string {
    if (args.length === 0) {
      return prefix;
    }
    const key = args.map(a => typeof a === 'number' ? a : 'f').join('-');
    return `${prefix}-${key}`;
  }

  private resolveEdges(shapes: Edge[], args: (number | EdgeFilterBuilder)[],
                       transform: Matrix4 = null, originalShapes: Edge[] = null): Edge[] {
    if (args.length === 0) {
      return shapes;
    }

    if (args.every(a => typeof a === 'number')) {
      const indices = args as number[];
      let filters = indices.map(i => new EdgeFilterBuilder().atIndex(i, shapes, originalShapes));
      if (transform) {
        filters = filters.map(f => f.transform(transform) as EdgeFilterBuilder);
      }
      return new ShapeFilter(shapes, ...filters).apply() as Edge[];
    }

    let filters = args.filter(a => a instanceof EdgeFilterBuilder) as EdgeFilterBuilder[];
    if (transform) {
      filters = filters.map(f => f.transform(transform) as EdgeFilterBuilder);
    }
    return new ShapeFilter(shapes as any, ...filters).apply() as Edge[];
  }

  private resolveFaces(shapes: Face[], args: (number | FaceFilterBuilder)[],
                       transform: Matrix4 = null, originalShapes: Face[] = null): Face[] {
    if (args.length === 0) {
      return shapes;
    }

    if (args.every(a => typeof a === 'number')) {
      const indices = args as number[];
      let filters = indices.map(i => new FaceFilterBuilder().atIndex(i, shapes, originalShapes));
      if (transform) {
        filters = filters.map(f => f.transform(transform) as FaceFilterBuilder);
      }
      return new ShapeFilter(shapes, ...filters).apply() as Face[];
    }

    let filters = args.filter(a => a instanceof FaceFilterBuilder) as FaceFilterBuilder[];
    if (transform) {
      filters = filters.map(f => f.transform(transform) as FaceFilterBuilder);
    }
    return new ShapeFilter(shapes as any, ...filters).apply() as Face[];
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
    }
  }
}
