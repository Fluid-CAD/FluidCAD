import { SceneObject } from "../common/scene-object.js";
import { Sketch } from "../features/2d/sketch.js";

/**
 * The two questions that decide what a pick of a curve or of a surface
 * takes: a click on an edge of a curve producer means the whole object, and
 * so does a click on a face of an object that holds a surface, while an edge
 * or a face of a solid is taken by itself.
 *
 * They are asked of what an object holds, never of its type, so a tool that
 * leaves a curve or a surface is known for it without being listed anywhere.
 *
 * `scope` reads the object as a render of those objects would (see
 * `SceneObject.getShapes`): pass the objects before a statement to ask the
 * question as that statement's arguments see it, before the statement took
 * or hid anything. Without it the object is read as a feature reads it now:
 * a curve its consumer only hid still counts, one a feature consumed does
 * not.
 */
export class Producers {

  /**
   * Whether `obj` stands in the scene as a curve of its own: a helix, a
   * curve tool's result, an imported curve, a repeat of one. Everything it
   * holds is an edge or a wire, and it holds at least one.
   *
   * A sketch is a curve producer while it holds an edge, whatever else it
   * holds (points). The geometry inside a sketch is not: a line of a sketch
   * is part of its sketch. Nor is a selection or a lazy accessor, which
   * names edges another object holds.
   */
  static isCurveProducer(obj: SceneObject, scope?: Set<SceneObject>): boolean {
    if (!Producers.ownsGeometry(obj) || Producers.insideSketch(obj)) {
      return false;
    }
    const shapes = obj.getShapes(undefined, undefined, scope);
    const curves = shapes.filter(shape => shape.isEdge() || shape.isWire());
    if (obj instanceof Sketch) {
      return curves.length > 0;
    }
    return curves.length > 0 && curves.length === shapes.length;
  }

  /**
   * Whether `obj` holds at least one surface: a surface tool's result, an
   * imported surface, a part or a repeat with one inside. It may hold solids
   * and curves beside it.
   */
  static holdsSurface(obj: SceneObject, scope?: Set<SceneObject>): boolean {
    if (!Producers.ownsGeometry(obj)) {
      return false;
    }
    return obj.getShapes(undefined, undefined, scope).some(shape => shape.isSheet());
  }

  /** A selection and a lazy accessor name what other objects hold. */
  private static ownsGeometry(obj: SceneObject): boolean {
    return !obj.isLazy() && !obj.isSelection();
  }

  private static insideSketch(obj: SceneObject): boolean {
    for (let parent = obj.getParent(); parent; parent = parent.getParent()) {
      if (parent instanceof Sketch) {
        return true;
      }
    }
    return false;
  }
}
