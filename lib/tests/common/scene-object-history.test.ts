import { describe, it, expect } from "vitest";
import { SceneObject } from "../../common/scene-object.js";
import { Face } from "../../common/face.js";
import { Edge } from "../../common/edge.js";
import type { TopoDS_Face, TopoDS_Edge } from "occjs-wrapper";

class FakeSceneObject extends SceneObject {
  private _container: boolean;

  constructor(options: { container?: boolean } = {}) {
    super();
    this._container = options.container ?? false;
  }

  override isContainer(): boolean {
    return this._container;
  }

  override getType(): string {
    return "fake";
  }

  override serialize() {
    return {};
  }

  override build() {}
}

function makeFace(): Face {
  return new Face(null as unknown as TopoDS_Face);
}

function makeEdge(): Edge {
  return new Edge(null as unknown as TopoDS_Edge);
}

describe("SceneObject history tracking", () => {
  describe("defaults", () => {
    it("returns empty arrays for every new getter on a fresh object", () => {
      const obj = new FakeSceneObject();

      expect(obj.getAddedFaces()).toEqual([]);
      expect(obj.getModifiedFaces()).toEqual([]);
      expect(obj.getRemovedFaces()).toEqual([]);
      expect(obj.getAddedEdges()).toEqual([]);
      expect(obj.getModifiedEdges()).toEqual([]);
      expect(obj.getRemovedEdges()).toEqual([]);
      expect(obj.getFinalShapes()).toEqual([]);
    });
  });

  describe("face additions", () => {
    it("records an added face and preserves addedBy", () => {
      const owner = new FakeSceneObject();
      const by = new FakeSceneObject();
      const face = makeFace();

      owner.recordAddedFace(face, by);

      expect(owner.getAddedFaces()).toEqual([face]);
    });

    it("scopes addition lookups by addedBy", () => {
      const owner = new FakeSceneObject();
      const a = new FakeSceneObject();
      const b = new FakeSceneObject();
      const fa = makeFace();
      const fb = makeFace();

      owner.recordAddedFace(fa, a);
      owner.recordAddedFace(fb, b);

      expect(owner.getAddedFaces()).toEqual([fa, fb]);
      expect(owner.getAddedFaces(new Set([a]))).toEqual([fa]);
      expect(owner.getAddedFaces(new Set([b]))).toEqual([fb]);
      expect(owner.getAddedFaces(new Set([a, b]))).toEqual([fa, fb]);
    });
  });

  describe("face modifications", () => {
    it("records a 1:1 modification with length-1 source and result arrays", () => {
      const owner = new FakeSceneObject();
      const by = new FakeSceneObject();
      const src = makeFace();
      const dst = makeFace();

      owner.recordModifiedFaces([src], [dst], by);

      const records = owner.getModifiedFaces();
      expect(records).toHaveLength(1);
      expect(records[0].sources).toEqual([src]);
      expect(records[0].results).toEqual([dst]);
      expect(records[0].modifiedBy).toBe(by);
    });

    it("records a 1:N split as one record with multiple results", () => {
      const owner = new FakeSceneObject();
      const by = new FakeSceneObject();
      const src = makeFace();
      const r1 = makeFace();
      const r2 = makeFace();
      const r3 = makeFace();

      owner.recordModifiedFaces([src], [r1, r2, r3], by);

      const records = owner.getModifiedFaces();
      expect(records).toHaveLength(1);
      expect(records[0].sources).toEqual([src]);
      expect(records[0].results).toEqual([r1, r2, r3]);
    });

    it("records an N:1 merge (UnifySameDomain shape) as one record with multiple sources", () => {
      const owner = new FakeSceneObject();
      const by = new FakeSceneObject();
      const s1 = makeFace();
      const s2 = makeFace();
      const s3 = makeFace();
      const merged = makeFace();

      owner.recordModifiedFaces([s1, s2, s3], [merged], by);

      const records = owner.getModifiedFaces();
      expect(records).toHaveLength(1);
      expect(records[0].sources).toEqual([s1, s2, s3]);
      expect(records[0].results).toEqual([merged]);
    });

    it("scopes modification lookups by modifiedBy", () => {
      const owner = new FakeSceneObject();
      const a = new FakeSceneObject();
      const b = new FakeSceneObject();
      const fa = makeFace();
      const fb = makeFace();

      owner.recordModifiedFaces([fa], [makeFace()], a);
      owner.recordModifiedFaces([fb], [makeFace()], b);

      expect(owner.getModifiedFaces()).toHaveLength(2);
      expect(owner.getModifiedFaces(new Set([a]))).toHaveLength(1);
      expect(owner.getModifiedFaces(new Set([a]))[0].sources).toEqual([fa]);
    });
  });

  describe("face removals", () => {
    it("records a removed face with removedBy", () => {
      const owner = new FakeSceneObject();
      const by = new FakeSceneObject();
      const face = makeFace();

      owner.recordRemovedFace(face, by);

      expect(owner.getRemovedFaces()).toEqual([face]);
    });

    it("scopes removal lookups by removedBy", () => {
      const owner = new FakeSceneObject();
      const a = new FakeSceneObject();
      const b = new FakeSceneObject();
      const fa = makeFace();
      const fb = makeFace();

      owner.recordRemovedFace(fa, a);
      owner.recordRemovedFace(fb, b);

      expect(owner.getRemovedFaces(new Set([a]))).toEqual([fa]);
      expect(owner.getRemovedFaces(new Set([b]))).toEqual([fb]);
    });

    it("propagates to the owning child when called on a container", () => {
      const container = new FakeSceneObject({ container: true });
      const child1 = new FakeSceneObject();
      const child2 = new FakeSceneObject();
      container.addChildObject(child1);
      container.addChildObject(child2);

      const by = new FakeSceneObject();
      const face = makeFace();
      child1.recordAddedFace(face, child1);

      container.recordRemovedFace(face, by);

      expect(child1.getRemovedFaces()).toEqual([face]);
      expect(child2.getRemovedFaces()).toEqual([]);
      // The container itself must not store the record directly.
      expect(container.getRemovedFaces()).toEqual([]);
    });

    it("does not propagate to children that do not own the face", () => {
      const container = new FakeSceneObject({ container: true });
      const child = new FakeSceneObject();
      container.addChildObject(child);

      const by = new FakeSceneObject();
      const unowned = makeFace();

      container.recordRemovedFace(unowned, by);

      expect(child.getRemovedFaces()).toEqual([]);
    });
  });

  describe("edge additions", () => {
    it("records an added edge and preserves addedBy", () => {
      const owner = new FakeSceneObject();
      const by = new FakeSceneObject();
      const edge = makeEdge();

      owner.recordAddedEdge(edge, by);

      expect(owner.getAddedEdges()).toEqual([edge]);
    });

    it("scopes addition lookups by addedBy", () => {
      const owner = new FakeSceneObject();
      const a = new FakeSceneObject();
      const b = new FakeSceneObject();
      const ea = makeEdge();
      const eb = makeEdge();

      owner.recordAddedEdge(ea, a);
      owner.recordAddedEdge(eb, b);

      expect(owner.getAddedEdges(new Set([a]))).toEqual([ea]);
      expect(owner.getAddedEdges(new Set([b]))).toEqual([eb]);
    });
  });

  describe("edge modifications", () => {
    it("records a 1:1 edge modification", () => {
      const owner = new FakeSceneObject();
      const by = new FakeSceneObject();
      const src = makeEdge();
      const dst = makeEdge();

      owner.recordModifiedEdges([src], [dst], by);

      const records = owner.getModifiedEdges();
      expect(records).toHaveLength(1);
      expect(records[0].sources).toEqual([src]);
      expect(records[0].results).toEqual([dst]);
      expect(records[0].modifiedBy).toBe(by);
    });

    it("records a 1:N edge split", () => {
      const owner = new FakeSceneObject();
      const by = new FakeSceneObject();
      const src = makeEdge();
      const r1 = makeEdge();
      const r2 = makeEdge();

      owner.recordModifiedEdges([src], [r1, r2], by);

      expect(owner.getModifiedEdges()).toHaveLength(1);
      expect(owner.getModifiedEdges()[0].results).toEqual([r1, r2]);
    });

    it("records an N:1 edge merge", () => {
      const owner = new FakeSceneObject();
      const by = new FakeSceneObject();
      const s1 = makeEdge();
      const s2 = makeEdge();
      const merged = makeEdge();

      owner.recordModifiedEdges([s1, s2], [merged], by);

      expect(owner.getModifiedEdges()).toHaveLength(1);
      expect(owner.getModifiedEdges()[0].sources).toEqual([s1, s2]);
      expect(owner.getModifiedEdges()[0].results).toEqual([merged]);
    });

    it("scopes edge modification lookups by modifiedBy", () => {
      const owner = new FakeSceneObject();
      const a = new FakeSceneObject();
      const b = new FakeSceneObject();

      owner.recordModifiedEdges([makeEdge()], [makeEdge()], a);
      owner.recordModifiedEdges([makeEdge()], [makeEdge()], b);

      expect(owner.getModifiedEdges()).toHaveLength(2);
      expect(owner.getModifiedEdges(new Set([a]))).toHaveLength(1);
      expect(owner.getModifiedEdges(new Set([a]))[0].modifiedBy).toBe(a);
    });
  });

  describe("edge removals", () => {
    it("records a removed edge with removedBy", () => {
      const owner = new FakeSceneObject();
      const by = new FakeSceneObject();
      const edge = makeEdge();

      owner.recordRemovedEdge(edge, by);

      expect(owner.getRemovedEdges()).toEqual([edge]);
    });

    it("scopes removal lookups by removedBy", () => {
      const owner = new FakeSceneObject();
      const a = new FakeSceneObject();
      const b = new FakeSceneObject();
      const ea = makeEdge();
      const eb = makeEdge();

      owner.recordRemovedEdge(ea, a);
      owner.recordRemovedEdge(eb, b);

      expect(owner.getRemovedEdges(new Set([a]))).toEqual([ea]);
      expect(owner.getRemovedEdges(new Set([b]))).toEqual([eb]);
    });

    it("propagates to the owning child when called on a container", () => {
      const container = new FakeSceneObject({ container: true });
      const child1 = new FakeSceneObject();
      const child2 = new FakeSceneObject();
      container.addChildObject(child1);
      container.addChildObject(child2);

      const by = new FakeSceneObject();
      const edge = makeEdge();
      child2.recordAddedEdge(edge, child2);

      container.recordRemovedEdge(edge, by);

      expect(child2.getRemovedEdges()).toEqual([edge]);
      expect(child1.getRemovedEdges()).toEqual([]);
      expect(container.getRemovedEdges()).toEqual([]);
    });
  });

  describe("finalShapes", () => {
    it("roundtrips through set/get", () => {
      const owner = new FakeSceneObject();
      const f1 = makeFace();
      const f2 = makeFace();

      owner.setFinalShapes([f1, f2]);

      expect(owner.getFinalShapes()).toEqual([f1, f2]);
    });

    it("replaces prior values on subsequent calls", () => {
      const owner = new FakeSceneObject();
      owner.setFinalShapes([makeFace()]);
      const replacement = makeFace();
      owner.setFinalShapes([replacement]);

      expect(owner.getFinalShapes()).toEqual([replacement]);
    });
  });
});
