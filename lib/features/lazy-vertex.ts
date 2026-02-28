import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Vertex } from "../common/vertex.js";

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

  override getShapes(excludeMetaShape?: boolean, type?: string): Shape[] {
    if (this._isBuilt) {
      return super.getShapes(excludeMetaShape, type);
    }

    this.build();
    this._isBuilt = true;
    const shapes = super.getShapes(excludeMetaShape, type);
    return shapes;
  }

  asPoint() {
    const vertex = this.getShapes(false, 'vertex')[0] as Vertex;
    return vertex.toPoint();
  }

  asPoint2D() {
    const vertex = this.getShapes(false, 'vertex')[0] as Vertex;
    return vertex.toPoint2D();
  }

  reverse() {
    return new LazyVertex(this.generateUniqueName('reversed'), () =>  {
      const v = this.getShapes(false, 'vertex')[0] as Vertex;
      return [v.reverse()];
    });
  }

  static fromVertex(vertex: Vertex) {
    const point = vertex.toPoint();
    const uniqueName = `lazy-vertex-${point.x}-${point.y}-${point.z}`;
    return new LazyVertex(uniqueName, () => [vertex]);
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
}
