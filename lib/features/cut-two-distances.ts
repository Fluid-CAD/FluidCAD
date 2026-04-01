import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Shape, Solid } from "../common/shapes.js";
import { Extruder } from "./simple-extruder.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { Extrudable } from "../helpers/types.js";
import { LazySceneObject } from "./lazy-scene-object.js";
import { Edge } from "../common/edge.js";
import { CutBase } from "./cut-base.js";
import { FaceMaker2 } from "../oc/face-maker2.js";

export class CutTwoDistances extends CutBase {

  constructor(
    public distance1: number,
    public distance2: number,
    extrudable?: Extrudable) {

    super(extrudable);
  }

  build(context: BuildSceneObjectContext) {
    const plane = this.extrudable.getPlane();

    const pickedFaces = this.resolvePickedFaces(plane);
    if (pickedFaces !== null && pickedFaces.length === 0) {
      return;
    }

    let scope = context.getSceneObjects();

    if (this.getFusionScope() === 'none') {
      scope = [];
    } else if (this.getFusionScope() instanceof SceneObject) {
      scope = [this.getFusionScope() as SceneObject];
    } else if (Array.isArray(this.getFusionScope())) {
      scope = this.getFusionScope() as SceneObject[];
    }

    const sceneObjects = new Map<SceneObject, Shape[]>();
    for (const obj of scope) {
      const shapes = obj.getShapes({}, 'solid');
      if (shapes.length === 0) {
        continue;
      }
      sceneObjects.set(obj, shapes);
    }

    const faces = pickedFaces ?? FaceMaker2.getRegions(this.extrudable.getGeometries(), plane);

    const extruder1 = new Extruder(faces, plane, this.distance1, this.getDraft(), this.getEndOffset());
    const extrusions1 = extruder1.extrude();

    const extruder2 = new Extruder(faces, plane, -this.distance2, this.getDraft(), this.getEndOffset());
    const extrusions2 = extruder2.extrude();

    const all = [...extrusions1, ...extrusions2];
    const { result: toolShapes } = BooleanOps.fuse(all);

    this.extrudable.removeShapes(this);

    const shapeObjectMap = new Map<Shape, SceneObject>();
    for (const [obj, shapes] of sceneObjects) {
      for (const shape of shapes) {
        shapeObjectMap.set(shape, obj);
      }
    }

    const stock = Array.from(shapeObjectMap.keys());
    const cutResult = BooleanOps.cutMultiShape(stock, toolShapes, plane, this.distance1);

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

  override getDependencies(): SceneObject[] {
    return this.extrudable ? [this.extrudable] : [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const extrudable = this.extrudable
      ? (remap.get(this.extrudable) || this.extrudable) as Extrudable
      : undefined;
    return new CutTwoDistances(this.distance1, this.distance2, extrudable).syncWith(this);
  }

  compareTo(other: CutTwoDistances): boolean {
    if (!(other instanceof CutTwoDistances)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.distance1 !== other.distance1 || this.distance2 !== other.distance2) {
      return false;
    }

    return true;
  }

  edges(...indices: number[]): SceneObject {
    const suffix = indices.length > 0 ? `section-edges-${indices.join('-')}` : 'section-edges';
    return new LazySceneObject(`${this.getOrder()}-cut-two-distances-${suffix}`,
      () => {
        const edges = this.getState('section-edges') as Edge[] || [];
        if (indices.length === 0) { return edges; }
        return indices.filter(i => i >= 0 && i < edges.length).map(i => edges[i]);
      });
  }

  startEdges(...indices: number[]): SceneObject {
    const suffix = indices.length > 0 ? `start-edges-${indices.join('-')}` : 'start-edges';
    return new LazySceneObject(`${this.getOrder()}-cut-two-distances-${suffix}`,
      () => {
        const edges = this.getState('start-edges') as Edge[] || [];
        if (indices.length === 0) { return edges; }
        return indices.filter(i => i >= 0 && i < edges.length).map(i => edges[i]);
      });
  }

  endEdges(...indices: number[]): SceneObject {
    const suffix = indices.length > 0 ? `end-edges-${indices.join('-')}` : 'end-edges';
    return new LazySceneObject(`${this.getOrder()}-cut-two-distances-${suffix}`,
      () => {
        const edges = this.getState('end-edges') as Edge[] || [];
        if (indices.length === 0) { return edges; }
        return indices.filter(i => i >= 0 && i < edges.length).map(i => edges[i]);
      });
  }

  getUniqueType(): string {
    return 'cut-by-two-distances';
  }

  serialize() {
    return {
      extrudable: this.extrudable.serialize(),
      distance1: this.distance1,
      distance2: this.distance2,
      draft: this.getDraft(),
      endOffset: this.getEndOffset(),
      fusionScope: this.getFusionScope(),
      picking: this.isPicking() || undefined,
      pickPoints: this.isPicking()
        ? this._pickPoints.map(p => { const pt = p.asPoint2D(); return [pt.x, pt.y]; })
        : undefined,
    }
  }
}
