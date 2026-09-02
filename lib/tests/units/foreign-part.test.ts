// Phase 5b: a part built in one unit consumed by a scene of another is
// rescaled into the consumer's unit — geometry and part-owned connectors,
// never the instance pose. The definition lives in its own (inch) fluid
// file (fixtures/inch-part.ts); the consuming scene is mm unless noted.

import { describe, it, expect, afterEach } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import { getUnitRegistry } from "../../units/registry.js";
import type { LengthUnit } from "../../units/units.js";
import insert from "../../core/insert.js";
import extrude from "../../core/extrude.js";
import mate from "../../core/mate.js";
import assembly from "../../core/assembly.js";
import { Part } from "../../features/part.js";
import { Instance } from "../../features/instance.js";
import { Shape } from "../../common/shape.js";
import { Solid } from "../../common/solid.js";
import { SceneObject } from "../../common/scene-object.js";
import { Scene } from "../../rendering/scene.js";
import { AssemblyScene } from "../../rendering/assembly-scene.js";
import { SceneCompare } from "../../rendering/scene-compare.js";
import { AssemblyCompare } from "../../rendering/assembly-compare.js";
import { ShapeProps } from "../../oc/props.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { INCH_PART_FILE, defineInchBlock } from "./fixtures/inch-part.js";

const IN = 25.4;
const MM_FILE = "/ws/consumer.fluid.js";

function solidsOf(obj: SceneObject): Solid[] {
  return obj.getShapes().filter((s): s is Solid => s instanceof Solid);
}

function volume(obj: SceneObject): number {
  return solidsOf(obj).reduce((sum, s) => sum + ShapeProps.getProperties(s.getShape()).volumeMm3, 0);
}

function bboxMax(shape: Shape): { x: number; y: number; z: number } {
  const b = ShapeOps.getBoundingBox(shape);
  return { x: b.maxX, y: b.maxY, z: b.maxZ };
}

/** Largest coordinate over every mesh vertex the render emitted for `obj`. */
function renderedExtent(scene: Scene, obj: SceneObject): number {
  const rendered = scene.getRenderedObjects().find(r => r.id === obj.id);
  expect(rendered).toBeDefined();
  let max = -Infinity;
  for (const shape of rendered!.sceneShapes) {
    for (const mesh of shape.meshes ?? []) {
      for (const v of mesh.vertices) {
        max = Math.max(max, v);
      }
    }
  }
  return max;
}

/** The member whose own shapes hold the part's solid (the trailing color() owns it). */
function solidOwner(part: Part): SceneObject {
  const owner = part.getChildren().find(c => c.getOwnShapes().some(s => s instanceof Solid));
  expect(owner).toBeDefined();
  return owner!;
}

/** An assembly scene in `projectUnit` with the inch fixture declared. */
function startAssembly(projectUnit: LengthUnit = "mm"): AssemblyScene {
  getSceneManager().projectUnit = projectUnit;
  const scene = getSceneManager().startAssemblyScene();
  getUnitRegistry().declare(INCH_PART_FILE, "in");
  return scene;
}

/** A part scene whose root is an mm file, with the inch fixture declared. */
function startMmPartScene(): Scene {
  getSceneManager().projectUnit = "mm";
  const scene = getSceneManager().startScene();
  getSceneManager().setCurrentFile(MM_FILE);
  getUnitRegistry().declare(INCH_PART_FILE, "in");
  return scene;
}

describe("foreign-unit parts", () => {
  setupOC();

  afterEach(() => {
    getSceneManager().projectUnit = "mm";
    getSceneManager().setCurrentFile("");
  });

  describe("inserted into an mm assembly", () => {
    it("renders the 1 in block as a 25.4 mm block — same topology, colours kept", () => {
      const scene = startAssembly();
      const def = defineInchBlock();
      const inst = insert(def);
      render();

      const part = inst.record.part;
      expect(part.getDefinitionUnit()).toBe("in");
      expect(part.getTargetUnit()).toBe("mm");
      expect(part.isForeignUnit()).toBe(true);

      const solids = solidsOf(part);
      expect(solids).toHaveLength(1);
      const solid = solids[0];
      expect(volume(part)).toBeCloseTo(IN ** 3, 3);
      // Bounding boxes are padded by the shape tolerance (~1e-7 × 25.4).
      expect(bboxMax(solid).x).toBeCloseTo(IN, 4);
      expect(bboxMax(solid).y).toBeCloseTo(IN / 2, 4);
      expect(bboxMax(solid).z).toBeCloseTo(IN, 4);
      expect(solid.getFaces()).toHaveLength(6);
      expect(solid.getEdges()).toHaveLength(12);

      // The coloured top face survived the transform, mapped onto the
      // scaled face (color() stores a normalized colour value).
      expect(solid.colorMap).toHaveLength(1);
      const stored = solid.colorMap[0].color;
      const coloured = solid.getFaces().filter(f => solid.getColor(f.getShape()) === stored);
      expect(coloured).toHaveLength(1);
      expect(ShapeOps.getBoundingBox(coloured[0]).minZ).toBeCloseTo(IN, 4);

      // What the viewer receives is in the assembly's unit too, and the
      // members now report that unit so meshing/tolerances follow it.
      expect(renderedExtent(scene, solidOwner(part))).toBeCloseTo(IN, 3);
      for (const member of part.getChildren()) {
        expect(member.getUnit()).toBe("mm");
      }
      expect(part.getUnit()).toBe("mm");

      // The pose is untouched — the scale is baked into geometry only.
      expect(inst.record.position).toEqual({ x: 0, y: 0, z: 0 });
      expect(inst.record.quaternion).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    });

    it("scales part-owned connector frames, so mates land at the scaled position", () => {
      const scene = startAssembly();
      const def = defineInchBlock();
      const a = insert(def);
      const b = insert(def);
      render();

      const frame = a.connectors.top.getFrame();
      expect(frame.origin.x).toBeCloseTo(IN / 2, 6);
      expect(frame.origin.y).toBeCloseTo(0, 6);
      expect(frame.origin.z).toBeCloseTo(IN, 6);
      // Directions are dimensionless and stay unit length.
      expect(frame.normal.length()).toBeCloseTo(1, 12);
      expect(frame.normal.z).toBeCloseTo(1, 6);

      // A mate between two such connectors references the live (scaled)
      // connectors — the frame the solver reads is the scaled one.
      mate("fastened", a.connectors.top, b.connectors.top);
      const [serialized] = scene.getSerializedMates();
      expect(serialized.connectorA?.connectorId).toBe(a.connectors.top.connector.id);
      expect(a.connectors.top.connector.serialize().origin.z).toBeCloseTo(IN, 6);
      expect(b.connectors.top.getFrame().origin.z).toBeCloseTo(IN, 6);
    });

    it("keeps insert() overrides in the part's unit: size 2 → 2 in → 50.8 mm", () => {
      startAssembly();
      const def = defineInchBlock();
      const plain = insert(def);
      const big = insert(def, { size: 2 });
      render();

      expect(big.record.part).not.toBe(plain.record.part);
      expect(volume(big.record.part)).toBeCloseTo((2 * IN) ** 3, 2);
      expect(bboxMax(solidsOf(big.record.part)[0]).z).toBeCloseTo(2 * IN, 4);
      expect(big.connectors.top.getFrame().origin.z).toBeCloseTo(2 * IN, 6);
      expect(volume(plain.record.part)).toBeCloseTo(IN ** 3, 3);
    });

    it("keeps the exposure's contact geometry in the assembly's unit", () => {
      startAssembly();
      const def = defineInchBlock();
      const inst = insert(def);
      render();

      const top = inst.features.top.exposed.serialize();
      expect(top.seed?.form).toBe("plane");
      // The seed plane sits on the scaled top face, normal unchanged.
      expect(top.seed!.point[2]).toBeCloseTo(IN, 6);
      expect(top.seed!.dir[2]).toBeCloseTo(1, 6);
    });

    it("part-scoped rollback re-emits the scaled geometry (no rebuild)", () => {
      const scene = startAssembly();
      const def = defineInchBlock();
      const inst = insert(def);
      render();

      const part = inst.record.part;
      const e = solidOwner(part);
      const index = scene.getAllSceneObjects().indexOf(e);
      const result = getSceneManager().rollbackScene(scene, index, { partScoped: true });
      expect(result.scopePartId).toBe(part.id);
      // Rollback never rebuilds: it re-emits the members' (scaled) state.
      expect(renderedExtent(scene, e)).toBeCloseTo(IN, 3);
      expect(volume(part)).toBeCloseTo(IN ** 3, 3);
    });

    it("a cached re-render serves the scaled template once — never double-scaled", () => {
      const first = startAssembly();
      insert(defineInchBlock());
      render();

      getSceneManager().projectUnit = "mm";
      const second = getSceneManager().startAssemblyScene();
      getUnitRegistry().declare(INCH_PART_FILE, "in");
      const inst = insert(defineInchBlock());
      AssemblyCompare.compare(first, second);
      const part = inst.record.part;
      expect(second.isCached(part)).toBe(true);
      for (const member of part.getChildren()) {
        expect(second.isCached(member)).toBe(true);
      }
      render();

      expect(volume(part)).toBeCloseTo(IN ** 3, 3);
      expect(part.getUnit()).toBe("mm");
      expect(inst.connectors.top.getFrame().origin.z).toBeCloseTo(IN, 6);
    });

    it("a project-unit change invalidates the cached template", () => {
      const first = startAssembly("mm");
      insert(defineInchBlock());
      render();

      const second = startAssembly("cm");
      const inst = insert(defineInchBlock());
      AssemblyCompare.compare(first, second);
      expect(second.isCached(inst.record.part)).toBe(false);
      render();
      expect(volume(inst.record.part)).toBeCloseTo(2.54 ** 3, 6);
    });
  });

  describe("no scaling when the units agree", () => {
    it("inserted into an inch assembly: bit-identical to a plain build", () => {
      startAssembly("in");
      const def = defineInchBlock();
      const inst = insert(def);
      render();

      const part = inst.record.part;
      expect(part.isForeignUnit()).toBe(false);
      expect(part.getUnitScaleFactor()).toBe(1);
      expect(volume(part)).toBeCloseTo(1, 9);
      expect(bboxMax(solidsOf(part)[0]).z).toBeCloseTo(1, 5);
      expect(inst.connectors.top.getFrame().origin.z).toBeCloseTo(1, 9);
      expect(part.getUnit()).toBe("in");
      for (const member of part.getChildren()) {
        expect(member.getUnit()).toBe("in");
      }
    });

    it("rendered standalone (the inch file is the root): no scaling", () => {
      getSceneManager().projectUnit = "mm";
      const scene = getSceneManager().startScene();
      getSceneManager().setCurrentFile(INCH_PART_FILE);
      getUnitRegistry().declare(INCH_PART_FILE, "in");
      defineInchBlock();
      render();

      expect(scene.unit).toBe("in");
      const part = scene.getAllSceneObjects().find((o): o is Part => o instanceof Part)!;
      expect(part.isForeignUnit()).toBe(false);
      expect(part.getDefinitionUnit()).toBe("in");
      expect(part.getTargetUnit()).toBe("in");
      expect(volume(part)).toBeCloseTo(1, 9);
      expect(renderedExtent(scene, solidOwner(part))).toBeCloseTo(1, 6);
    });
  });

  describe("consumed from an mm part file", () => {
    it("def.features.<name> serves the donor scaled into the consumer's unit", () => {
      const scene = startMmPartScene();
      const def = defineInchBlock();
      // A 1 in square profile, extruded 15 mm by the consuming (mm) file —
      // as a separate body, so the default fuse doesn't merge it into the
      // donor's block.
      const consumer = extrude(15, def.features.profile).new() as unknown as SceneObject;
      render();

      expect(scene.unit).toBe("mm");
      const donor = scene.getAllSceneObjects().find((o): o is Part => o instanceof Part)!;
      expect(donor.isForeignUnit()).toBe(true);
      expect(volume(donor)).toBeCloseTo(IN ** 3, 3);
      expect(volume(consumer)).toBeCloseTo(IN * IN * 15, 3);
      const b = ShapeOps.getBoundingBox(solidsOf(consumer)[0]);
      expect(b.maxX).toBeCloseTo(IN, 4);
      expect(b.maxZ).toBeCloseTo(15, 4);
    });

    it("SceneCompare keeps a foreign part atomic: a partly matched donor rebuilds whole", () => {
      const first = startMmPartScene();
      extrude(15, defineInchBlock().features.profile).new();
      render();

      // Second render: the donor body gained a trailing statement. The
      // prefix compare matches the Part, its sketch and its extrude — and
      // would cache them with SCALED state — before diverging on the new
      // color(). A rebuilt member reading a cached 25.4 mm sketch with its
      // own inch numbers would mix units, so the whole part must rebuild.
      const second = startMmPartScene();
      const def = defineInchBlock({ tagBottom: true });
      const consumer = extrude(15, def.features.profile).new() as unknown as SceneObject;
      SceneCompare.compare(first, second);
      const donor = second.getAllSceneObjects().find((o): o is Part => o instanceof Part)!;
      const members = second.getAllSceneObjects().filter(o => second.findEnclosingPart(o) === donor);
      expect(members.length).toBeGreaterThan(2);
      expect(members.some(m => second.isCached(m))).toBe(false);
      render();
      expect(volume(donor)).toBeCloseTo(IN ** 3, 3);
      expect(volume(consumer)).toBeCloseTo(IN * IN * 15, 3);

      // An unchanged donor matches whole and is served from cache, scaled once.
      const third = startMmPartScene();
      const def3 = defineInchBlock({ tagBottom: true });
      extrude(15, def3.features.profile).new();
      SceneCompare.compare(second, third);
      const donor3 = third.getAllSceneObjects().find((o): o is Part => o instanceof Part)!;
      const members3 = third.getAllSceneObjects().filter(o => third.findEnclosingPart(o) === donor3);
      expect(members3.every(m => third.isCached(m))).toBe(true);
      render();
      expect(volume(donor3)).toBeCloseTo(IN ** 3, 3);
      expect(donor3.getUnit()).toBe("mm");
    });
  });

  it("sub-assembly occurrences consume parts in the project unit — assembly space never rescales", () => {
    // Assemblies cannot declare a unit, so an occurrence's scope runs in the
    // same unit as the root assembly: the inch part is scaled into the
    // project unit whether it is inserted at the root or inside a
    // sub-assembly, and the occurrence itself needs no scaling.
    const scene = startAssembly("cm");
    const def = defineInchBlock();
    const sub = assembly("sub", () => ({ block: insert(def) }));
    const occ = insert(sub);
    const rootInst = insert(def);
    render();

    const nested = (occ.parts as { block: Instance }).block;
    expect(nested.record.part).toBe(rootInst.record.part);
    expect(nested.record.part.getTargetUnit()).toBe("cm");
    expect(volume(nested.record.part)).toBeCloseTo(2.54 ** 3, 6);
    expect(nested.connectors.top.getFrame().origin.z).toBeCloseTo(2.54, 9);
    expect(scene.getSerializedOccurrences()).toHaveLength(1);
  });

  it("Instance binds connectors of the scaled template", () => {
    startAssembly();
    const inst = insert(defineInchBlock());
    expect(inst).toBeInstanceOf(Instance);
    render();
    expect(Object.keys(inst.connectors)).toEqual(["top"]);
    expect(inst.connectors.top.connector.getParent()).toBe(inst.record.part);
  });
});
