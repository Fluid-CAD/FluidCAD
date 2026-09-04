import { describe, it, expect, beforeEach } from "vitest";
import { getSceneManager } from "../scene-manager.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import select from "../core/select.js";
import part from "../core/part.js";
import connector from "../core/connector.js";
import expose from "../core/expose.js";
import assembly from "../core/assembly.js";
import insert from "../core/insert.js";
import mate from "../core/mate.js";
import replicate from "../core/replicate.js";
import { testRect } from "./helpers/profiles.js";
import { face } from "../filters/index.js";
import { Part } from "../features/part.js";
import { Instance } from "../features/instance.js";
import { Occurrence } from "../features/occurrence.js";
import { Connector } from "../features/connector.js";
import { AssemblyScene } from "../rendering/assembly-scene.js";

// `replicate(seed, targets, rows)`: copy a mated instance / sub-assembly onto
// new mate targets. Replicas are ordinary flat-scene records (counter ids,
// same part template / re-run definition body) tagged `replica`, with the
// seed's mates re-targeted per row; the statement itself is recorded for the
// UI's edit dialog. See docs/assembly-replicate-plan.md.

function buildBlock(name = "block"): Part {
  return part(name, () => {
    sketch("xy", () => { testRect(20, 20); });
    extrude(10);
    connector("top", select(face().planar().onPlane("xy", 10)));
    connector("bottom", select(face().planar().onPlane("xy", 0)));
    expose("skin", select(face().planar().onPlane("xy", 10)));
  }) as unknown as Part;
}

function buildRail(): Part {
  return part("rail", () => {
    sketch("xy", () => { testRect(100, 20); });
    extrude(10);
    connector("s1", select(face().planar().onPlane("xy", 10))).offset(-30, 0, 0);
    connector("s2", select(face().planar().onPlane("xy", 10)));
    connector("s3", select(face().planar().onPlane("xy", 10))).offset(30, 0, 0);
    expose("deck", select(face().planar().onPlane("xy", 10)));
  }) as unknown as Part;
}

function startAssembly(): { block: Part; rail: Part; scene: AssemblyScene } {
  getSceneManager().startScene();
  const block = buildBlock();
  const rail = buildRail();
  const scene = getSceneManager().startAssemblyScene();
  return { block, rail, scene };
}

describe("replicate()", () => {
  beforeEach(() => {
    getSceneManager().startScene();
  });

  describe("instance seed", () => {
    it("re-inserts the seed per row and re-targets its mates", () => {
      const { block, rail, scene } = startAssembly();
      const base = insert(rail).grounded();
      const b1 = insert(block).translate(1, 2, 3);
      mate("fastened", b1.connectors.bottom, base.connectors.s1).rotate(90);

      const copies = replicate(b1, [base.connectors.s1], [[base.connectors.s2], [base.connectors.s3]]);

      expect(copies).toHaveLength(2);
      expect(copies[0]).toBeInstanceOf(Instance);
      const instances = scene.getInstances();
      expect(instances.map(i => i.instanceId)).toEqual(["inst-0", "inst-1", "inst-2", "inst-3"]);
      expect(copies.map(c => c.record.instanceId)).toEqual(["inst-2", "inst-3"]);

      // Same template, copied local pose (fresh objects), never grounded, derived names.
      for (const [k, replica] of [instances[2], instances[3]].entries()) {
        expect(replica.part).toBe(b1.record.part);
        expect(replica.position).toEqual({ x: 1, y: 2, z: 3 });
        expect(replica.position).not.toBe(b1.record.position);
        expect(replica.quaternion).toEqual(b1.record.quaternion);
        expect(replica.grounded).toBe(false);
        expect(replica.owner).toBe("");
        expect(replica.name).toBe(`block (${k + 2})`);
        expect(replica.replica).toEqual({ of: "inst-1", statement: "rep-0", row: k });
      }
      expect(b1.record.replica).toBeUndefined();

      const mates = scene.getMates();
      expect(mates.map(m => m.mateId)).toEqual(["mate-0", "mate-1", "mate-2"]);
      const bottom = b1.record.part.getNamedConnectors().bottom;
      const railConnectors = base.record.part.getNamedConnectors();
      expect(mates[1].type).toBe("fastened");
      expect(mates[1].connectorA).toEqual({ instanceId: "inst-2", connector: bottom });
      expect(mates[1].connectorB).toEqual({ instanceId: "inst-0", connector: railConnectors.s2 });
      expect(mates[2].connectorA).toEqual({ instanceId: "inst-3", connector: bottom });
      expect(mates[2].connectorB).toEqual({ instanceId: "inst-0", connector: railConnectors.s3 });
      expect(mates[1].replica).toEqual({ of: "mate-0", statement: "rep-0", row: 0 });
      expect(mates[2].replica).toEqual({ of: "mate-0", statement: "rep-0", row: 1 });
      expect(mates[0].replica).toBeUndefined();

      const rep = scene.getReplicates();
      expect(rep).toHaveLength(1);
      expect(rep[0]).toMatchObject({
        replicateId: "rep-0",
        owner: "",
        seed: { instanceId: "inst-1" },
        targets: [{ kind: "connector", instanceId: "inst-0", connector: railConnectors.s1 }],
        rows: [
          [{ kind: "connector", instanceId: "inst-0", connector: railConnectors.s2 }],
          [{ kind: "connector", instanceId: "inst-0", connector: railConnectors.s3 }],
        ],
        produced: [{ instanceId: "inst-2" }, { instanceId: "inst-3" }],
      });
    });

    it("copies mate options verbatim into independent option objects", () => {
      const { block, rail, scene } = startAssembly();
      const base = insert(rail).grounded();
      const b1 = insert(block);
      mate("revolute", b1.connectors.bottom, base.connectors.s1).flip().rotate(45).limits(-30, 30);
      mate("slider", b1.connectors.top, base.connectors.s2).offset(0, 0, 5);

      replicate(b1, [base.connectors.s1, base.connectors.s2], [[base.connectors.s2, base.connectors.s3]]);

      const mates = scene.getMates();
      expect(mates).toHaveLength(4);
      expect(mates[2].options).toEqual({ flip: true, rotate: 45, limits: [-30, 30] });
      expect(mates[2].options).not.toBe(mates[0].options);
      expect(mates[2].options!.limits).not.toBe(mates[0].options!.limits);
      expect(mates[3].options).toEqual({ offset: [0, 0, 5] });
      expect(mates[3].options!.offset).not.toBe(mates[1].options!.offset);
      expect(mates[3].type).toBe("slider");
    });

    it("keeps an unlisted outer target shared by every replica", () => {
      const { block, rail, scene } = startAssembly();
      const base = insert(rail).grounded();
      const lid = insert(block);
      const b1 = insert(block);
      mate("fastened", b1.connectors.bottom, base.connectors.s1);
      mate("planar", b1.connectors.top, lid.connectors.bottom);

      const [b2] = replicate(b1, [base.connectors.s1], [[base.connectors.s2]]);

      const mates = scene.getMates();
      expect(mates).toHaveLength(4);
      expect(mates[2].connectorA!.instanceId).toBe(b2.record.instanceId);
      expect(mates[2].connectorB).toEqual({
        instanceId: base.record.instanceId,
        connector: base.record.part.getNamedConnectors().s2,
      });
      // The planar mate's lid side was not a column: it stays on the lid.
      expect(mates[3].type).toBe("planar");
      expect(mates[3].connectorA).toEqual({
        instanceId: b2.record.instanceId,
        connector: b1.record.part.getNamedConnectors().top,
      });
      expect(mates[3].connectorB).toEqual({
        instanceId: lid.record.instanceId,
        connector: lid.record.part.getNamedConnectors().bottom,
      });
    });

    it("replicates a tangent mate over an exposed-geometry column", () => {
      const { block, rail, scene } = startAssembly();
      const base = insert(rail).grounded();
      const other = insert(rail);
      const b1 = insert(block);
      mate("tangent", b1.features.skin, base.features.deck).noPropagate();

      const [b2] = replicate(b1, [base.features.deck], [[other.features.deck]]);

      const mates = scene.getMates();
      expect(mates).toHaveLength(2);
      expect(mates[1].type).toBe("tangent");
      expect(mates[1].geometryA).toEqual({
        instanceId: b2.record.instanceId,
        exposed: b1.features.skin.exposed,
      });
      expect(mates[1].geometryB).toEqual({
        instanceId: other.record.instanceId,
        exposed: other.features.deck.exposed,
      });
      expect(mates[1].options).toEqual({ propagate: false });
      expect(scene.getReplicates()[0].targets).toEqual([
        { kind: "geometry", instanceId: base.record.instanceId, exposed: base.features.deck.exposed },
      ]);
    });

    it("swaps an assembly-connector column for another assembly connector", () => {
      const { block, scene } = startAssembly();
      const bore1 = connector("bore1", [0, 0, 0]) as unknown as Connector;
      const bore2 = connector("bore2", [0, 50, 0]) as unknown as Connector;
      const b1 = insert(block);
      mate("slider", bore1, b1.connectors.top).offset(0, 0, 5);

      const [b2] = replicate(b1, [bore1], [[bore2]]);

      const mates = scene.getMates();
      expect(mates).toHaveLength(2);
      expect(mates[1].frameA).toEqual({ connector: bore2 });
      expect(mates[1].connectorA).toBeUndefined();
      expect(mates[1].connectorB).toEqual({
        instanceId: b2.record.instanceId,
        connector: b1.record.part.getNamedConnectors().top,
      });
      expect(mates[1].options).toEqual({ offset: [0, 0, 5] });
      expect(scene.getReplicates()[0].rows).toEqual([[{ kind: "frame", connector: bore2 }]]);
    });

    it("type-checks the public connector() handle as a target (no cast)", () => {
      // `connector(name, [x, y, z])` returns `IConnector` to user code — the
      // shape the editor's type checker sees. Passing it (and a `.rotate()`
      // chain) straight into replicate() must compile: this test is covered
      // by `tsc -b`, so a narrowed ReplicateTarget fails the build, not just
      // the editor. Regression for "No overload matches this call".
      const { block, scene } = startAssembly();
      const bore1 = connector("bore1", [0, 0, 0]).rotate("x", -90);
      const bore2 = connector("bore2", [0, 50, 0]);
      const b1 = insert(block);
      mate("slider", bore1, b1.connectors.top);

      const [b2] = replicate(b1, [bore1], [[bore2]]);

      expect(b2).toBeInstanceOf(Instance);
      expect(scene.getMates()[1].frameA).toEqual({ connector: bore2 });
    });

    it("returns handles that later statements can mate and name", () => {
      const { block, rail, scene } = startAssembly();
      const base = insert(rail).grounded();
      const lid = insert(block);
      const b1 = insert(block);
      mate("fastened", b1.connectors.bottom, base.connectors.s1);

      const [b2, b3] = replicate(b1, [base.connectors.s1], [[base.connectors.s2], [base.connectors.s3]]);
      b3.name("third");
      mate("planar", b3.connectors.top, lid.connectors.bottom);

      expect(b2.record.name).toBe("block (2)");
      expect(b3.record.name).toBe("third");
      const last = scene.getMates().at(-1)!;
      expect(last.type).toBe("planar");
      expect(last.connectorA!.instanceId).toBe(b3.record.instanceId);
      expect(last.replica).toBeUndefined();
    });

    it("does not replicate mates written after the statement", () => {
      const { block, rail, scene } = startAssembly();
      const base = insert(rail).grounded();
      const lid = insert(block);
      const b1 = insert(block);
      mate("fastened", b1.connectors.bottom, base.connectors.s1);

      replicate(b1, [base.connectors.s1], [[base.connectors.s2]]);
      mate("planar", b1.connectors.top, lid.connectors.bottom);

      const mates = scene.getMates();
      expect(mates).toHaveLength(3);
      expect(mates.filter(m => m.type === "planar")).toHaveLength(1);
      expect(mates.filter(m => m.replica)).toHaveLength(1);
    });
  });

  describe("occurrence seed", () => {
    it("re-runs the definition body and maps inner sides through the new occurrence path", () => {
      const { block, rail, scene } = startAssembly();
      const inner = assembly("inner", () => ({ b: insert(block) }));
      const sub = assembly("sub", () => {
        const a = insert(block).grounded();
        const nested = insert(inner);
        mate("fastened", nested.parts.b.connectors.bottom, a.connectors.top);
        return { a, nested };
      });
      const base = insert(rail).grounded();
      const s1 = insert(sub).translate(5, 0, 0);
      mate("fastened", s1.parts.a.connectors.bottom, base.connectors.s1);
      mate("planar", s1.parts.nested.parts.b.connectors.top, base.connectors.s2);

      const [s2] = replicate(s1, [base.connectors.s1], [[base.connectors.s3]]);

      expect(s2).toBeInstanceOf(Occurrence);
      expect(scene.getOccurrences().map(o => o.occurrenceId)).toEqual([
        "asm-0", "asm-0/asm-0", "asm-1", "asm-1/asm-0",
      ]);
      expect(s2.record).toMatchObject({
        occurrenceId: "asm-1",
        assemblyName: "sub",
        name: "sub (2)",
        parentPath: "",
        position: { x: 5, y: 0, z: 0 },
        grounded: false,
        replica: { of: "asm-0", statement: "rep-0", row: 0 },
      });
      expect(s2.record.position).not.toBe(s1.record.position);
      expect(s2.record.definition).toBe(sub);
      expect(s2.record.exports).toEqual([
        { path: ["a"], instanceId: "asm-1/inst-0" },
        { path: ["nested"], occurrenceId: "asm-1/asm-0" },
      ]);
      expect(scene.getInstances().map(i => i.instanceId)).toEqual([
        "inst-0", "asm-0/inst-0", "asm-0/asm-0/inst-0", "asm-1/inst-0", "asm-1/asm-0/inst-0",
      ]);
      // The replica's handle exposes the replica's own instances.
      expect(s2.parts.a.record.instanceId).toBe("asm-1/inst-0");
      expect(s2.parts.nested.parts.b.record.instanceId).toBe("asm-1/asm-0/inst-0");
      // Anchors inside the body keep their DECLARED grounding; the replica frame is ungrounded.
      expect(s2.parts.a.record.grounded).toBe(true);
      expect(scene.getSerializedInstances().find(i => i.instanceId === "asm-1/inst-0")!.grounded).toBe(false);

      const mates = scene.getMates();
      expect(mates.map(m => m.mateId)).toEqual([
        "asm-0/mate-0", "mate-0", "mate-1", "asm-1/mate-0", "mate-2", "mate-3",
      ]);
      const blockConnectors = block.getNamedConnectors();
      const railConnectors = base.record.part.getNamedConnectors();
      expect(mates[4]).toMatchObject({
        type: "fastened",
        owner: "",
        connectorA: { instanceId: "asm-1/inst-0", connector: blockConnectors.bottom },
        connectorB: { instanceId: "inst-0", connector: railConnectors.s3 },
        replica: { of: "mate-0", statement: "rep-0", row: 0 },
      });
      // Nested inner side maps two levels deep; the unlisted s2 target is shared.
      expect(mates[5]).toMatchObject({
        type: "planar",
        connectorA: { instanceId: "asm-1/asm-0/inst-0", connector: blockConnectors.top },
        connectorB: { instanceId: "inst-0", connector: railConnectors.s2 },
        replica: { of: "mate-1", statement: "rep-0", row: 0 },
      });
      // The body's own mate re-ran under the replica scope — no replica tag.
      expect(mates[3].owner).toBe("asm-1");
      expect(mates[3].replica).toBeUndefined();
      expect(scene.getReplicates()[0].produced).toEqual([{ occurrenceId: "asm-1" }]);
    });

    it("re-runs the body with the seed's parameter overrides", () => {
      const { block, rail, scene } = startAssembly();
      let seen: unknown[] = [];
      const sub = assembly("sub", () => {
        seen.push("run");
        return { a: insert(block) };
      });
      const base = insert(rail).grounded();
      const s1 = insert(sub, { Width: 42 });
      mate("fastened", s1.parts.a.connectors.bottom, base.connectors.s1);
      seen = [];

      const [s2] = replicate(s1, [base.connectors.s1], [[base.connectors.s2]]);

      expect(seen).toEqual(["run"]);
      expect(s2.record.overrides).toEqual({ Width: 42 });
      expect(scene.getOccurrences()[1].overrides).toEqual({ Width: 42 });
    });
  });

  describe("inside an assembly() body", () => {
    it("scopes ids and mates to the occurrence and exports the returned array by index", () => {
      const { block, rail, scene } = startAssembly();
      const sub = assembly("sub", () => {
        const anchor = insert(rail).grounded();
        const b = insert(block);
        mate("fastened", b.connectors.bottom, anchor.connectors.s1);
        const copies = replicate(b, [anchor.connectors.s1], [[anchor.connectors.s2], [anchor.connectors.s3]]);
        return { anchor, b, copies };
      });

      const occ = insert(sub);

      expect(occ.record.exports).toEqual([
        { path: ["anchor"], instanceId: "asm-0/inst-0" },
        { path: ["b"], instanceId: "asm-0/inst-1" },
        { path: ["copies", "0"], instanceId: "asm-0/inst-2" },
        { path: ["copies", "1"], instanceId: "asm-0/inst-3" },
      ]);
      const rep = scene.getReplicates();
      expect(rep).toHaveLength(1);
      expect(rep[0].replicateId).toBe("asm-0/rep-0");
      expect(rep[0].owner).toBe("asm-0");
      expect(rep[0].produced).toEqual([{ instanceId: "asm-0/inst-2" }, { instanceId: "asm-0/inst-3" }]);
      expect(scene.getMates().map(m => m.mateId)).toEqual(["asm-0/mate-0", "asm-0/mate-1", "asm-0/mate-2"]);
      expect(scene.getMates()[1].replica).toEqual({ of: "asm-0/mate-0", statement: "asm-0/rep-0", row: 0 });
    });

    it("indexes plain arrays in occurrence exports", () => {
      const { block } = startAssembly();
      const def = assembly("pair", () => ({ list: [insert(block), insert(block)] }));
      const occ = insert(def);
      expect(occ.record.exports).toEqual([
        { path: ["list", "0"], instanceId: "asm-0/inst-0" },
        { path: ["list", "1"], instanceId: "asm-0/inst-1" },
      ]);
    });
  });

  describe("errors", () => {
    it("refuses outside an assembly scene", () => {
      expect(() => replicate(null as any, [], [])).toThrow(/assembly\.js/i);
    });

    it("rejects a seed that is not an insert() handle of this scope", () => {
      const { block, rail } = startAssembly();
      expect(() => replicate("nope" as any, [], [])).toThrow(/seed must be an instance or sub-assembly inserted in this assembly/);

      const base = insert(rail).grounded();
      const sub = assembly("sub", () => ({ a: insert(block) }));
      const occ = insert(sub);
      mate("fastened", occ.parts.a.connectors.bottom, base.connectors.s1);
      expect(() => replicate(occ.parts.a, [base.connectors.s1], [[base.connectors.s2]]))
        .toThrow(/inserted inside sub-assembly "asm-0"; replicate it from the file that inserts it/);
    });

    it("rejects a seed with no mates", () => {
      const { block, rail } = startAssembly();
      const base = insert(rail).grounded();
      const b1 = insert(block);
      expect(() => replicate(b1, [base.connectors.s1], [[base.connectors.s2]]))
        .toThrow(/"block" has no mates to replicate — mate it first/);
    });

    it("validates the target list against the seed's outer sides", () => {
      const { block, rail } = startAssembly();
      const base = insert(rail).grounded();
      const lid = insert(block);
      const b1 = insert(block);
      mate("fastened", b1.connectors.bottom, base.connectors.s1);

      expect(() => replicate(b1, "s1" as any, [])).toThrow(/second argument lists the seed's mate targets/);
      expect(() => replicate(b1, [], [])).toThrow(/at least one mate target/);
      expect(() => replicate(b1, ["s1" as any], [])).toThrow(/target 1 must be a connector .* got string/);
      expect(() => replicate(b1, [lid.connectors.top], [[base.connectors.s2]]))
        .toThrow(/block\.top is not a mate target of "block" — its targets are: rail\.s1\./);
      // The seed's own (inner) side is not a target either.
      expect(() => replicate(b1, [b1.connectors.bottom], [[base.connectors.s2]]))
        .toThrow(/block\.bottom is not a mate target of "block"/);
      expect(() => replicate(b1, [base.connectors.s1, base.connectors.s1], [[base.connectors.s2, base.connectors.s3]]))
        .toThrow(/target 2 \(rail\.s1\) repeats target 1/);
      expect(() => replicate(b1, [b1.record.part.getNamedConnectors().top as any], [[base.connectors.s2]]))
        .toThrow(/connector "top" is a part connector with no instance/);
    });

    it("validates rows cell by cell", () => {
      const { block, rail } = startAssembly();
      const base = insert(rail).grounded();
      const other = insert(rail);
      const b1 = insert(block);
      mate("fastened", b1.connectors.bottom, base.connectors.s1);
      mate("tangent", b1.features.skin, base.features.deck);
      const targets = [base.connectors.s1, base.features.deck];

      expect(() => replicate(b1, targets, [])).toThrow(/at least one row \(one replica\) is required/);
      expect(() => replicate(b1, targets, "rows" as any)).toThrow(/at least one row/);
      expect(() => replicate(b1, targets, ["x" as any])).toThrow(/row 1 must be an array of replacements/);
      expect(() => replicate(b1, targets, [[base.connectors.s2]])).toThrow(/row 1 has 1 entry, expected 2 \(one per target\)/);
      expect(() => replicate(b1, targets, [[base.features.deck, other.features.deck]]))
        .toThrow(/row 1, column 1 — expected a connector like rail\.s1, got exposed geometry/);
      expect(() => replicate(b1, targets, [[base.connectors.s2, other.connectors.s2]]))
        .toThrow(/row 1, column 2 — expected exposed geometry like rail\.deck, got a connector/);
      expect(() => replicate(b1, targets, [[base.connectors.s2, 7 as any]]))
        .toThrow(/row 1, column 2 — expected exposed geometry like rail\.deck, got number/);
      expect(() => replicate(b1, targets, [[b1.connectors.top, other.features.deck]]))
        .toThrow(/row 1, column 1 — the replacement sits on the seed itself/);
    });

    it("keeps assembly connectors root-scope only", () => {
      const { block, scene } = startAssembly();
      const bore = connector("bore", [0, 0, 0]) as unknown as Connector;
      const sub = assembly("sub", () => {
        const a = insert(block);
        const b = insert(block);
        mate("fastened", a.connectors.top, b.connectors.bottom);
        replicate(a, [b.connectors.bottom], [[bore]]);
        return { a, b };
      });
      expect(() => insert(sub)).toThrow(/row 1, column 1 — assembly connectors are root-scope only/);
      expect(scene.getReplicates()).toHaveLength(0);
    });
  });

  describe("serialization", () => {
    it("carries replica tags and the replicate records in the assembly payload", () => {
      const { block, rail, scene } = startAssembly();
      const bore1 = connector("bore1", [0, 0, 0]) as unknown as Connector;
      const bore2 = connector("bore2", [0, 50, 0]) as unknown as Connector;
      const base = insert(rail).grounded();
      const b1 = insert(block);
      mate("fastened", b1.connectors.bottom, base.connectors.s1);
      mate("slider", bore1, b1.connectors.top);
      mate("tangent", b1.features.skin, base.features.deck);
      const sub = assembly("sub", () => ({ a: insert(block) }));
      const s1 = insert(sub);
      mate("fastened", s1.parts.a.connectors.bottom, base.connectors.s2);

      replicate(b1, [base.connectors.s1, bore1], [[base.connectors.s3, bore2]]);
      replicate(s1, [base.connectors.s2], [[base.connectors.s3]]);

      const data = getSceneManager().getAssemblyData(scene)!;
      const railConnectors = base.record.part.getNamedConnectors();
      expect(data.replicates).toEqual([
        {
          replicateId: "rep-0",
          owner: "",
          seed: { instanceId: "inst-1" },
          targets: [
            { kind: "connector", instanceId: "inst-0", connectorId: railConnectors.s1.id },
            { kind: "frame", connectorId: bore1.id },
          ],
          rows: [[
            { kind: "connector", instanceId: "inst-0", connectorId: railConnectors.s3.id },
            { kind: "frame", connectorId: bore2.id },
          ]],
          produced: [{ instanceId: "inst-2" }],
          sourceLocation: undefined,
        },
        {
          replicateId: "rep-1",
          owner: "",
          seed: { occurrenceId: "asm-0" },
          targets: [{ kind: "connector", instanceId: "inst-0", connectorId: railConnectors.s2.id }],
          rows: [[{ kind: "connector", instanceId: "inst-0", connectorId: railConnectors.s3.id }]],
          produced: [{ occurrenceId: "asm-1" }],
          sourceLocation: undefined,
        },
      ]);
      const inst = data.instances.find(i => i.instanceId === "inst-2")!;
      expect(inst.replica).toEqual({ of: "inst-1", statement: "rep-0", row: 0 });
      expect(inst.name).toBe("block (2)");
      expect(inst.grounded).toBe(false);
      expect(data.instances.find(i => i.instanceId === "inst-1")!.replica).toBeUndefined();
      const occ = data.occurrences.find(o => o.occurrenceId === "asm-1")!;
      expect(occ.replica).toEqual({ of: "asm-0", statement: "rep-1", row: 0 });
      expect(occ.name).toBe("sub (2)");
      // Replicated mates: the three seed mates re-targeted, then the occurrence's one.
      const replicated = data.mates.filter(m => m.replica);
      expect(replicated.map(m => [m.type, m.replica!.of, m.replica!.statement])).toEqual([
        ["fastened", "mate-0", "rep-0"],
        ["slider", "mate-1", "rep-0"],
        ["tangent", "mate-2", "rep-0"],
        ["fastened", "mate-3", "rep-1"],
      ]);
      expect(replicated[1].frameA).toEqual({ connectorId: bore2.id });
      expect(replicated[2].geometryA).toEqual({ instanceId: "inst-2", exposeName: "skin" });
      expect(replicated[3].connectorA!.instanceId).toBe("asm-1/inst-0");
      expect(replicated[3].connectorB!.connectorId).toBe(railConnectors.s3.id);
    });

    it("keeps replica ids stable across a re-render through compare", () => {
      const build = (): AssemblyScene => {
        getSceneManager().startScene();
        const block = buildBlock();
        const rail = buildRail();
        const scene = getSceneManager().startAssemblyScene();
        const base = insert(rail).grounded();
        const b1 = insert(block);
        mate("fastened", b1.connectors.bottom, base.connectors.s1);
        replicate(b1, [base.connectors.s1], [[base.connectors.s2], [base.connectors.s3]]);
        return scene;
      };
      const first = build();
      getSceneManager().renderScene(first);
      const before = getSceneManager().getAssemblyData(first)!;

      const second = build();
      const merged = getSceneManager().compare(first, second) as AssemblyScene;
      getSceneManager().renderScene(merged);
      const after = getSceneManager().getAssemblyData(merged)!;

      expect(after.instances.map(i => [i.instanceId, i.name, i.replica]))
        .toEqual(before.instances.map(i => [i.instanceId, i.name, i.replica]));
      expect(after.mates.map(m => [m.mateId, m.replica])).toEqual(before.mates.map(m => [m.mateId, m.replica]));
      expect(after.replicates.map(r => [r.replicateId, r.seed, r.produced]))
        .toEqual(before.replicates.map(r => [r.replicateId, r.seed, r.produced]));
      // Connector ids on the replicate sides are the LIVE ids of the merged scene.
      const railS2 = after.instances[0].partId;
      expect(after.replicates[0].rows[0][0]).toMatchObject({ kind: "connector", instanceId: "inst-0" });
      expect(after.mates[1].connectorB!.connectorId).toBe((after.replicates[0].rows[0][0] as { connectorId: string }).connectorId);
      expect(typeof railS2).toBe("string");
    });
  });
});
