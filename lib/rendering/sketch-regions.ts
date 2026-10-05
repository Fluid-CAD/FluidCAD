// The region picker's side channel: every closed region of a profile, meshed,
// with the dialog's current picks marked — the faces a feature dialog draws
// over the sketch for the user to click — and, for each, the boundary a pick
// of it writes into a `region()` declaration. Read-only over the scene, like
// the feature ghost: the arrangement is built from the profile alone, meshed
// once, and freed before returning.

import { Shape } from "../common/shape.js";
import { declaredNameOf, resolveRegionPicks, sourceRegionContext } from "../features/2d/regions/source-regions.js";
import { itemRefOf, writableItems } from "../features/2d/regions/region-wire.js";
import type { RegionItemRef, RegionPick } from "../features/2d/regions/region-wire.js";
import type { MeshSettings } from "../oc/mesh.js";
import { findProfile, profileEdgesWithOwner } from "./feature-ghost.js";
import { MeshBuilder } from "./mesh-builder.js";
import { Scene, SceneObjectMesh } from "./scene.js";
import { withUnit } from "../units/registry.js";

export type SketchRegionsRequest = {
  /** The producing statement of the profile — a sketch, or a top-level offset. */
  profile: { filePath: string; line: number };
  /** The dialog's current picks; the regions they resolve to come back `selected`. */
  picks: RegionPick[];
};

/** One region of the profile, in the shape the picker draws and toggles. */
export type SketchRegionPreview = {
  /** A readable label of the boundary — the overlay's toggle key, display only. */
  key: string;
  /** Position in the canonical region list. */
  index: number;
  /** The name a `region()` declaration of the sketch already gives this exact boundary, or null. */
  name: string | null;
  /**
   * The boundary a pick writes: whole statements with their sides, edges of
   * multi-edge statements only where needed to tell two regions apart.
   * Empty when the profile's statements carry no source location and the
   * region cannot be declared from the dialog.
   */
  items: RegionItemRef[];
  /** One of the request's picks resolved to this region. */
  selected: boolean;
  meshes: SceneObjectMesh[];
};

export type SketchRegionsResult =
  | { ok: true; regions: SketchRegionPreview[] }
  | { ok: false; reason: string };

/**
 * Mesh every region of the profile a `{filePath, line}` ref names, marking
 * the ones the request's picks resolve to — the tolerant match the applied
 * statement uses, so a declaration that survived a sketch edit lights the
 * region it now names. Picks that resolve to nothing are simply not
 * selected; the apply reports them.
 *
 * Runs entirely inside the caller's OCC serialization window; it holds no
 * shape past its own return.
 */
export function buildSketchRegions(
  scene: Scene,
  request: SketchRegionsRequest,
  meshConfig: MeshSettings,
): SketchRegionsResult {
  return withUnit(scene.unit, () => buildSketchRegionsInUnit(scene, request, meshConfig));
}

function buildSketchRegionsInUnit(
  scene: Scene,
  request: SketchRegionsRequest,
  meshConfig: MeshSettings,
): SketchRegionsResult {
  const profile = findProfile(scene, request.profile);
  if (!profile) {
    return { ok: false, reason: 'That sketch is not in the rendered scene.' };
  }
  const plane = profile.getPlane();
  if (!plane) {
    return { ok: false, reason: 'The profile has no plane.' };
  }
  const context = sourceRegionContext(profile, plane, profileEdgesWithOwner(profile));
  const { sketch, regions, declarations } = context;
  const faces: Shape[] = regions.map(region => region.face);
  try {
    const { selected } = resolveRegionPicks(context, request.picks);
    const builder = new MeshBuilder(meshConfig);
    const previews: SketchRegionPreview[] = [];
    for (const region of regions) {
      const meshes = builder.build(region.face);
      if (!meshes) {
        continue;
      }
      const writable = writableItems(region, regions);
      const refs = sketch ? writable.map(item => itemRefOf(item, sketch)) : [];
      const items = refs.every((ref): ref is RegionItemRef => ref !== null) ? refs : [];
      previews.push({
        key: region.key,
        index: region.index,
        name: declaredNameOf(declarations, region.items, writable),
        items,
        selected: selected.includes(region),
        meshes,
      });
    }
    return { ok: true, regions: previews };
  } finally {
    for (const face of faces) {
      face.dispose();
    }
  }
}
