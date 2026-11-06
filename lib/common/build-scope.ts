import type { BuildSceneObjectContext } from "./scene-object.js";

/**
 * The build in progress: the scene object building and the context it was
 * handed. The renderer enters it around every `build()`, a feature's preview
 * around its `ghost()`, so code deep inside a build — raw OpenCascade code
 * in a custom feature's `this.occ()` scope among it — can ask which shapes
 * the scene holds without the context being threaded through every call.
 */
export class BuildScope {
  private static readonly stack: { object: object; context: BuildSceneObjectContext }[] = [];

  /** Run `fn` as the build of `object` with `context`; nested builds stack. */
  static run<T>(object: object, context: BuildSceneObjectContext, fn: () => T): T {
    BuildScope.stack.push({ object, context });
    try {
      return fn();
    } finally {
      BuildScope.stack.pop();
    }
  }

  /** The context of the innermost build of `object` in progress, or null outside one. */
  static contextOf(object: object): BuildSceneObjectContext | null {
    for (let i = BuildScope.stack.length - 1; i >= 0; i--) {
      if (BuildScope.stack[i].object === object) {
        return BuildScope.stack[i].context;
      }
    }
    return null;
  }
}
