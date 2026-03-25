import { Comparable, SceneObject } from "../../../common/scene-object.js";
import { Shape } from "../../../common/shape.js";
import { Wire } from "../../../common/wire.js";

export type ConstraintQualifier = 'unqualified' | 'outside' | 'enclosed' | 'enclosing';

export class QualifiedSceneObject implements Comparable<QualifiedSceneObject> {
  constructor(public object: SceneObject, public qualifier: ConstraintQualifier) {
  }

  static from(arg: SceneObject | QualifiedSceneObject): QualifiedSceneObject {
    if (arg instanceof QualifiedSceneObject) {
      return arg;
    }

    return new QualifiedSceneObject(arg, 'unqualified');
  }

  compareTo(other: QualifiedSceneObject) {
    return this.qualifier === other.qualifier && this.object.compareTo(other.object);
  }

  toQualifiedShape(): QualifiedShape {
    let shape = this.object.getShapes({ excludeGuide: false })[0]

    if (!shape) {
      throw new Error('At least one shape is required for the tangent line constraint');
    }

    if (shape instanceof Wire) {
      shape = shape.getEdges()[0];
    }

    return new QualifiedShape(shape, this.qualifier);
  }
}

export class QualifiedShape {
  constructor(public shape: Shape, public qualifier: ConstraintQualifier) {
  }
}

