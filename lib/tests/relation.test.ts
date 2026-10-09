import { describe, it, expect } from "vitest";
import { getSceneManager } from "../scene-manager.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import select from "../core/select.js";
import part from "../core/part.js";
import connector from "../core/connector.js";
import insert from "../core/insert.js";
import mate from "../core/mate.js";
import relation from "../core/relation.js";
import assembly from "../core/assembly.js";
import { testRect } from "./helpers/profiles.js";
import { face } from "../filters/index.js";
import { Part } from "../features/part.js";
import { AssemblyScene } from "../rendering/assembly-scene.js";
import { RelationRules } from "../features/relation.js";

function buildHousing(name = "housing"): Part {
  return part(name, () => {
    sketch("xy", () => { testRect(20, 20); });
    extrude(10);
    connector("top", select(face().planar().onPlane("xy", 10)));
    connector("bottom", select(face().planar().onPlane("xy", 0)));
  }) as unknown as Part;
}

function startAssembly(): { p: Part; scene: AssemblyScene } {
  getSceneManager().startScene();
  const p = buildHousing();
  const scene = getSceneManager().startAssemblyScene();
  return { p, scene };
}

// relation() couples the free motions of two mates. These tests pin the
// statement's validation (types, sides, ratio, scope) and its wire form.
describe("relation()", () => {
  it("records a gear between two revolute mates and serializes mate ids live", () => {
    const { p, scene } = startAssembly();
    const base = insert(p).grounded();
    const g1 = insert(p);
    const g2 = insert(p);
    const a = mate("revolute", base.connectors.top, g1.connectors.bottom);
    const b = mate("revolute", base.connectors.bottom, g2.connectors.top);
    const built = relation("gear", a, b, 2).reverse().name("drive");
    expect(built.getRecord().relationId).toBe("rel-0");
    const [serialized] = scene.getSerializedRelations();
    expect(serialized).toMatchObject({
      relationId: "rel-0",
      owner: "",
      type: "gear",
      mateA: "mate-0",
      mateB: "mate-1",
      ratio: 2,
      reverse: true,
      name: "drive",
    });
    // Ids are read at serialize time, not snapshotted at the call.
    scene.getMates()[1].mateId = "mate-renamed";
    expect(scene.getSerializedRelations()[0].mateB).toBe("mate-renamed");
  });

  it("accepts a rack-and-pinion between a rotating and a sliding mate, cylindrical on either side", () => {
    const { p } = startAssembly();
    const base = insert(p).grounded();
    const pinion = insert(p);
    const rack = insert(p);
    const spin = mate("cylindrical", base.connectors.top, pinion.connectors.bottom);
    const travel = mate("slider", base.connectors.bottom, rack.connectors.top);
    expect(() => relation("rack-and-pinion", spin, travel, 62.8)).not.toThrow();
    const other = mate("cylindrical", base.connectors.top, rack.connectors.bottom);
    expect(() => relation("rack-and-pinion", spin, other, 10)).not.toThrow();
  });

  it("refuses mate types that have no motion to couple, naming the side", () => {
    const { p } = startAssembly();
    const base = insert(p).grounded();
    const g1 = insert(p);
    const g2 = insert(p);
    const fixed = mate("fastened", base.connectors.top, g1.connectors.bottom);
    const hinge = mate("revolute", base.connectors.bottom, g2.connectors.top);
    const slide = mate("slider", base.connectors.top, g2.connectors.bottom);
    const flat = mate("planar", base.connectors.bottom, g1.connectors.top);
    expect(() => relation("gear", fixed, hinge, 1)).toThrow(/first mate is 'fastened'/);
    expect(() => relation("gear", hinge, slide, 1)).toThrow(/second mate is 'slider'/);
    expect(() => relation("rack-and-pinion", slide, hinge, 1)).toThrow(/pinion side must be a revolute or cylindrical/);
    expect(() => relation("rack-and-pinion", hinge, flat, 1)).toThrow(/planar mate frees two directions and a spin/);
  });

  it("refuses a non-positive or non-finite ratio and points at .reverse()", () => {
    const { p } = startAssembly();
    const base = insert(p).grounded();
    const g1 = insert(p);
    const g2 = insert(p);
    const a = mate("revolute", base.connectors.top, g1.connectors.bottom);
    const b = mate("revolute", base.connectors.bottom, g2.connectors.top);
    expect(() => relation("gear", a, b, -2)).toThrow(/chain \.reverse\(\)/);
    expect(() => relation("gear", a, b, 0)).toThrow(/must be positive/);
    expect(() => relation("gear", a, b, Number.NaN)).toThrow(/finite number/);
    expect(() => relation("gear", a, b, "2" as unknown as number)).toThrow(/finite number/);
  });

  it("refuses non-mate arguments, self-relations and unknown types", () => {
    const { p } = startAssembly();
    const base = insert(p).grounded();
    const g1 = insert(p);
    const a = mate("revolute", base.connectors.top, g1.connectors.bottom);
    expect(() => relation("gear", a, a, 1)).toThrow(/cannot be related to itself/);
    expect(() => relation("gear", a, g1.connectors.top as unknown as typeof a, 1)).toThrow(/bind the mate\(\) statement to a const/);
    expect(() => relation("belt" as unknown as "gear", a, a, 1)).toThrow(/unknown relation type "belt"/);
  });

  it("is refused outside an assembly file", () => {
    getSceneManager().startScene();
    expect(() => relation("gear", {} as never, {} as never, 1)).toThrow(/only be used in \*\.assembly\.js/);
  });

  it("keeps relations in the scope of their mates", () => {
    const { p, scene } = startAssembly();
    const base = insert(p).grounded();
    const hinge = mate("revolute", base.connectors.top, insert(p).connectors.bottom);
    const sub = assembly("gearbox", () => {
      const inner = insert(p);
      const inner2 = insert(p);
      const x = mate("revolute", inner.connectors.top, inner2.connectors.bottom);
      const y = mate("revolute", inner.connectors.bottom, inner2.connectors.top);
      relation("gear", x, y, 3);
      // A root-scope mate is not reachable from inside the body.
      expect(() => relation("gear", x, hinge, 1)).toThrow(/different assembly scope/);
      return { x };
    });
    const occ = insert(sub);
    expect(scene.getSerializedRelations().map(r => [r.relationId, r.owner, r.mateA])).toEqual([
      ["asm-0/rel-0", "asm-0", "asm-0/mate-0"],
    ]);
    // And the other way round: an occurrence's mate from the root scope.
    expect(() => relation("gear", hinge, occ.parts.x, 1)).toThrow(/different assembly scope/);
  });

  it("rejects duplicate names within a scope", () => {
    const { p } = startAssembly();
    const base = insert(p).grounded();
    const g1 = insert(p);
    const g2 = insert(p);
    const a = mate("revolute", base.connectors.top, g1.connectors.bottom);
    const b = mate("revolute", base.connectors.bottom, g2.connectors.top);
    const c = mate("revolute", g1.connectors.top, g2.connectors.bottom);
    relation("gear", a, b, 1).name("drive");
    expect(() => relation("gear", b, c, 1).name("drive")).toThrow(/duplicate name/);
    expect(() => relation("gear", b, c, 1).name(" ")).toThrow(/non-empty/);
  });

  it("exposes the side rules the server and the dialog mirror", () => {
    expect(RelationRules.sideBTypes("gear")).toEqual(["revolute", "cylindrical"]);
    expect(RelationRules.sideBTypes("rack-and-pinion")).toEqual(["slider", "cylindrical"]);
    expect(RelationRules.sideProblem("gear", "revolute", "cylindrical")).toBeNull();
    expect(RelationRules.ratioProblem("gear", 0.5)).toBeNull();
  });
});
