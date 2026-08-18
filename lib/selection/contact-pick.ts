import { Part } from "../features/part.js";
import { classifyContact } from "../features/contact-chain.js";
import type { ContactEntity } from "../oc/contact-classify.js";
import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { SelectionIndex } from "./selection-index.js";
import { attributePick } from "./attribution.js";
import { PickRef, SelectionScene } from "./types.js";

/**
 * What the tangent-mate pick flow needs from one face/edge pick: the
 * find-or-create exposure resolution (same shape as `resolvePickExposure`)
 * PLUS the canonical contact classification the provisional solve and the
 * in-panel pair validation consume before any `expose()` exists.
 */
export type ContactPickResolution =
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
    /** null → unsupported surface form (torus / freeform). */
    seed: ContactEntity | null;
    /** Tangent-propagation set, seed first; [] when the seed is unsupported. */
    chain: ContactEntity[];
  }
  | { ok: false; reason: string };

/**
 * Resolve a tangent-mate pick: attribution to the enclosing part, exposure
 * find-or-create data, and the contact classification of the picked
 * face/edge (chain walked on the owning part's solids). Works over
 * assembly scenes — a tangent pick names geometry, not coordinates, so the
 * sketch flow's authoring-frame refusal doesn't apply here.
 */
export function resolveContactPick(scene: SelectionScene, ref: PickRef): ContactPickResolution {
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
    return { ok: true, donor: null, ...classifyPicked(picked, []) };
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

  let roots: Shape[] = [];
  try {
    roots = enclosing.getShapes().filter(s => s.isSolid());
  } catch {
    // A part whose body failed to build still resolves the donor.
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
    ...classifyPicked(picked, roots),
  };
}

function classifyPicked(
  picked: Shape,
  roots: Shape[],
): { seed: ContactEntity | null; chain: ContactEntity[] } {
  try {
    return classifyContact(picked, roots);
  } catch {
    return { seed: null, chain: [] };
  }
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
