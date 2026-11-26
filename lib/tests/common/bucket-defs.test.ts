import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import { BucketDefs } from "../../common/bucket-defs.js";
import { SceneObject } from "../../common/scene-object.js";
import { testRect } from "../helpers/profiles.js";
import { chord, patch } from "../helpers/result-fixtures.js";

const asObject = (value: unknown) => value as SceneObject;
const accessors = (object: SceneObject, kind: "edge" | "face") => object.bucketDefs(kind).map(def => def.accessor);

describe("BucketDefs", () => {
  setupOC();

  describe("attribution order", () => {
    it("lists boundaryEdges before the edges fallback", () => {
      const keys = BucketDefs.EDGES.map(def => def.key);
      expect(keys.indexOf("boundary-edges")).toBeGreaterThanOrEqual(0);
      expect(keys.indexOf("boundary-edges")).toBeLessThan(keys.indexOf("section-edges"));
      expect(keys[keys.length - 1]).toBe("section-edges");
    });

    it("lists faces last, after every positional face bucket", () => {
      const last = BucketDefs.FACES[BucketDefs.FACES.length - 1];
      expect(last).toEqual({ key: "faces", accessor: "faces", kind: "face", label: "Faces", deriveFromFaceKey: null });
    });

    it("labels the rim bucket for the editor's menus", () => {
      const rim = BucketDefs.EDGES.find(def => def.key === "boundary-edges");
      expect(rim).toEqual({
        key: "boundary-edges", accessor: "boundaryEdges", kind: "edge", label: "Boundary Edges", deriveFromFaceKey: null,
      });
    });
  });

  describe("what an object answers", () => {
    it("offers a surface tool its rim and its faces", () => {
      const boundary = asObject(sketch("xy", () => {
        testRect(20, 10);
      }));
      const p = patch(boundary);
      render();

      expect(accessors(p, "edge")).toEqual(["boundaryEdges"]);
      expect(accessors(p, "face")).toEqual(["faces"]);
    });

    it("offers a curve tool its edges", () => {
      const c = chord([0, 0, 0], [10, 0, 0]);
      render();

      expect(accessors(c, "edge")).toEqual(["edges"]);
      expect(accessors(c, "face")).toEqual([]);
    });

    it("offers an extrude neither, since it has no accessor for them", () => {
      sketch("xy", () => {
        testRect(20, 10);
      });
      const e = asObject(extrude(5));
      render();

      expect(accessors(e, "edge")).not.toContain("boundaryEdges");
      expect(accessors(e, "edge")[accessors(e, "edge").length - 1]).toBe("edges");
      expect(accessors(e, "face")).not.toContain("faces");
    });
  });
});
