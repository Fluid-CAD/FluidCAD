import { describe, expect, it } from "vitest";
import {
  Quaternion,
  Solver,
  Vector3,
  emptySolverOutput,
  type BodyState,
  type ConnectorState,
  type MateRecord,
  type RelationRecord,
} from "../../assembly-solver/index.js";

// A mate whose side names something the input does not carry never reaches
// the solve: it constrains nothing, so it is neither failed nor satisfied.
// The output names it instead of letting it pass for a mate that holds.

const connector = (connectorId: string): ConnectorState => ({
  connectorId,
  localOrigin: new Vector3(0, 0, 0),
  localXDirection: new Vector3(1, 0, 0),
  localNormal: new Vector3(0, 0, 1),
});

const body = (instanceId: string, grounded: boolean, x: number): BodyState => ({
  instanceId,
  grounded,
  position: new Vector3(x, 0, 0),
  quaternion: new Quaternion(),
  connectors: [connector("hub")],
  contacts: [{ exposeName: "torus", seed: null, chain: [] }],
});

const revolute = (mateId: string, a: [string, string], b: [string, string]): MateRecord => ({
  mateId,
  type: "revolute",
  connectorA: { instanceId: a[0], connectorId: a[1] },
  connectorB: { instanceId: b[0], connectorId: b[1] },
});

describe("unenforced mates and relations", () => {
  it("a solve that enforces everything reports none", () => {
    const out = new Solver().solve({
      bodies: [body("a", true, 0), body("b", false, 30)],
      mates: [revolute("m", ["a", "hub"], ["b", "hub"])],
    });
    expect(out.unenforced).toEqual([]);
    expect(out.unenforcedRelations).toEqual([]);
  });

  it("names a mate on a body, a connector or an exposure form the input does not carry", () => {
    const mates: MateRecord[] = [
      revolute("held", ["a", "hub"], ["b", "hub"]),
      revolute("no-body", ["a", "hub"], ["gone", "hub"]),
      revolute("no-connector", ["a", "hub"], ["b", "missing"]),
      {
        mateId: "unusable-surface",
        type: "tangent",
        geometryA: { instanceId: "a", exposeName: "torus" },
        geometryB: { instanceId: "b", exposeName: "torus" },
      },
    ];

    const out = new Solver().solve({ bodies: [body("a", true, 0), body("b", false, 30)], mates });

    expect(out.unenforced).toEqual(["no-body", "no-connector", "unusable-surface"]);
    // They are not failures: the one mate that reached the solve holds.
    expect(out.failed).toEqual([]);
    expect(out.result).toBe("okay");
  });

  it("names a relation whose mate never reached the solve", () => {
    const relations: RelationRecord[] = [
      { relationId: "orphan", type: "gear", mateA: "held", mateB: "no-body", ratio: 2, reverse: false },
    ];
    const out = new Solver().solve({
      bodies: [body("a", true, 0), body("b", false, 30)],
      mates: [revolute("held", ["a", "hub"], ["b", "hub"]), revolute("no-body", ["a", "hub"], ["gone", "hub"])],
      relations,
    });

    expect(out.unenforcedRelations).toEqual(["orphan"]);
    expect(out.failedRelations).toEqual([]);
  });

  it("the empty output carries the same fields a solve does", () => {
    const solved = new Solver().solve({ bodies: [], mates: [] });
    expect(Object.keys(emptySolverOutput()).sort()).toEqual(Object.keys(solved).sort());
    expect(emptySolverOutput()).toEqual(solved);
  });
});
