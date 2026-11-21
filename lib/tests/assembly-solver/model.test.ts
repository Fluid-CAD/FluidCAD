import { describe, expect, it } from "vitest";
import {
  AssemblySolverModel,
  Quaternion,
  Solver,
  Vector3,
  WORLD_BODY_ID,
  type AssemblySolveSource,
  type BodyState,
  type PartMateGeometry,
} from "../../assembly-solver/index.js";

// AssemblySolverModel turns one render's records into the solver's input —
// the single builder the viewer and the engine share.

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

/** A part with one connector at its origin, Z up, and one exposure. */
const PLATE: PartMateGeometry = {
  connectors: [
    { connectorId: "plate/face", origin: { x: 0, y: 0, z: 0 }, xDirection: { x: 1, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
  ],
  exposures: [{ name: "rim" }],
};

function source(overrides: Partial<AssemblySolveSource> = {}): AssemblySolveSource {
  return {
    instances: [
      { instanceId: "inst-0", partId: "plate", position: { x: 0, y: 0, z: 0 }, quaternion: IDENTITY, grounded: true },
      { instanceId: "inst-1", partId: "plate", position: { x: 50, y: 0, z: 0 }, quaternion: IDENTITY, grounded: false },
      { instanceId: "inst-2", partId: "ghost", position: { x: 0, y: 9, z: 0 }, quaternion: IDENTITY, grounded: false },
    ],
    mates: [],
    partGeometry: partId => (partId === "plate" ? PLATE : null),
    ...overrides,
  };
}

describe("AssemblySolverModel", () => {
  it("builds one body per instance in record order, at its statement pose", () => {
    const bodies = new AssemblySolverModel(source()).bodies();

    expect(bodies.map(b => b.instanceId)).toEqual(["inst-0", "inst-1", "inst-2"]);
    expect(bodies.map(b => b.grounded)).toEqual([true, false, false]);
    expect(bodies[1].position).toBeInstanceOf(Vector3);
    expect(bodies[1].quaternion).toBeInstanceOf(Quaternion);
    expect([bodies[1].position.x, bodies[1].position.y, bodies[1].position.z]).toEqual([50, 0, 0]);
  });

  it("gives every instance of a part the same frames and contacts, and a part it does not hold none", () => {
    const model = new AssemblySolverModel(source());
    const [a, b, ghost] = model.bodies();

    expect(a.connectors).toBe(b.connectors);
    expect(a.connectors.map(c => c.connectorId)).toEqual(["plate/face"]);
    expect(a.contacts).toEqual([{ exposeName: "rim", seed: null, chain: [] }]);
    expect(ghost.connectors).toEqual([]);
    expect(model.geometryOf("inst-1")).toBe(model.geometryOfPart("plate"));
    expect(model.geometryOf("nope")).toBeNull();
  });

  it("hands out fresh bodies and poses on every call — a solve writes into them", () => {
    const model = new AssemblySolverModel(source());
    const first = model.bodies();
    const second = model.bodies();

    expect(first[0]).not.toBe(second[0]);
    expect(first[0].position).not.toBe(second[0].position);
    first[1].position.set(1, 2, 3);
    expect(model.bodies()[1].position.x).toBe(50);
  });

  it("poses the instances where the caller has them and leaves out the ones it has none for", () => {
    const model = new AssemblySolverModel(source());
    const live = { position: { x: 7, y: 8, z: 9 }, quaternion: IDENTITY };

    const bodies = model.bodies(id => (id === "inst-2" ? null : live));

    expect(bodies.map(b => b.instanceId)).toEqual(["inst-0", "inst-1"]);
    expect(bodies[0].position.x).toBe(7);
    // The caller's pose object is read, never kept.
    expect(bodies[0].position).not.toBe(live.position);
  });

  it("turns an assembly-connector side into a connector on the world body, added only when a mate needs it", () => {
    const connectors = [
      { connectorId: "datum", origin: { x: 0, y: 0, z: 20 }, xDirection: { x: 1, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
    ];
    const plain = new AssemblySolverModel(source({ connectors }));
    expect(plain.input().bodies.map(b => b.instanceId)).toEqual(["inst-0", "inst-1", "inst-2"]);

    const mated = new AssemblySolverModel(source({
      connectors,
      mates: [{
        mateId: "mate-0",
        type: "fastened",
        frameA: { connectorId: "datum" },
        connectorB: { instanceId: "inst-1", connectorId: "plate/face" },
        options: { flip: true },
      }],
    }));

    expect(mated.mates[0].connectorA).toEqual({ instanceId: WORLD_BODY_ID, connectorId: "datum" });
    const input = mated.input();
    expect(input.bodies.map(b => b.instanceId)).toEqual(["inst-0", "inst-1", "inst-2", WORLD_BODY_ID]);

    const out = new Solver().solve(input);
    expect(out.result).toBe("okay");
    const moved = out.bodies.find(b => b.instanceId === "inst-1");
    expect([moved.position.x, moved.position.y, moved.position.z]).toEqual([0, 0, 20]);
  });

  it("solves a candidate mate set and extra bodies in place of the records' own", () => {
    const model = new AssemblySolverModel(source({
      mates: [{
        mateId: "mate-0",
        type: "fastened",
        connectorA: { instanceId: "inst-0", connectorId: "plate/face" },
        connectorB: { instanceId: "inst-1", connectorId: "plate/face" },
      }],
      relations: [{ relationId: "rel-0", type: "gear", mateA: "mate-0", mateB: "mate-0", ratio: 2, reverse: false }],
    }));
    const preview: BodyState = {
      instanceId: "preview",
      position: new Vector3(1, 1, 1),
      quaternion: new Quaternion(),
      grounded: false,
      connectors: [],
    };

    const own = model.input();
    expect(own.mates).toBe(model.mates);
    expect(own.relations).toBe(model.relations);

    const candidate = model.input({ mates: [], relations: [], extraBodies: [preview] });
    expect(candidate.mates).toEqual([]);
    expect(candidate.relations).toEqual([]);
    expect(candidate.bodies.map(b => b.instanceId)).toEqual(["inst-0", "inst-1", "inst-2", "preview"]);
  });

  it("an empty model solves to nothing", () => {
    const input = AssemblySolverModel.empty().input();
    expect(input.bodies).toEqual([]);
    expect(new Solver().solve(input).result).toBe("okay");
  });
});
