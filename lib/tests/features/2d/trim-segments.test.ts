import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import trim from "../../../core/trim.js";
import { rect, circle, hLine, move, polygon } from "../../../core/2d/index.js";
import { edge } from "../../../filters/index.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { Trim2D } from "../../../features/trim2d.js";
import { Edge } from "../../../common/edge.js";
import { Face } from "../../../common/face.js";
import { EdgeProps } from "../../../oc/edge-props.js";
import { synthesizeTrimRegionTargets } from "../../../selection/trim-region.js";
import { setLocation } from "../../selection/pick-helpers.js";

// By-region trimming (plans follow-up to sketch-edge-selection): edge-filter
// trim targets match the SPLIT segments, trim().pick() emits region meta
// faces mapping cells to their boundary segments, and the trim-region
// synthesis turns a region click into verified edge-filter args.
describe("trim segments and regions", () => {
  setupOC();

  const lineLength = (e: Edge): number =>
    EdgeProps.getProperties(e.getShape()).length ?? NaN;

  const trimObjOf = (scene: { getAllSceneObjects(): any[] }): Trim2D => {
    const found = scene.getAllSceneObjects().find((o: any) => o instanceof Trim2D);
    expect(found).toBeDefined();
    return found as Trim2D;
  };

  const regionsOf = (t: Trim2D): Face[] =>
    t.getAddedShapes().filter((s): s is Face =>
      s instanceof Face && s.isMetaShape() && s.metaType === 'trim-region');

  it("filter targets remove split segments, not whole edges", () => {
    let s: Sketch;
    s = sketch("xy", () => {
      rect(80, 60);
      move([-10, 30]);
      hLine(100);
      trim(edge().line(10));
    }) as Sketch;
    render();

    // The crossing line's two 10-long overhangs are gone; its 80-long middle
    // segment survives, alongside the rect's four untouched edges.
    const remaining = [...s!.getEdgesWithOwner().keys()];
    expect(remaining).toHaveLength(5);
    const lengths = remaining.map(lineLength).sort((a, b) => a - b);
    expect(lengths.every(l => Math.abs(l - 10) > 1e-9)).toBe(true);
    expect(lengths.filter(l => Math.abs(l - 80) < 1e-9)).toHaveLength(3);
  });

  it("picking emits trim-region meta faces with boundary segment ids", () => {
    sketch("xy", () => {
      rect(80, 60);
      move([-10, 30]);
      hLine(100);
      trim().pick();
    });
    const scene = render();
    const trimObj = trimObjOf(scene);

    const segments = trimObj.getSegments();
    expect(segments.length).toBeGreaterThan(0);
    const segmentIds = new Set(segments.map(e => e.id));

    // The crossing line divides the rect interior into two cells; every
    // region's metaData lists ids of real trim segments.
    const regions = regionsOf(trimObj);
    expect(regions.length).toBe(2);
    for (const region of regions) {
      const edgeIds = region.metaData?.edgeIds as string[];
      expect(Array.isArray(edgeIds)).toBe(true);
      expect(edgeIds.length).toBeGreaterThanOrEqual(4);
      for (const id of edgeIds) {
        expect(segmentIds.has(id)).toBe(true);
      }
    }
  });

  it("synthesizes filter args for a region separable by curve kind", () => {
    sketch("xy", () => {
      rect(80, 60);
      move([40, 30]);
      circle(20);
      trim().pick();
    });
    const scene = render();
    const trimObj = trimObjOf(scene);
    setLocation(trimObj, 6);

    // The circle's interior cell is bounded by the circle alone.
    const circleRegion = regionsOf(trimObj).find(r =>
      (r.metaData?.edgeIds as string[]).length === 1);
    expect(circleRegion).toBeDefined();

    const result = synthesizeTrimRegionTargets(
      scene, { line: 6 }, circleRegion!.metaData!.edgeIds as string[],
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args).toBe('edge().circle()');
      expect(result.imports).toEqual(['edge']);
    }
  });

  it("refuses honestly when no filter separates the region boundary", () => {
    sketch("xy", () => {
      rect(80, 60);
      move([-10, 30]);
      hLine(100);
      trim().pick();
    });
    const scene = render();
    const trimObj = trimObjOf(scene);
    setLocation(trimObj, 6);

    // Either cell's boundary includes an 80-long segment, but so does the
    // opposite rect side — a length filter would drag it along.
    const region = regionsOf(trimObj)[0];
    const result = synthesizeTrimRegionTargets(
      scene, { line: 6 }, region.metaData!.edgeIds as string[],
    );
    expect(result.ok).toBe(false);
  });

  it("synthesized args survive a rebuild as trim targets", () => {
    let s: Sketch;
    s = sketch("xy", () => {
      rect(80, 60);
      move([40, 30]);
      circle(20);
      trim(edge().circle());
    }) as Sketch;
    render();

    // The circle region's boundary is removed; the rect's edges survive.
    const remaining = [...s!.getEdgesWithOwner().keys()];
    expect(remaining).toHaveLength(4);
  });

  describe("orphaned meta shapes", () => {
    const metaShapesOf = (s: Sketch) =>
      s.getShapes({ excludeMeta: false, excludeGuide: false })
        .filter(shape => shape.isMetaShape());

    it("removes a polygon's meta base circle when the whole polygon is trimmed", () => {
      const s = sketch("xy", () => {
        const pg = polygon(6, 40);
        trim(pg);
      }) as Sketch;
      render();

      expect(metaShapesOf(s)).toHaveLength(0);
    });

    it("keeps the meta base circle when only one side is trimmed", () => {
      const s = sketch("xy", () => {
        const pg = polygon(6, 40);
        trim(pg.edge(0));
      }) as Sketch;
      render();

      expect(metaShapesOf(s)).toHaveLength(1);
    });

    it("removes the meta base circle when filter targets trim away every side", () => {
      const s = sketch("xy", () => {
        polygon(6, 40);
        trim(edge().line());
      }) as Sketch;
      render();

      expect(metaShapesOf(s)).toHaveLength(0);
    });
  });
});
