import type { Face } from "./face.js";
import type { SceneObject } from "./scene-object.js";
import type { Shape } from "./shape.js";

/** One painted face of a body, as import and export carry it: no author. */
export type FaceColor = { face: Face; color: string };

/**
 * A body with its resolved face colours, the carrier the import and export
 * paths hand around: colours are holder records, not something a wrapper
 * knows, so a body leaving the scene (STEP export) or entering it (`load`)
 * travels with them spelled out. A body is a solid or a surface; an import
 * also carries its curves this way, with no colours.
 */
export type ColoredBody<B extends Shape = Shape> = { body: B; colors: FaceColor[] };

export class ColoredBodies {
  /** `body` with the colours `holder` resolves for it scope-less — the final state, what an export writes. */
  static fromHolder<B extends Shape>(holder: SceneObject, body: B): ColoredBody<B> {
    const view = holder.getFaceColors(body);
    try {
      return { body, colors: view.entries().map(({ face, color }) => ({ face, color })) };
    } finally {
      view.delete();
    }
  }
}
