import { SceneObject } from "../common/scene-object.js";
import { Shape, ShapeFilter } from "../common/shape.js";
import { Vertex } from "../common/vertex.js";
import { Plane } from "../math/plane.js";

export class LazyVertex extends SceneObject {

  private _isBuilt: boolean = false;

  constructor(private uniqueName: string, private getShapesFn: () => Shape[]) {
    super();
  }

  build() {
    const shapes = this.getShapesFn();
    if (shapes.length === 0) {
      throw new Error(`LazyVertex::build - getShapesFn returned empty array for uniqueName: ${this.uniqueName}`);
    }

    if (shapes.length > 1) {
      throw new Error(`LazyVertex::build - getShapesFn returned more than one shape for uniqueName: ${this.uniqueName}`);
    }

    this.addShapes(shapes);
  }

  override getShapes(filter?: ShapeFilter, type?: string): Shape[] {
    if (this._isBuilt) {
      return super.getShapes(filter, type);
    }

    this.build();
    this._isBuilt = true;
    const shapes = super.getShapes(filter, type);
    return shapes;
  }

  asPoint() {
    const vertex = this.getShapes({ excludeMeta: false }, 'vertex')[0] as Vertex;
    return vertex.toPoint();
  }

  asPoint2D() {
    const vertex = this.getShapes({ excludeMeta: false }, 'vertex')[0] as Vertex;
    return vertex.toPoint2D();
  }

  reverse() {
    return new LazyVertex(`${this.uniqueName}-reversed`, () => {
      const vertex = this.getShapes({ excludeMeta: false }, 'vertex')[0] as Vertex;
      const point = vertex.toPoint();
      const reversedPoint = point.negate()
      const reversedVertex = Vertex.fromPoint(reversedPoint);
      return [reversedVertex];
    });
  }

  compareTo(other: LazyVertex): boolean {
    return super.compareTo(other) && this.uniqueName === other.uniqueName;
  }

  getType(): string {
    return "lazy-vertex";
  }

  serialize() {
    return {
    }
  }

  static fromVertex(vertex: Vertex) {
    const point = vertex.toPoint();
    const uniqueName = `lazy-vertex-${point.x}-${point.y}-${point.z}`;
    return new LazyVertex(uniqueName, () => [vertex]);
  }
}
