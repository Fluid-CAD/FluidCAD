import { Shape } from "../common/shape.js";
import { Scene } from "../rendering/scene.js";
import { Explorer } from "../oc/explorer.js";
import { TangentExpander } from "../filters/tangent-expander.js";
import { resolvePickShape } from "./attribution.js";
import { PickRef } from "./types.js";

export type ExpandTangentsResult =
  | { ok: true; members: PickRef[] }
  | { ok: false; reason: string };

/**
 * Expand a picked edge (or face) to its full tangent chain on the owning
 * solid — the "Select with tangents" gesture. Returns every chain member as
 * a pick ref in mesh exploration order (the seed included), so the UI can
 * highlight them exactly like ordinary picks.
 */
export function expandTangentChain(scene: Scene, ref: PickRef): ExpandTangentsResult {
  const resolved = resolvePickShape(scene, ref);
  if (!resolved) {
    return { ok: false, reason: 'pick does not resolve to a sub-shape in the current scene' };
  }

  const universe: Shape[] = ref.sub.type === 'face'
    ? Explorer.findFacesWrapped(resolved.shape)
    : Explorer.findEdgesWrapped(resolved.shape);
  // Seed with the universe's own wrapper so expansion results stay
  // identity-mappable back to mesh indices.
  const seed = universe[ref.sub.index];
  const expanded = TangentExpander.expand([seed], universe);

  const indexByWrapper = new Map<Shape, number>();
  universe.forEach((shape, index) => indexByWrapper.set(shape, index));

  const indices: number[] = [];
  for (const shape of expanded) {
    const index = indexByWrapper.get(shape);
    if (index !== undefined) {
      indices.push(index);
    }
  }
  indices.sort((a, b) => a - b);

  return {
    ok: true,
    members: indices.map(index => ({
      shapeId: ref.shapeId,
      sub: { type: ref.sub.type, index },
    })),
  };
}
