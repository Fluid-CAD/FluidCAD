import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Shape, Solid } from "../common/shapes.js";
import { CutOptions } from "./cut.js";
import { Sketch } from "./2d/sketch.js";
import { FaceMaker } from "../core/2d/face-maker.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { ExtrudeOps } from "../oc/extrude-ops.js";
import { Extrudable } from "../helpers/types.js";
import { LazySceneObject } from "./lazy-scene-object.js";
import { Edge } from "../common/edge.js";

export class CutSymmetric extends SceneObject {

  constructor(
    private extrudable: Extrudable,
    public distance: number,
    public options: CutOptions = {}) {
    super();
  }

  build(context: BuildSceneObjectContext) {
    const sceneObjects = new Map<SceneObject, Shape[]>();
    for (const obj of context.getSceneObjects()) {
      const shapes = obj.getShapes(false, 'solid');
      if (shapes.length === 0) {
        continue;
      }
      sceneObjects.set(obj, shapes);
    }

    const wires = this.extrudable.getGeometries();
    const faces = FaceMaker.getFaces(wires, this.extrudable.getPlane());
    const plane = this.extrudable.getPlane();

    const vec = plane.normal.multiply(this.distance);
    const translateVec = vec.multiply(-0.5);

    const toolShapes: Shape[] = [];
    for (const face of faces) {
      const { solid: rawSolid } = ExtrudeOps.makePrismFromVec(face, vec);
      const solid = ShapeOps.translateShape(ShapeOps.cleanShape(rawSolid), translateVec);
      toolShapes.push(solid);
    }

    this.extrudable.removeShapes(this);

    const shapeObjectMap = new Map<Shape, SceneObject>();
    for (const [obj, shapes] of sceneObjects) {
      for (const shape of shapes) {
        shapeObjectMap.set(shape, obj);
      }
    }

    const stock = Array.from(shapeObjectMap.keys());
    const cutResult = BooleanOps.cutMultiShape(stock, toolShapes, plane, this.distance);

    for (const shape of stock) {
      const list = cutResult.modified(shape);
      if (list.length) {
        for (const newShape of list) {
          const s = ShapeOps.cleanShape(newShape) as Solid;
          this.addShape(s);
        }

        const obj = shapeObjectMap.get(shape);
        obj.removeShape(shape, this);
      }
    }

    this.setState('section-edges', cutResult.sectionEdges);
    this.setState('start-edges', cutResult.startEdges);
    this.setState('end-edges', cutResult.endEdges);
    this.setState('internal-edges', cutResult.internalEdges);
  }

  override clone(): SceneObject[] {
    const extrudableClone = this.extrudable.clone();
    const extrudable = extrudableClone.find(c => c instanceof Sketch) as Sketch;
    const clone = new CutSymmetric(extrudable, this.distance, this.options);
    return [...extrudableClone, clone];
  }

  compareTo(other: CutSymmetric): boolean {
    if (!(other instanceof CutSymmetric)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.distance !== other.distance) {
      return false;
    }

    if (JSON.stringify(this.options || {}) !== JSON.stringify(other.options || {})) {
      return false;
    }

    return true;
  }

  edges(...indices: number[]): SceneObject {
    const suffix = indices.length > 0 ? `section-edges-${indices.join('-')}` : 'section-edges';
    return new LazySceneObject(`${this.getOrder()}-cut-symmetric-${suffix}`,
      () => {
        const edges = this.getState('section-edges') as Edge[] || [];
        if (indices.length === 0) { return edges; }
        return indices.filter(i => i >= 0 && i < edges.length).map(i => edges[i]);
      });
  }

  startEdges(...indices: number[]): SceneObject {
    const suffix = indices.length > 0 ? `start-edges-${indices.join('-')}` : 'start-edges';
    return new LazySceneObject(`${this.getOrder()}-cut-symmetric-${suffix}`,
      () => {
        const edges = this.getState('start-edges') as Edge[] || [];
        if (indices.length === 0) { return edges; }
        return indices.filter(i => i >= 0 && i < edges.length).map(i => edges[i]);
      });
  }

  endEdges(...indices: number[]): SceneObject {
    const suffix = indices.length > 0 ? `end-edges-${indices.join('-')}` : 'end-edges';
    return new LazySceneObject(`${this.getOrder()}-cut-symmetric-${suffix}`,
      () => {
        const edges = this.getState('end-edges') as Edge[] || [];
        if (indices.length === 0) { return edges; }
        return indices.filter(i => i >= 0 && i < edges.length).map(i => edges[i]);
      });
  }

  internalEdges(...indices: number[]): SceneObject {
    const suffix = indices.length > 0 ? `internal-edges-${indices.join('-')}` : 'internal-edges';
    return new LazySceneObject(`${this.getOrder()}-cut-symmetric-${suffix}`,
      () => {
        const edges = this.getState('internal-edges') as Edge[] || [];
        if (indices.length === 0) { return edges; }
        return indices.filter(i => i >= 0 && i < edges.length).map(i => edges[i]);
      });
  }

  getType(): string {
    return "cut-symmetric";
  }

  serialize() {
    return {
      extrudable: this.extrudable.serialize(),
      distance: this.distance,
      symmetric: true,
      options: this.options
    }
  }
}
