import { describe, it, expect } from "vitest";
import { setupOC, render, addToScene, expectDisplayConsumed } from "../setup.js";
import sketch from "../../core/sketch.js";
import repeat from "../../core/repeat.js";
import extrude from "../../core/extrude.js";
import select from "../../core/select.js";
import { edge, face } from "../../filters/index.js";
import { BuildSceneObjectContext, SceneObject } from "../../common/scene-object.js";
import { Edge } from "../../common/edge.js";
import { Face } from "../../common/face.js";
import { Shape } from "../../common/shape.js";
import { Sheet } from "../../common/sheet.js";
import { RepeatBase } from "../../features/repeat-base.js";
import { SurfaceObject } from "../../features/surface-object.js";
import { getOC } from "../../oc/init.js";
import { FaceProps } from "../../oc/face-props.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { SheetOps } from "../../oc/sheet-ops.js";
import { FaceOperand } from "../../helpers/face-operand.js";
import { SelectionIndex } from "../../selection/selection-index.js";
import { TestSheets } from "../helpers/sheets.js";
import { testRect } from "../helpers/profiles.js";
import { patch, TestPatch } from "../helpers/result-fixtures.js";

const asObject = (value: unknown) => value as SceneObject;

/** A surface tool whose build returns whatever the test hands it. */
class StubSurface extends SurfaceObject {
  constructor(private readonly make: () => Sheet[]) {
    super();
  }

  protected buildSheets(_context: BuildSceneObjectContext): Sheet[] {
    return this.make();
  }

  override getType(): string {
    return 'test-patch';
  }

  serialize() {
    return {};
  }
}

/** A surface tool that reads faces: the faces it is given, lifted out as surfaces of their own. */
class FaceCopy extends SurfaceObject {
  /** The bodies the faces were found on, as the face reader matched them in the tool's scope. */
  owners: (Shape | null)[] = [];

  constructor(private readonly source: SceneObject) {
    super();
  }

  protected buildSheets(context: BuildSceneObjectContext): Sheet[] {
    const held = FaceOperand.faces(this.source, this.operandScope(context), "copy faces");
    this.owners = held.map(entry => entry.body);
    return SheetOps.fromFaces(held.map(entry => entry.face));
  }

  override getType(): string {
    return 'test-patch';
  }

  override getDependencies(): SceneObject[] {
    return [this.source];
  }

  serialize() {
    return {};
  }
}

/** A shell holding no face at all: a surface the validation refuses. */
function emptySheet(): Sheet {
  const oc = getOC();
  const builder = new oc.BRep_Builder();
  const shell = new oc.TopoDS_Shell();
  try {
    builder.MakeShell(shell);
    return Sheet.fromTopoDSShell(shell);
  } finally {
    builder.delete();
  }
}

/** A 20 × 10 rectangle on XY from the origin. */
function rectangle(): SceneObject {
  return asObject(sketch("xy", () => {
    testRect(20, 10);
  }));
}

describe("SurfaceObject", () => {
  setupOC();

  describe("the result", () => {
    it("holds the surface its build returned", () => {
      const boundary = rectangle();
      const p = patch(boundary);
      const scene = render();

      expect(p.getError()).toBeNull();
      const shapes = p.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0]).toBeInstanceOf(Sheet);
      expect(shapes[0].getType()).toBe("surface");
      expect(FaceProps.getProperties((shapes[0] as Sheet).getFaces()[0].getShape()).areaMm2).toBeCloseTo(200, 6);
      expectDisplayConsumed(scene, boundary);
    });

    it("answers its faces, all or by index", () => {
      const s = new StubSurface(() => [TestSheets.strip([[0, 0], [10, 0], [10, 10]], 5)]);
      addToScene(s);
      const all = asObject(s.faces());
      const second = asObject(s.faces(1));
      addToScene(all);
      addToScene(second);
      render();

      const sheet = s.getShapes()[0] as Sheet;
      expect(all.getShapes()).toEqual(sheet.getFaces());
      expect(second.getShapes()).toEqual([sheet.getFaces()[1]]);
    });

    it("answers its open rim, all, by index or by a filter", () => {
      const s = new StubSurface(() => [TestSheets.strip([[0, 0], [10, 0], [10, 10]], 5)]);
      addToScene(s);
      const all = asObject(s.boundaryEdges());
      const first = asObject(s.boundaryEdges(0));
      const upright = asObject(s.boundaryEdges(edge().verticalTo("xy")));
      addToScene(all);
      addToScene(first);
      addToScene(upright);
      render();

      const sheet = s.getShapes()[0] as Sheet;
      // Two faces sharing one upright edge: seven edges, six of them on the rim.
      expect(sheet.getEdges()).toHaveLength(7);
      expect(all.getShapes()).toEqual(sheet.getBoundaryEdges());
      expect(all.getShapes()).toHaveLength(6);
      expect(first.getShapes()).toEqual([sheet.getBoundaryEdges()[0]]);
      expect(upright.getShapes()).toHaveLength(2);
    });

    it("reads a rim edge as boundaryEdges and a face as faces, and records both as its own", () => {
      const p = patch(rectangle());
      const scene = render();

      const index = new SelectionIndex(scene);
      try {
        const sheet = p.getShapes()[0] as Sheet;
        const rim: Edge = sheet.getBoundaryEdges()[2];
        const inner: Face = sheet.getFaces()[0];
        const edgeHits = index.findHits(index.keyOf(rim), "edge").filter(hit => hit.bucket.feature === p);
        expect(edgeHits.map(hit => [hit.bucket.def.accessor, hit.index])).toEqual([["boundaryEdges", 2]]);
        const faceHits = index.findHits(index.keyOf(inner), "face");
        expect(faceHits.map(hit => [hit.bucket.feature, hit.bucket.def.accessor, hit.index])).toEqual([[p, "faces", 0]]);
        expect(index.creatorOf(index.keyOf(inner))).toBe(p);
      } finally {
        index.dispose();
      }
    });
  });

  describe("a face operand", () => {
    it("is matched to its body through the tool's scope, and the body stays", () => {
      sketch("xy", () => {
        testRect(20, 10);
      });
      const box = asObject(extrude(5));
      const top = asObject(select(face().planar().onPlane("xy", 5)));
      const copy = new FaceCopy(top);
      addToScene(copy);
      render();

      expect(copy.getError()).toBeNull();
      const [solid] = box.getShapes();
      expect(solid.isSolid()).toBe(true);
      expect(copy.owners).toEqual([solid]);
      const sheet = copy.getShapes()[0] as Sheet;
      expect(FaceProps.getProperties(sheet.getFaces()[0].getShape()).areaMm2).toBeCloseTo(200, 6);
      // The selection's highlight went with the tool; the solid it named did not.
      expect(top.getShapes()).toEqual([]);
    });

    it("leaves a body given whole in the scene", () => {
      sketch("xy", () => {
        testRect(20, 10);
      });
      const box = asObject(extrude(5));
      const copy = new FaceCopy(box);
      addToScene(copy);
      render();

      expect(copy.getError()).toBeNull();
      expect((copy.getShapes()[0] as Sheet).getFaces()).toHaveLength(6);
      expect(box.getShapes()).toHaveLength(1);
    });
  });

  describe("refusals", () => {
    it("names the tool when no surface was made", () => {
      const s = new StubSurface(() => []);
      addToScene(s);
      render();

      expect(s.getError()).toMatch(/^test-patch: no surface was made\./);
    });

    it("refuses a surface whose faces are not sound", () => {
      const s = new StubSurface(() => [emptySheet()]);
      addToScene(s);
      render();

      expect(s.getError()).toMatch(/test-patch validation failed:.*noFace/);
      expect(s.getShapes()).toEqual([]);
    });

    it("says what is wrong with its operand in the operand's words", () => {
      const whole = patch(rectangle());
      const p = new TestPatch(asObject(whole.boundaryEdges(0)));
      addToScene(p);
      render();

      expect(whole.getError()).toBeNull();
      // One rim edge alone closes nothing.
      expect(p.getError()).toMatch(/patch boundary is open/);
    });
  });

  describe("repeat()", () => {
    it("gives each copy its own buckets, moved with the copy", () => {
      const p = patch(rectangle());
      const r = repeat("linear", "x", { count: 2, offset: 50 }, p) as unknown as RepeatBase;
      const copiedFaces = asObject(r.instance(1).faces());
      const instance = r.instance(1) as unknown as { boundaryEdges(...args: number[]): SceneObject };
      const copiedRim = instance.boundaryEdges(0);
      addToScene(copiedFaces);
      addToScene(copiedRim);
      render();

      const [copy] = r.getInstanceRoots(1);
      expect(copy).toBeInstanceOf(TestPatch);
      expect(copy.getError()).toBeNull();
      const sheet = copy.getShapes()[0] as Sheet;
      const box = ShapeOps.getBoundingBox(sheet);
      expect([box.minX, box.maxX].map(v => +v.toFixed(6))).toEqual([50, 70]);
      expect(copy.getState("faces")).toEqual(sheet.getFaces());
      expect(copy.getState("boundary-edges")).toEqual(sheet.getBoundaryEdges());
      expect(copiedFaces.getShapes()).toEqual(sheet.getFaces());
      expect(copiedRim.getShapes()).toHaveLength(1);
      expect(sheet.getBoundaryEdges()).toContain(copiedRim.getShapes()[0]);
    });
  });
});
