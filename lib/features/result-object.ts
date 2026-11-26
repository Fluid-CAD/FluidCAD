import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { AnchoredLazyVertex } from "./anchored-vertex.js";
import { LazySelectionSceneObject } from "./lazy-scene-object.js";
import { SelectSceneObject } from "./select.js";

/**
 * What the tools that leave a curve or a surface share (`CurveObject`,
 * `SurfaceObject`): how an operand given through a chained method is taken,
 * what the tool reads its face operands against, and what becomes of the
 * operands once the result is built.
 *
 * Such a tool takes what it acts on as arguments and every option as a
 * chained method. The four methods that carry both must cover every operand
 * and every option, or `repeat()`, the build cache and the edit dialog break
 * with nothing failing: `createCopy`, `compareTo`, `getDependencies` and
 * `serialize`.
 */
export abstract class ResultObject extends SceneObject {

  /**
   * The name the tool's refusals speak in: the statement's callee. The type
   * by default; a tool whose callee differs from its type (`project` for a
   * projected curve) overrides it.
   */
  protected toolName(): string {
    return this.getType();
  }

  /**
   * Takes a scene object given through a chained method (`.adjacent(faces)`,
   * `.direction(axis)`), as the builder takes an argument: a `select()` it
   * leads to is spoken for, so a later bare `fillet(2)` does not pick it up
   * as the last selection. The builder never sees a chain, so each such
   * method calls this. The object must also be among `getDependencies()`:
   * that is what builds a lazy accessor given this way before the tool, and
   * what a repeat copies.
   */
  protected adoptOperand<T extends SceneObject>(operand: T): T {
    SelectSceneObject.claimOperands([operand], this.getSourceLocation());
    return operand;
  }

  /** The objects whose bodies the face readers (`FaceOperand`) match the tool's face operands against. */
  protected operandScope(context: BuildSceneObjectContext): SceneObject[] {
    return context.getSceneObjects();
  }

  /**
   * What becomes of the operands once the result is built. By default every
   * dependency is taken as a tool takes an operand: a selection's highlight
   * goes, an anchor goes with the selection it stands on, and a sketch, a
   * curve, an axis or a plane leaves the screen and stays readable. An
   * operand that holds a solid or a surface is left as it is: reading a body
   * does not consume it. A tool that replaces a body, or keeps an operand on
   * screen, overrides this.
   */
  protected consumeOperands(): void {
    for (const operand of this.getDependencies()) {
      if (operand instanceof AnchoredLazyVertex) {
        operand.consumeFor(this);
      } else if (!operand.getShapes().some(shape => shape.isBody())) {
        operand.removeShapes(this);
      }
    }
  }

  /**
   * Resolves the lazy accessors among the dependencies before the tool reads
   * them. One given as an argument was registered ahead of the tool and has
   * built; one given through a chained method was created after the tool's
   * statement and has no earlier build slot.
   */
  protected resolveLazyOperands(): void {
    const seen = new Set<SceneObject>();
    for (const operand of this.getDependencies()) {
      if (operand.isLazy()) {
        LazySelectionSceneObject.resolveReachable(operand, seen);
      }
    }
  }
}
