import type { Face } from "./face.js";
import type { SceneObject } from "./scene-object.js";
import type { Solid } from "./solid.js";

/** One painted face of a solid, as import and export carry it: no author. */
export type FaceColor = { face: Face; color: string };

/**
 * A solid with its resolved face colours, the carrier the import and export
 * paths hand around: colours are holder records, not something a wrapper
 * knows, so a solid leaving the scene (STEP export) or entering it (`load`)
 * travels with them spelled out.
 */
export type ColoredSolid = { solid: Solid; colors: FaceColor[] };

export class ColoredSolids {
  /** `solid` with the colours `holder` resolves for it scope-less — the final state, what an export writes. */
  static fromHolder(holder: SceneObject, solid: Solid): ColoredSolid {
    const view = holder.getFaceColors(solid);
    try {
      return { solid, colors: view.entries().map(({ face, color }) => ({ face, color })) };
    } finally {
      view.delete();
    }
  }
}
