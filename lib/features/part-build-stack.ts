import type { Scene } from "../rendering/scene.js";
import type { PartDefinition } from "./part-definition.js";

/**
 * The part definitions currently building into a scene, outermost first.
 *
 * Definitions build lazily: a body's read of another definition
 * (`donor.features.<name>`, `.from(def)`, a transform argument, `insert()`)
 * materializes the donor right there, and the variant cache only holds a
 * part once its body has RETURNED. So a part reading a part that reads it
 * back would re-enter its own build before anything is cached, again and
 * again, until the JavaScript stack overflows with a bare "Maximum call
 * stack size exceeded" (GH #82). The stack is the guard: a re-entrant
 * build refuses with the loop spelled out, at the read that closed it.
 *
 * Keyed per scene like the variant cache, and by DEFINITION rather than
 * variant — a part reaching itself through a differently parameterized
 * variant is the same endless loop. Every exit runs in a `finally`, so a
 * body that throws (a refused feature, a breakpoint pause) leaves nothing
 * behind to poison a later build.
 */
export class PartBuildStack {
  private static readonly byScene = new WeakMap<Scene, PartDefinition[]>();

  /** Mark `def` as building into `scene`; throws when it already is. */
  static enter(scene: Scene, def: PartDefinition): void {
    const stack = PartBuildStack.stackOf(scene);
    const at = stack.indexOf(def);
    if (at !== -1) {
      throw new Error(PartBuildStack.loopMessage(stack.slice(at)));
    }
    stack.push(def);
  }

  /** The build of `def` into `scene` finished, however it ended. */
  static exit(scene: Scene, def: PartDefinition): void {
    const stack = PartBuildStack.stackOf(scene);
    const at = stack.lastIndexOf(def);
    if (at !== -1) {
      stack.splice(at, 1);
    }
  }

  /** The names of the definitions building into `scene`, outermost first. */
  static building(scene: Scene): string[] {
    return PartBuildStack.stackOf(scene).map(def => def.getDisplayName());
  }

  private static stackOf(scene: Scene): PartDefinition[] {
    let stack = PartBuildStack.byScene.get(scene);
    if (!stack) {
      stack = [];
      PartBuildStack.byScene.set(scene, stack);
    }
    return stack;
  }

  /**
   * `loop` is the stack from the re-entered definition down to the one
   * whose body read it back: `construct → back_door` reads as "construct
   * reads back_door, which reads construct".
   */
  private static loopMessage(loop: PartDefinition[]): string {
    const names = loop.map(def => `"${def.getDisplayName()}"`);
    const chain = [...names, names[0]].join(" → ");
    const self = names[0];
    const through = names.length === 1
      ? "its own body reads it"
      : `${names[names.length - 1]} reads it back`;
    return `part ${self} depends on itself: ${chain} — ${through} while ${self} is still building. `
      + "Two parts can't read each other's geometry. Move the geometry one needs from the other into a "
      + "single part, or build the dependent feature at the file's top level instead.";
  }
}
