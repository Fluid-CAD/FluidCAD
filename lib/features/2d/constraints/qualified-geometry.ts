import { Comparable, SceneObject } from "../../../common/scene-object.js";

export type ConstraintQualifier = 'unqualified' | 'outside' | 'enclosed' | 'enclosing';

export class QualifiedGeometry implements Comparable<QualifiedGeometry> {
  constructor(public object: SceneObject, public qualifier: ConstraintQualifier) {
  }

  static from(arg: SceneObject | QualifiedGeometry): QualifiedGeometry {
    if (arg instanceof QualifiedGeometry) {
      return arg;
    }
    return new QualifiedGeometry(arg, 'unqualified');
  }

  compareTo(other: QualifiedGeometry) {
    return this.qualifier === other.qualifier && this.object.compareTo(other.object);
  }
}
