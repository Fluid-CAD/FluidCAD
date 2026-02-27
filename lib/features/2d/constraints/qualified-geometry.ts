import { Comparable, SceneObject } from "../../../common/scene-object.js";

export type ConstraintQualifier = 'unqualified' | 'outside' | 'enclosed' | 'enclosing';

export class QualifiedGeometry implements Comparable<QualifiedGeometry> {
  constructor(public object: SceneObject, public qualifier: ConstraintQualifier) {
  }

  compareTo(other: QualifiedGeometry) {
    return this.qualifier === other.qualifier && this.object.compareTo(other.object);
  }
}
