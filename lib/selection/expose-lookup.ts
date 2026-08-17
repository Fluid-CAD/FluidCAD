import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Part } from "../features/part.js";
import { SelectionIndex } from "./selection-index.js";
import { attributePick } from "./attribution.js";
import { PickRef, SelectionScene } from "./types.js";

/**
 * The inverse map a consumer-side pick needs: which part owns the picked
 * geometry, and whether one of that part's exposures already publishes the
 * picked shape. `donor: null` means the pick resolved fine but lies outside
 * any `part()` block — the caller falls back to the ordinary flow.
 */
export type PickExposureResolution =
  | {
    ok: true;
    donor: {
      partName: string;
      filePath: string;
      line: number;
      column: number;
      /** Exposure name whose source already serves the picked shape, or null. */
      matched: string | null;
      /** Every exposure name the donor already registers. */
      existingNames: string[];
    } | null;
  }
  | { ok: false; reason: string };

/**
 * Resolve a single face/edge pick to its enclosing part and that part's
 * matching exposure, if any. Read-only over a built scene — matching compares
 * the picked sub-shape against each exposure source's built shapes by
 * topological identity (`IsSame`), so a `select(...)`/lazy-selection source
 * created from the same solid matches its viewport pick.
 */
export function resolvePickExposure(scene: SelectionScene, ref: PickRef): PickExposureResolution {
  const index = new SelectionIndex(scene);
  let picked: Shape | null;
  let solidOwner: SceneObject | null;
  try {
    const attribution = attributePick(scene, index, ref);
    picked = attribution.picked;
    solidOwner = attribution.solidOwner;
  } finally {
    index.dispose();
  }
  if (!picked) {
    return { ok: false, reason: 'pick does not resolve to a sub-shape in the current scene' };
  }

  const enclosing = solidOwner ? scene.findEnclosingPart(solidOwner) : null;
  if (!(enclosing instanceof Part)) {
    return { ok: true, donor: null };
  }
  const loc = enclosing.getSourceLocation();
  if (!loc) {
    return { ok: false, reason: 'the enclosing part() has no source location — re-render and try again' };
  }

  let matched: string | null = null;
  for (const exposure of enclosing.getExposed()) {
    if (sourceServes(exposure.source, picked)) {
      matched = exposure.exposeName;
      break;
    }
  }

  return {
    ok: true,
    donor: {
      partName: enclosing.partName,
      filePath: loc.filePath,
      line: loc.line,
      column: loc.column,
      matched,
      existingNames: Object.keys(enclosing.getNamedExposures()),
    },
  };
}

/** Whether one of the source's built shapes IS the picked sub-shape. */
function sourceServes(source: SceneObject, picked: Shape): boolean {
  try {
    for (const shape of source.getShapes()) {
      if (shape.isSame(picked)) {
        return true;
      }
    }
  } catch {
    // An unbuilt or shape-less source never matches.
  }
  return false;
}
