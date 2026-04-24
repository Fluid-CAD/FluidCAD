import { describe, it, expect } from "vitest";
import { getOC } from "../../oc/init.js";
import { ShapeHistoryTracker } from "../../common/shape-history-tracker.js";
import { Primitives } from "../../oc/primitives.js";
import { Explorer } from "../../oc/explorer.js";
import { Convert } from "../../oc/convert.js";
import type { TopAbs_ShapeEnum } from "occjs-wrapper";

function countFaces(shape: { getShape(): any }): number {
  const oc = getOC();
  return Explorer.findShapes(shape.getShape(), oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum).length;
}

function countEdges(shape: { getShape(): any }): number {
  const oc = getOC();
  return Explorer.findShapes(shape.getShape(), oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum).length;
}

describe("ShapeHistoryTracker", () => {
  describe("BRepBuilderAPI_Transform (translation)", () => {
    it("records every input face as a 1:1 modification on a sphere", () => {
      const oc = getOC();
      const sphere = Primitives.makeSphere(10, 2 * Math.PI);
      const [trsf, disposeTrsf] = Convert.toGpTrsfTranslation(5, 0, 0);

      const transformer = new oc.BRepBuilderAPI_Transform(trsf);
      transformer.Perform(sphere.getShape(), true);

      const history = ShapeHistoryTracker.collect(transformer, [sphere]);

      const inputFaceCount = countFaces(sphere);
      expect(inputFaceCount).toBeGreaterThan(0);
      expect(history.modifiedFaces).toHaveLength(inputFaceCount);
      // Every record should have exactly one source and one result (1:1).
      for (const record of history.modifiedFaces) {
        expect(record.sources).toHaveLength(1);
        expect(record.results).toHaveLength(1);
      }
      expect(history.addedFaces).toEqual([]);
      expect(history.removedFaces).toEqual([]);
      expect(history.generatedFaces).toEqual([]);

      transformer.delete();
      disposeTrsf();
    });

    it("records every input edge as a 1:1 modification on a cylinder", () => {
      const oc = getOC();
      const cyl = Primitives.makeCylinder(5, 10);
      const [trsf, disposeTrsf] = Convert.toGpTrsfTranslation(0, 0, 3);

      const transformer = new oc.BRepBuilderAPI_Transform(trsf);
      transformer.Perform(cyl.getShape(), true);

      const history = ShapeHistoryTracker.collect(transformer, [cyl]);

      const inputFaceCount = countFaces(cyl);
      const inputEdgeCount = countEdges(cyl);
      expect(inputFaceCount).toBeGreaterThan(0);
      expect(inputEdgeCount).toBeGreaterThan(0);

      expect(history.modifiedFaces).toHaveLength(inputFaceCount);
      expect(history.modifiedEdges).toHaveLength(inputEdgeCount);
      for (const record of history.modifiedFaces) {
        expect(record.sources).toHaveLength(1);
        expect(record.results).toHaveLength(1);
      }
      for (const record of history.modifiedEdges) {
        expect(record.sources).toHaveLength(1);
        expect(record.results).toHaveLength(1);
      }
      expect(history.addedFaces).toEqual([]);
      expect(history.addedEdges).toEqual([]);
      expect(history.removedFaces).toEqual([]);
      expect(history.removedEdges).toEqual([]);

      transformer.delete();
      disposeTrsf();
    });

    it("leaves results pointing at the transformed output's subshapes", () => {
      const oc = getOC();
      const sphere = Primitives.makeSphere(8, 2 * Math.PI);
      const [trsf, disposeTrsf] = Convert.toGpTrsfTranslation(1, 1, 1);

      const transformer = new oc.BRepBuilderAPI_Transform(trsf);
      transformer.Perform(sphere.getShape(), true);

      const history = ShapeHistoryTracker.collect(transformer, [sphere]);

      const outputFaces = Explorer.findShapes(
        transformer.Shape(),
        oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum,
      );

      // Every modification result must correspond to a face in the actual output shape.
      const outputMap = new oc.TopTools_MapOfShape();
      for (const f of outputFaces) {
        outputMap.Add(f);
      }
      for (const record of history.modifiedFaces) {
        for (const result of record.results) {
          expect(outputMap.Contains(result.getShape())).toBe(true);
        }
      }
      outputMap.delete();

      transformer.delete();
      disposeTrsf();
    });
  });

  describe("with no inputs", () => {
    it("returns empty history when no inputs are provided", () => {
      const oc = getOC();
      const sphere = Primitives.makeSphere(3, 2 * Math.PI);
      const [trsf, disposeTrsf] = Convert.toGpTrsfTranslation(1, 0, 0);

      const transformer = new oc.BRepBuilderAPI_Transform(trsf);
      transformer.Perform(sphere.getShape(), true);

      const history = ShapeHistoryTracker.collect(transformer, []);

      // With no inputs, nothing is claimed as modified/generated, so every
      // output face/edge gets classified as added. This is the expected
      // contract: "inputs" defines what the caller considers pre-existing.
      expect(history.modifiedFaces).toEqual([]);
      expect(history.modifiedEdges).toEqual([]);
      expect(history.removedFaces).toEqual([]);
      expect(history.removedEdges).toEqual([]);
      expect(history.addedFaces.length).toBeGreaterThan(0);
      expect(history.addedEdges.length).toBeGreaterThan(0);

      transformer.delete();
      disposeTrsf();
    });
  });
});
