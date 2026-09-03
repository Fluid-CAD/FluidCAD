import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import extrude from "../../core/extrude.js";
import { Extrude } from "../../features/extrude.js";
import { Explorer } from "../../oc/explorer.js";
import { Face } from "../../common/face.js";
import { Scene } from "../../rendering/scene.js";
import { SelectionIndex } from "../../selection/selection-index.js";
import { findSolids } from "../selection/pick-helpers.js";
import { testRectSketch } from "../helpers/profiles.js";

/**
 * Classified faces (start/end/side/… buckets) are what accessors like
 * `e.sideFaces(1)` resolve — the face a sketch reads its plane from, whose
 * normal decides which way the next extrude goes. Faces that reach a bucket
 * through OCCT history (a fusion's Modified list, UnifySameDomain's merge
 * lineage, a draft's images) must carry the orientation the solid gives
 * them, not the maker's list orientation: a merged wall stored FORWARD
 * while the shell references it REVERSED reports an inward normal.
 */
describe("classified faces carry the solid's orientation", () => {
  setupOC();

  /**
   * Every classified face still present on a final solid reports that
   * solid's outward normal.
   */
  function expectBucketsOriented(scene: Scene): number {
    const finalFaces = findSolids(scene).flatMap(solid => Explorer.findFacesWrapped(solid));
    const index = new SelectionIndex(scene);
    let checked = 0;
    try {
      for (const bucket of index.buckets) {
        if (bucket.def.kind !== 'face') {
          continue;
        }
        bucket.members.forEach((member, i) => {
          if (!(member instanceof Face)) {
            return;
          }
          const onSolid = finalFaces.find(f => f.getShape().IsSame(member.getShape()));
          if (!onSolid) {
            return;
          }
          checked++;
          const stored = member.calculateNormal();
          const actual = onSolid.calculateNormal();
          const dot = stored.x * actual.x + stored.y * actual.y + stored.z * actual.z;
          expect(dot, `${bucket.feature.getType()}.${bucket.def.accessor}(${i}) normal`).toBeGreaterThan(0.99);
        });
      }
    } finally {
      index.dispose();
    }
    return checked;
  }

  it("keeps the outward normal on walls merged by a fusion", () => {
    // Two overlapping blocks below z=0: the second's y-walls merge with the
    // first's through UnifySameDomain, so its side buckets hold merged faces.
    testRectSketch("xy", 40, 40);
    extrude(-60);
    testRectSketch("xy", 40, 40, { at: [20, 0] });
    const e2 = extrude(-20);
    const scene = render();

    expect(expectBucketsOriented(scene)).toBeGreaterThan(0);

    // The plane a sketch on a merged wall reads faces outward: +y on the
    // y=40 wall, -y on the y=0 wall.
    const sideFaces = (e2 as unknown as Extrude).getState('side-faces') as Face[];
    const walls = sideFaces.filter(f => Math.abs(Math.abs(f.getPlane().normal.y) - 1) < 1e-9);
    expect(walls.length).toBe(2);
    for (const wall of walls) {
      const plane = wall.getPlane();
      const expectedY = plane.origin.y > 20 ? 1 : -1;
      expect(plane.normal.y).toBeCloseTo(expectedY, 9);
    }
  });

  it("keeps the outward normal on drafted faces", () => {
    testRectSketch("xy", 40, 40);
    extrude(-30).draft(5);
    const scene = render();

    expect(expectBucketsOriented(scene)).toBeGreaterThan(0);
  });
});
