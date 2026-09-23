// The region picker's side channel: every closed region of a profile, keyed
// and meshed, with the dialog's current picks marked — the faces a feature
// dialog draws over the sketch for the user to click. Read-only over the
// scene, like the feature ghost: the arrangement is built from the profile
// alone, meshed once, and freed before returning.

import { Shape } from "../common/shape.js";
import { RegionRequest, resolveRegions } from "../features/2d/regions/region-match.js";
import { sourceRegions } from "../features/2d/regions/source-regions.js";
import type { MeshSettings } from "../oc/mesh.js";
import { findProfile, profileEdgesWithOwner } from "./feature-ghost.js";
import { MeshBuilder } from "./mesh-builder.js";
import { Scene, SceneObjectMesh } from "./scene.js";
import { withUnit } from "../units/registry.js";

export type SketchRegionsRequest = {
  /** The producing statement of the profile — a sketch, or a top-level offset. */
  profile: { filePath: string; line: number };
  /** The dialog's current `.region()` picks; the regions they resolve to come back `selected`. */
  keys: RegionRequest[];
};

/** One region of the profile, in the shape the picker draws and toggles. */
export type SketchRegionPreview = {
  /** The region's key, as `.region()` accepts it — what a click writes. */
  key: string;
  /** Position in the canonical region list — what `.region(2)` selects. */
  index: number;
  /** One of the request's keys resolved to this region. */
  selected: boolean;
  meshes: SceneObjectMesh[];
};

export type SketchRegionsResult =
  | { ok: true; regions: SketchRegionPreview[] }
  | { ok: false; reason: string };

/**
 * Mesh every region of the profile a `{filePath, line}` ref names, marking
 * the ones the request's keys resolve to — the tolerant match the applied
 * statement uses, so a key that survived a sketch edit lights the region it
 * now names. Keys that resolve to nothing are simply not selected; the
 * apply reports them.
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
  const regions = sourceRegions(profile, plane, profileEdgesWithOwner(profile));
  const faces: Shape[] = regions.map(region => region.face);
  try {
    const { selected } = resolveRegions(request.keys, regions);
    const builder = new MeshBuilder(meshConfig);
    const previews: SketchRegionPreview[] = [];
    for (const region of regions) {
      const meshes = builder.build(region.face);
      if (!meshes) {
        continue;
      }
      previews.push({
        key: region.key,
        index: region.index,
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
