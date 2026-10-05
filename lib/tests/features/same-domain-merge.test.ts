import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import plane from "../../core/plane.js";
import { line, circle, arc, region, far, origin, xAxis, yAxis } from "../../core/2d/index.js";
import {
  symmetric, angle, diameter, parallel, distance, vertical, horizontal, tangent, coincident,
} from "../../core/constraints/index.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { Face } from "../../common/face.js";
import { Shape } from "../../common/shape.js";
import { Scene } from "../../rendering/scene.js";
import { BooleanOps } from "../../oc/boolean-ops.js";
import { Explorer } from "../../oc/explorer.js";
import { FaceQuery } from "../../oc/face-query.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { ShapeProps } from "../../oc/props.js";
import { ShapeValidator } from "../../oc/shape-validator.js";
import { SameDomainMerge } from "../../oc/same-domain-merge.js";
import { TopologyIndex } from "../../oc/topology-index.js";
import { getOC } from "../../oc/init.js";
import { testRect } from "../helpers/profiles.js";

// Regression for the link with a boss on each ear (box.part.js, 2026-10-01):
// a boss ring that shares an ear's rounded end and stands proud of the plate
// on BOTH sides makes one same-surface group of {ring, ear, ring}. The kernel
// merges a group onto its first face; when that is the ring's full cylinder
// and its seam line crosses the ear, the merged face cannot be closed,
// ShapeUpgrade_UnifySameDomain gives up — and abandons every group after it
// in the shell. The body kept the seam across the ear, the ring circles and
// each hole in three stacked pieces. SameDomainMerge retries such a group
// with another member as the reference.
describe("SameDomainMerge: a group the kernel gives up on is merged from another reference", () => {
  setupOC();

  type Mode = 'symmetric' | 'two-distance';
  type SketchPlane = 'xy' | 'xz' | 'yz';

  function solids(scene: Scene): Shape[] {
    return scene.getSceneObjects()
      .filter(o => !o.isContainer())
      .flatMap(o => o.getShapes())
      .filter(s => s.isSolid());
  }

  function cylinders(body: Shape, radius: number): Face[] {
    return Explorer.findFacesWrapped(body).filter(f =>
      FaceQuery.getSurfaceType(f) === 'cylinder'
      && Math.abs(FaceQuery.getSurfaceAdaptorCylinderRaw(f.getShape()).Radius() - radius) < 1e-6) as Face[];
  }

  /** An 80 mm link: two r=20 ears, an r=10 hole in each, 25 thick. */
  function link(plane: SketchPlane, mode: Mode): ExtrudeBase {
    sketch(plane, () => {
      line([-40, 20], [40, 20]);
      arc([40, 20], [40, -20], [40, 0]).cw();
      line([40, -20], [-40, -20]);
      arc([-40, -20], [-40, 20], [-40, 0]).cw();
      circle([40, 0], 20);
      circle([-40, 0], 20);
    });
    const e = extrude(25) as ExtrudeBase;
    return mode === 'symmetric' ? e.symmetric() as ExtrudeBase : e;
  }

  /** A 40 long r=20 boss around the right hole, 7.5 proud of the link on each side. */
  function boss(plane: SketchPlane, mode: Mode): ExtrudeBase {
    sketch(plane, () => {
      circle([40, 0], 40);
      circle([40, 0], 20);
    });
    return (mode === 'symmetric' ? extrude(40).symmetric() : extrude(32.5, 7.5)) as ExtrudeBase;
  }

  const LINK_VOLUME = 25 * (80 * 40 + Math.PI * 400 - 2 * Math.PI * 100);
  const BOSS_VOLUME = 15 * Math.PI * (400 - 100);

  // The circle's seam sits at a different angle on each plane: inside the
  // ear's arc on xy and xz, on its boundary on yz.
  for (const plane of ['xy', 'xz', 'yz'] as const) {
    for (const mode of ['symmetric', 'two-distance'] as const) {
      it(`a ${mode} boss proud on both sides of a link on ${plane} is one clean body`, () => {
        link(plane, mode);
        boss(plane, mode);
        const scene = render();

        expect(scene.getSceneObjects().map(o => o.getError()).filter(Boolean)).toEqual([]);
        const bodies = solids(scene);
        expect(bodies).toHaveLength(1);
        expect(ShapeValidator.validate(bodies[0].getShape()).findings).toEqual([]);
        expect(ShapeProps.getProperties(bodies[0].getShape()).volumeMm3).toBeCloseTo(LINK_VOLUME + BOSS_VOLUME, 3);

        // Two caps and two flats of the link, the boss's two ring caps, and
        // one face per cylinder: each ear (the right one with its rings) and
        // each hole.
        expect(Explorer.findFacesWrapped(bodies[0])).toHaveLength(10);
        expect(cylinders(bodies[0], 20)).toHaveLength(2);
        expect(cylinders(bodies[0], 10)).toHaveLength(2);
      });
    }
  }

  /**
   * Sketch body of a link whose flanks are parallel but slanted, so each
   * ear's arc starts off-axis; regions r1/r2 are the ears' circles.
   */
  function drawSlantedLink() {
    const c1 = circle([-80, 0], 40);
    const c2 = circle([-80, 0], 20);
    const l1 = line([-83.11, 19.76], [0, 32.85]);
    const l2 = line([-76.89, -19.76], [0, -7.64]);
    const l3 = line([85, 19.36], [0, 41.31]);
    const c3 = circle([80, 0], 40);
    const c4 = circle([80, 0], 20);
    const l4 = line([75, -19.36], [0, 0]);
    coincident(c1.center(), xAxis());
    diameter(c1, 40);
    coincident(c2.center(), c1.center());
    diameter(c2, 20);
    coincident(l2.start(), c1);
    coincident(l1.start(), c1);
    tangent(l1, c1);
    tangent(l2, c1);
    coincident(l2.end(), yAxis());
    coincident(l1.end(), yAxis());
    parallel(l2, l1);
    distance(c2.center(), origin(), 80);
    coincident(l2.end(), origin());
    symmetric(l1, l3, yAxis());
    symmetric(c1, c3, yAxis());
    symmetric(c2, c4, yAxis());
    symmetric(l2, l4, yAxis());
    region('r1', c1);
    region('r2', c3);
  }

  // A region's circle reaches the sweep cut at the flanks' tangent points, so
  // a boss swept in one go has three arc faces for a wall and no seam among
  // them. Merging the group onto one of the ring's arcs makes the kernel hand
  // back an INVALID body — which the boolean builder's own SimplifyResult
  // adopts as its result, and no later cleanup recovers.
  it("region bosses swept from an offset plane are merged before the builder adopts a broken body", () => {
    extrude(25, sketch('xz', drawSlantedLink));
    extrude(40, sketch(plane('xz', -7.5), drawSlantedLink)).region('r1', 'r2');
    const scene = render();

    expect(scene.getSceneObjects().map(o => o.getError()).filter(Boolean)).toEqual([]);
    const bodies = solids(scene);
    expect(bodies).toHaveLength(1);
    expect(ShapeValidator.validate(bodies[0].getShape()).findings).toEqual([]);
    // The link's two caps and four flanks, four ring caps, and one face per
    // cylinder: each ear with its rings, each hole.
    expect(Explorer.findFacesWrapped(bodies[0])).toHaveLength(14);
    expect(cylinders(bodies[0], 20)).toHaveLength(2);
    expect(cylinders(bodies[0], 10)).toHaveLength(2);
  });

  it("the boss's classified faces follow the merge", () => {
    link('xz', 'symmetric');
    const b = boss('xz', 'symmetric');
    const scene = render();
    const body = solids(scene)[0];

    const bucket = (key: string) => (b.getState(key) as Face[]) || [];
    for (const key of ['start-faces', 'end-faces', 'side-faces', 'internal-faces']) {
      const faces = bucket(key);
      expect(faces.length, key).toBeGreaterThan(0);
      for (const face of faces) {
        expect(TopologyIndex.containsSubShape(body.getShape(), face.getShape()), key).toBe(true);
      }
    }
    // The boss wall is now the ear's face, the bore the hole's.
    expect(bucket('side-faces').some(f => cylinders(body, 20).some(c => c.isSame(f)))).toBe(true);
    expect(bucket('internal-faces').some(f => cylinders(body, 10).some(c => c.isSame(f)))).toBe(true);
  });

  it("a body the boss does not touch keeps its place in the scene", () => {
    link('xz', 'symmetric');
    sketch('xz', () => { testRect(20, 20, { at: [200, 200] }); });
    const block = (extrude(10) as ExtrudeBase).new();
    boss('xz', 'symmetric');
    const scene = render();

    const bodies = solids(scene);
    expect(bodies).toHaveLength(2);
    expect(block.getShapes().filter(s => s.isSolid())).toHaveLength(1);
    for (const body of bodies) {
      expect(ShapeValidator.validate(body.getShape()).findings).toEqual([]);
    }
  });

  it("the reported link: region bosses on both ears of a symmetric body", () => {
    const s = sketch('xz', () => {
      const l1 = line([-113.88, 19.3], [-70, 31.06]);
      const l2 = line([-70, 31.06], [0, 31.06]);
      const c1 = circle([-110, 4.81], 30);
      const l3 = line([-106.12, -9.68], [-70, 0]);
      const l4 = line([-70, 0], [0, 0]);
      const c2 = circle([-110, 4.81], 20);
      const l5 = line([70, 31.06], [0, 31.06]);
      const l6 = line([70, 0], [0, 0]);
      const l7 = line([106.12, -9.68], [70, 0]);
      const c3 = circle([110, 4.81], 30);
      const c4 = circle([110, 4.81], 20);
      const l8 = line([113.88, 19.3], [70, 31.06]);
      coincident(l2.start(), l1.end());
      horizontal(l2);
      coincident(l4.start(), l3.end());
      horizontal(l4);
      coincident(l4.end(), yAxis());
      coincident(l2.end(), yAxis());
      coincident(l3.start(), c1);
      tangent(l3, c1);
      tangent(l1, c1);
      coincident(l1.start(), c1);
      parallel(l1, l3);
      diameter(c2, 20);
      diameter(c1, 30);
      angle(l3.start(), l4, 165);
      vertical(l3.end(), l1.end());
      coincident(c2.center(), c1.center());
      coincident(l4.end(), origin());
      distance(c1.center(), yAxis(), 220 / 2);
      distance(l2.start(), yAxis(), 33);
      symmetric(l2, l5, yAxis());
      symmetric(l4, l6, yAxis());
      symmetric(l3, l7, yAxis());
      symmetric(c1, c3, yAxis());
      symmetric(c2, c4, yAxis());
      symmetric(l1, l8, yAxis());
      region('r1', c1);
      region('r2', c3);
      region('r3', far(l1), far(c1), l3, l4, far(l6), far(l7), far(c3), l8, l5, far(l2));
    });
    extrude(30, s).symmetric();
    extrude(40, s).region('r1', 'r2').symmetric();
    const scene = render();

    expect(scene.getSceneObjects().map(o => o.getError()).filter(Boolean)).toEqual([]);
    const bodies = solids(scene);
    expect(bodies).toHaveLength(1);
    expect(ShapeValidator.validate(bodies[0].getShape()).findings).toEqual([]);
    expect(Explorer.findFacesWrapped(bodies[0])).toHaveLength(17);
    expect(cylinders(bodies[0], 15)).toHaveLength(2);
    expect(cylinders(bodies[0], 10)).toHaveLength(2);
  });

  describe("on the raw fuse result", () => {
    /** The link and its boss fused without any simplification. */
    function rawFuse(plane: SketchPlane) {
      const l = link(plane, 'symmetric').new();
      const b = boss(plane, 'symmetric').new();
      render();
      const fuse = BooleanOps.fuseStockAndTools(
        l.getShapes().filter(s => s.isSolid()),
        b.getShapes().filter(s => s.isSolid()),
        { skipSimplify: true },
      );
      expect(fuse.result).toHaveLength(1);
      return fuse;
    }

    it("merges every group and maps each input face into the result", () => {
      const fuse = rawFuse('xz');
      const oc = getOC();
      const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE;
      const raw = fuse.result[0].getShape();
      const inputFaces = Explorer.findShapes(raw, FACE);

      const merge = SameDomainMerge.run(raw, { unifyEdges: true, unifyFaces: true });
      try {
        expect(merge.valid).toBe(true);
        expect(Explorer.findShapes(merge.shape, FACE)).toHaveLength(10);

        for (const face of inputFaces) {
          expect(merge.history.IsRemoved(face)).toBe(false);
          const images = ShapeOps.shapeListToArray(merge.history.Modified(face));
          // A face the merge left alone has no record; every other one maps
          // to faces the result holds.
          for (const image of images) {
            expect(TopologyIndex.containsSubShape(merge.shape, image)).toBe(true);
          }
          if (images.length === 0) {
            expect(TopologyIndex.containsSubShape(merge.shape, face)).toBe(true);
          }
        }
      } finally {
        merge.dispose();
        fuse.dispose();
      }
    });

    it("cleanShape merges it too", () => {
      const fuse = rawFuse('xy');
      try {
        const cleaned = ShapeOps.cleanShape(fuse.result[0]);
        expect(ShapeValidator.validate(cleaned.getShape()).findings).toEqual([]);
        expect(Explorer.findFacesWrapped(cleaned)).toHaveLength(10);
      } finally {
        fuse.dispose();
      }
    });
  });
});
