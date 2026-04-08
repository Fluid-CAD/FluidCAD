import { Point2D } from "../../math/point.js";
import { Sketch } from "./sketch.js";
import { Geometry } from "../../oc/geometry.js";
import { SceneObject } from "../../common/scene-object.js";
import { Edge } from "../../common/edge.js";
import { Vertex } from "../../common/vertex.js";
import { LazySelectionSceneObject } from "../lazy-scene-object.js";
import { LazyVertex } from "../lazy-vertex.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { ExtrudableGeometryBase } from "./extrudable-base.js";
import { IPolygon } from "../../core/interfaces.js";

export type PolygonMode = 'inscribed' | 'circumscribed';

export class Polygon extends ExtrudableGeometryBase implements IPolygon {
  constructor(
    public numberOfSides: number,
    public diameter: number,
    public mode: PolygonMode,
    targetPlane: PlaneObjectBase = null,
  ) {
    super(targetPlane);

    if (numberOfSides < 3) {
      throw new Error("Polygon must have at least 3 sides");
    }
  }

  getType() {
    return 'polygon';
  }

  build(): void {
    const plane = this.targetPlane?.getPlane() || (this.getParent() as Sketch).getPlane();
    const center = this.targetPlane
      ? plane.worldToLocal(this.targetPlane.getPlaneCenter())
      : this.getCurrentPosition();

    const radius = this.diameter / 2;
    let effectiveRadius = radius;
    if (this.mode === 'circumscribed') {
      effectiveRadius = radius / Math.cos(Math.PI / this.numberOfSides);
    }

    const vertices: Point2D[] = [];
    for (let i = 0; i < this.numberOfSides; i++) {
      const angle = (2 * Math.PI * i) / this.numberOfSides;
      vertices.push(Geometry.getPointOnCircle(center, effectiveRadius, angle));
    }

    const edges: Edge[] = [];
    for (let i = 0; i < this.numberOfSides; i++) {
      const from = vertices[i];
      const to = vertices[(i + 1) % this.numberOfSides];
      const segment = Geometry.makeSegment(
        plane.localToWorld(from),
        plane.localToWorld(to),
      );
      const edge = Geometry.makeEdge(segment);
      edges.push(edge);
      this.setState(`edge-${i}`, edge);
    }

    this.addShapes(edges);

    const baseCircle = Geometry.makeCircle(plane.localToWorld(center), radius, plane.normal);
    const baseCircleEdge = Geometry.makeEdgeFromCircle(baseCircle);
    baseCircleEdge.markAsMetaShape();
    this.addShape(baseCircleEdge);

    if (this.sketch) {
      this.setCurrentPosition(center);
    }

    if (this.targetPlane) {
      this.targetPlane.removeShapes(this);
    }
  }

  override getDependencies(): SceneObject[] {
    return this.targetPlane ? [this.targetPlane] : [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const targetPlane = this.targetPlane ? (remap.get(this.targetPlane) as PlaneObjectBase || this.targetPlane) : null;
    return new Polygon(this.numberOfSides, this.diameter, this.mode, targetPlane);
  }

  compareTo(other: this): boolean {
    if (!(other instanceof Polygon)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.targetPlane?.constructor !== other.targetPlane?.constructor) {
      return false;
    }

    if (this.targetPlane && other.targetPlane && !this.targetPlane.compareTo(other.targetPlane)) {
      return false;
    }

    return this.numberOfSides === other.numberOfSides
      && this.diameter === other.diameter
      && this.mode === other.mode;
  }

  getEdge(index: number): LazySelectionSceneObject {
    return new LazySelectionSceneObject(this.generateUniqueName(`edge-${index}`), (parent) => {
      const edge = parent.getState(`edge-${index}`) as Edge;
      return edge ? [edge] : [];
    }, this);
  }

  getVertex(index: number): LazyVertex {
    return new LazyVertex(this.generateUniqueName(`vertex-${index}`), () => {
      const edge = this.getState(`edge-${index}`) as Edge;
      if (!edge) {
        return [];
      }
      const plane = this.sketch.getPlane();
      const vertex = edge.getFirstVertex();
      const localPos = plane.worldToLocal(vertex.toPoint());
      return [Vertex.fromPoint2D(localPos)];
    });
  }

  serialize() {
    return {
      numberOfSides: this.numberOfSides,
      diameter: this.diameter,
      mode: this.mode,
    };
  }
}
