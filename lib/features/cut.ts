import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { ExtrudeThroughAll } from "./infinite-extrude.js";
import { Shape, Solid } from "../common/shapes.js";
import { ExtrudeOptions } from "./extrude-options.js";
import { Sketch } from "./2d/sketch.js";
import { FaceMaker } from "../core/2d/face-maker.js";
import { Extruder } from "./simple-extruder.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { Extrudable } from "../helpers/types.js";
import { LazySceneObject } from "./lazy-scene-object.js";
import { Edge } from "../common/edge.js";
import { CutBase } from "./cut-base.js";

export class Cut extends CutBase {

  constructor(public distance: number, extrudable?: Extrudable) {
    super(extrudable);
  }

  build(context: BuildSceneObjectContext) {
    let sceneObjects: Map<SceneObject, Shape[]>;

    sceneObjects = new Map<SceneObject, Shape[]>();
    for (const obj of context.getSceneObjects()) {
      const shapes = obj.getShapes({ excludeMeta: false }, 'solid');
      if (shapes.length === 0) {
        continue;
      }

      sceneObjects.set(obj, shapes);
    }

    console.log('Cut: Scene objects for cut:', Array.from(sceneObjects.keys()).map(o => o.getType()));

    let distance = this.distance === 0 ? 0 : -this.distance;

    let extrusionShapes: Shape[] = [];
    const isThroughAll = this.distance === 0;

    if (isThroughAll) {
      const extrudeThroughAll = new ExtrudeThroughAll(this.extrudable, false, true);
      extrusionShapes = extrudeThroughAll.build();
    }
    else {
      const wires = this.extrudable.getGeometries();
      const faces = FaceMaker.getFaces(wires, this.extrudable.getPlane());
      const plane = this.extrudable.getPlane();
      const extruder = new Extruder(faces, plane, distance, this.getDraft(), this.getEndOffset());
      extrusionShapes = extruder.extrude();
    }

    this.extrudable.removeShapes(this);

    const shapeObjectMap = new Map<Shape, SceneObject>();
    for (const [obj, shapes] of sceneObjects) {
      for (const shape of shapes) {
        shapeObjectMap.set(shape, obj);
      }
    }

    const stock = Array.from(shapeObjectMap.keys());
    console.log('Cut: Stock shapes count:', stock.length);
    const toBeRemoved = extrusionShapes;

    console.log('Cut: Stock shapes count:', stock.length);
    console.log('Cut: To be removed shapes count:', toBeRemoved.length);

    const cutResult = BooleanOps.cutMultiShape(stock, toBeRemoved, this.extrudable.getPlane(), this.distance);

    for (const shape of stock) {
      const list = cutResult.modified(shape);
      console.log('Cut: Modified shapes for shape:', list.length);
      if (list.length) {
        for (const newShape of list) {
          const s = ShapeOps.cleanShape(newShape) as Solid;
          console.log('Cut: Adding modified shape:', s);
          this.addShape(s);
        }

        const obj = shapeObjectMap.get(shape);
        obj.removeShape(shape, this);
      }
      console.log('Cut: Shape modified count:', list.length);
    }

    this.setState('section-edges', cutResult.sectionEdges);
    this.setState('start-edges', cutResult.startEdges);
    this.setState('end-edges', cutResult.endEdges);
    this.setState('internal-edges', cutResult.internalEdges);
  }

  override getDependencies(): SceneObject[] {
    return this.extrudable ? [this.extrudable] : [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const extrudable = this.extrudable
      ? (remap.get(this.extrudable) || this.extrudable) as Extrudable
      : undefined;
    return new Cut(this.distance, extrudable).syncWith(this);
  }

  compareTo(other: Cut): boolean {
    if (!(other instanceof Cut)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.distance !== other.distance) {
      return false;
    }

    return true;
  }

  edges(...indices: number[]): SceneObject {
    const suffix = indices.length > 0 ? `section-edges-${indices.join('-')}` : 'section-edges';
    return new LazySceneObject(`${this.getOrder()}-cut-${suffix}`,
      () => {
        const edges = this.getState('section-edges') as Edge[] || [];
        if (indices.length === 0) { return edges; }
        return indices.filter(i => i >= 0 && i < edges.length).map(i => edges[i]);
      });
  }

  startEdges(...indices: number[]): SceneObject {
    const suffix = indices.length > 0 ? `start-edges-${indices.join('-')}` : 'start-edges';
    return new LazySceneObject(`${this.getOrder()}-cut-${suffix}`,
      () => {
        const edges = this.getState('start-edges') as Edge[] || [];
        if (indices.length === 0) { return edges; }
        return indices.filter(i => i >= 0 && i < edges.length).map(i => edges[i]);
      });
  }

  endEdges(...indices: number[]): SceneObject {
    const suffix = indices.length > 0 ? `end-edges-${indices.join('-')}` : 'end-edges';
    return new LazySceneObject(`${this.getOrder()}-cut-${suffix}`,
      () => {
        const edges = this.getState('end-edges') as Edge[] || [];
        if (indices.length === 0) { return edges; }
        return indices.filter(i => i >= 0 && i < edges.length).map(i => edges[i]);
      });
  }

  internalEdges(...indices: number[]): SceneObject {
    const suffix = indices.length > 0 ? `internal-edges-${indices.join('-')}` : 'internal-edges';
    return new LazySceneObject(`${this.getOrder()}-cut-${suffix}`,
      () => {
        const edges = this.getState('internal-edges') as Edge[] || [];
        if (indices.length === 0) { return edges; }
        return indices.filter(i => i >= 0 && i < edges.length).map(i => edges[i]);
      });
  }

  serialize() {
    return {
      extrudable: this.extrudable.serialize(),
      distance: this.distance,
      draft: this.getDraft(),
      endOffset: this.getEndOffset(),
      fusionScope: this.getFusionScope(),
    }
  }
}
