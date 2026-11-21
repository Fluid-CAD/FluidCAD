import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import { getSceneManager, getCurrentScene } from "../scene-manager.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import select from "../core/select.js";
import part from "../core/part.js";
import connector from "../core/connector.js";
import insert from "../core/insert.js";
import mate from "../core/mate.js";
import relation from "../core/relation.js";
import { face } from "../filters/index.js";
import { testRect } from "./helpers/profiles.js";
import { Explorer } from "../oc/explorer.js";
import { classifyFace } from "../oc/measure/classify.js";
import { AssemblyScene } from "../rendering/assembly-scene.js";
import { Quaternion } from "../math/quaternion.js";
import { Vector3d } from "../math/vector3d.js";
import type { Part } from "../features/part.js";
import type { Pose } from "../math/pose.js";
import type { MeasureEntityRef } from "../oc/measure/measure-types.js";
import type { SceneInterferenceOutcome } from "../validation/scene-interference.js";

// The engine solves an assembly's mates itself — the same solver, fed the
// same records, as the viewer — so every server-side reader places the
// parts where the mates put them rather than where the insert() statements
// left them.

/** A 20×20×10 block with a connector on its top face (z = 10) and one on its bottom face (z = 0). */
function blockDefinition(name = "block"): Part {
  return part(name, () => {
    sketch("xy", () => { testRect(20, 20); });
    extrude(10);
    connector("top", select(face().planar().onPlane("xy", 10)));
    connector("bottom", select(face().planar().onPlane("xy", 0)));
  }) as unknown as Part;
}

function startAssembly(): AssemblyScene {
  getSceneManager().startScene();
  return getSceneManager().startAssemblyScene();
}

/** `local` (a point in the instance's part frame) in world coordinates at `pose`. */
function toWorld(pose: Pose, local: [number, number, number]): [number, number, number] {
  const q = new Quaternion(pose.quaternion.x, pose.quaternion.y, pose.quaternion.z, pose.quaternion.w);
  const rotated = q.rotateVector(new Vector3d(local[0], local[1], local[2]));
  return [rotated.x + pose.position.x, rotated.y + pose.position.y, rotated.z + pose.position.z];
}

function expectPoint(actual: [number, number, number], expected: [number, number, number]): void {
  for (let i = 0; i < 3; i++) {
    expect(actual[i]).toBeCloseTo(expected[i], 6);
  }
}

/** The block's planar face whose outward normal runs along ±Z at the given height, as a measure ref. */
function blockFace(z: number): { shapeId: string; index: number } {
  for (const obj of getCurrentScene().getAllSceneObjects()) {
    for (const shape of obj.getAddedShapes()) {
      if (shape.isMetaShapeFlag || shape.isGuideFlag || shape.getType() !== 'solid') {
        continue;
      }
      const faces = Explorer.findFacesWrapped(shape);
      for (let index = 0; index < faces.length; index++) {
        const info = classifyFace(faces[index].getShape());
        if (info.form === 'plane' && info.dir && Math.abs(info.dir.z) > 0.9999 && Math.abs(info.point!.z - z) < 1e-6) {
          return { shapeId: shape.id, index };
        }
      }
    }
  }
  throw new Error(`no planar face at z = ${z}`);
}

function instanceFace(faceAt: { shapeId: string; index: number }, instanceId: string, pose?: Pose): MeasureEntityRef {
  return { shapeId: faceAt.shapeId, kind: 'face', index: faceAt.index, instanceId, ...(pose ? { pose } : {}) };
}

function interferenceReport(outcome: SceneInterferenceOutcome) {
  expect(outcome.kind, outcome.kind === 'refused' ? outcome.reason : '').toBe('report');
  return (outcome as Extract<SceneInterferenceOutcome, { kind: 'report' }>).report;
}

/** A grounded base with a lid inserted far away and fastened onto its top. */
function fastenedStack(): { scene: AssemblyScene; baseId: string; lidId: string } {
  const scene = startAssembly();
  const block = blockDefinition();
  const base = insert(block).grounded();
  const lid = insert(block).translate(100, 50, 30);
  mate("fastened", base.connectors.top, lid.connectors.bottom);
  render();
  return { scene, baseId: base.record.instanceId, lidId: lid.record.instanceId };
}

describe("assembly solution", () => {
  setupOC();

  it("puts a fastened part on its mate, not where its insert() left it", () => {
    const { scene, baseId, lidId } = fastenedStack();

    const solution = scene.getSolution();

    expect(solution.status).toBe("okay");
    expect(solution.posesSource).toBe("solved");
    expect(solution.dof).toBe(0);
    expect(solution.poses.map(p => p.instanceId)).toEqual([baseId, lidId]);
    expect(solution.mates).toEqual([{ mateId: "mate-0", status: "satisfied" }]);
    expect(solution.relations).toEqual([]);

    const poses = scene.getPlacedPoses();
    // The grounded base does not move.
    expectPoint(toWorld(poses.get(baseId), [10, 10, 10]), [10, 10, 10]);
    // The lid's bottom-face centre sits on the base's top-face centre.
    expectPoint(toWorld(poses.get(lidId), [10, 10, 0]), [10, 10, 10]);
    // The statement pose is still what the scene serializes.
    expect(scene.getSerializedInstances()[1].position).toEqual({ x: 100, y: 50, z: 30 });
  });

  it("is solved once per render and again for the next one", () => {
    const { scene } = fastenedStack();
    expect(scene.getSolution()).toBe(scene.getSolution());

    const next = fastenedStack().scene;
    expect(next.getSolution()).not.toBe(scene.getSolution());
  });

  it("leaves an assembly without mates at its statement poses", () => {
    const scene = startAssembly();
    const block = blockDefinition();
    insert(block);
    insert(block).translate(40, 0, 0).rotate("z", 30);
    render();

    const solution = scene.getSolution();

    expect(solution.status).toBe("okay");
    expect(solution.mates).toEqual([]);
    expect(solution.dof).toBe(12);
    expect(solution.poses).toEqual(scene.getSerializedInstances().map(i => ({
      instanceId: i.instanceId, position: i.position, quaternion: i.quaternion,
    })));
  });

  it("reports the free motion a revolute leaves and where the joint sits, inside its limits", () => {
    const scene = startAssembly();
    const block = blockDefinition();
    const base = insert(block).grounded();
    const lid = insert(block).translate(100, 50, 30);
    mate("revolute", base.connectors.top, lid.connectors.bottom).limits(25, 60);
    render();

    const solution = scene.getSolution();

    expect(solution.status).toBe("okay");
    expect(solution.dof).toBe(1);
    expect(solution.mates).toHaveLength(1);
    expect(solution.mates[0].status).toBe("satisfied");
    expect(solution.mates[0].value).toBeGreaterThanOrEqual(25 - 1e-6);
    expect(solution.mates[0].value).toBeLessThanOrEqual(60 + 1e-6);
    // The hinge axis runs through both connector origins.
    expectPoint(toWorld(scene.getPlacedPoses().get(lid.record.instanceId), [10, 10, 0]), [10, 10, 10]);
  });

  it("reports a limited angle on the turn its limits are on", () => {
    const scene = startAssembly();
    const block = blockDefinition();
    const base = insert(block).grounded();
    const lid = insert(block).translate(100, 50, 30);
    mate("revolute", base.connectors.top, lid.connectors.bottom).limits(190, 300);
    render();

    const [hinge] = scene.getSolution().mates;

    // Read straight off the poses the angle would wrap to -170…-60.
    expect(hinge.status).toBe("satisfied");
    expect(hinge.value).toBeGreaterThanOrEqual(190 - 1e-6);
    expect(hinge.value).toBeLessThanOrEqual(300 + 1e-6);
    expect("outsideLimits" in hinge).toBe(false);
  });

  it("flags a joint the solve has to leave outside its limits", () => {
    const scene = startAssembly();
    const block = blockDefinition();
    const base = insert(block).grounded();
    // On the hinge axis and grounded there: the mate's geometry holds, and
    // nothing is free to turn the lid into the range.
    const lid = insert(block).translate(0, 0, 10).grounded();
    mate("revolute", base.connectors.top, lid.connectors.bottom).limits(25, 60);
    render();

    const solution = scene.getSolution();
    const [hinge] = solution.mates;

    expect(solution.status).toBe("okay");
    expect(hinge.status).toBe("satisfied");
    expect(hinge.value < 25 || hinge.value > 60).toBe(true);
    expect(hinge.outsideLimits).toBe(true);
  });

  it("reports a mate the assembly cannot close, with its misclosure", () => {
    const scene = startAssembly();
    const block = blockDefinition();
    const base = insert(block).grounded();
    // Grounded too: nothing can move to bring the connectors together.
    const lid = insert(block).translate(0, 0, 40).grounded();
    mate("fastened", base.connectors.top, lid.connectors.bottom);
    render();

    const solution = scene.getSolution();

    expect(solution.status).toBe("inconsistent");
    expect(solution.posesSource).toBe("solved");
    expect(solution.mates).toHaveLength(1);
    const [state] = solution.mates;
    expect(state.status).toBe("failed");
    // Top face at z = 10, the lid's bottom at z = 40.
    expect(state.gap).toBeCloseTo(30, 6);
    expect(state.gapAxis).toBe("z");
    expect(Number.isFinite(state.tiltDeg)).toBe(true);
    // Both parts stay where they are grounded.
    expect(scene.getPlacedPoses().get(lid.record.instanceId).position.z).toBeCloseTo(40, 9);
  });

  it("reports each relation's outcome", () => {
    const scene = startAssembly();
    const block = blockDefinition();
    const base = insert(block).grounded();
    const upper = insert(block).translate(0, 0, 30);
    const lower = insert(block).translate(0, 0, -30);
    const hingeA = mate("revolute", base.connectors.top, upper.connectors.bottom);
    const hingeB = mate("revolute", base.connectors.bottom, lower.connectors.top);
    relation("gear", hingeA, hingeB, 2);
    render();

    const solution = scene.getSolution();

    expect(solution.status).toBe("okay");
    expect(solution.relations).toEqual([{ relationId: "rel-0", status: "satisfied" }]);
    // The gear ties the two hinges into one motion.
    expect(solution.dof).toBe(1);
  });

  it("the scene manager answers it for an assembly and not for a part", () => {
    const { scene } = fastenedStack();
    expect(getSceneManager().getAssemblySolution(scene)).toBe(scene.getSolution());

    getSceneManager().startScene();
    sketch("xy", () => { testRect(10, 10); });
    extrude(5);
    expect(getSceneManager().getAssemblySolution(render())).toBeNull();
  });
});

describe("assembly solution — what reads it", () => {
  setupOC();

  it("measure places an instance where the mates put it unless the entity brings a pose", () => {
    const { scene, baseId, lidId } = fastenedStack();
    const top = blockFace(10);
    const bottom = blockFace(0);

    // Base top face to lid bottom face: in contact once the lid is fastened on.
    const solved = getSceneManager().measure(scene, [instanceFace(top, baseId), instanceFace(bottom, lidId)]);
    expect(solved.minDist.value).toBeCloseTo(0, 6);

    // The statement pose, handed in, measures the 20 the insert() left between them.
    const statement = scene.getSerializedInstances().find(i => i.instanceId === lidId);
    const posed = getSceneManager().measure(scene, [
      instanceFace(top, baseId),
      instanceFace(bottom, lidId, { position: statement.position, quaternion: statement.quaternion }),
    ]);
    expect(posed.parallelDist.value).toBeCloseTo(20, 6);
  });

  it("interference checks the solved configuration unless poses are handed in", () => {
    const scene = startAssembly();
    const block = blockDefinition();
    const base = insert(block).grounded();
    // Inserted on top of the base: the two blocks coincide until the mate stacks them.
    const lid = insert(block);
    mate("fastened", base.connectors.top, lid.connectors.bottom);
    render();

    const solved = interferenceReport(getSceneManager().interfere(scene));
    expect(solved.clashes).toEqual([]);
    expect(solved.ok).toBe(true);

    const statement = scene.getSerializedInstances().map(i => ({
      instanceId: i.instanceId, position: i.position, quaternion: i.quaternion,
    }));
    const posed = interferenceReport(getSceneManager().interfere(scene, { poses: statement }));
    expect(posed.clashes).toHaveLength(1);
    expect(posed.clashes[0].volume).toBeCloseTo(20 * 20 * 10, 3);
  });

  it("an instance-scoped selection carries the solved pose", () => {
    const { scene, lidId } = fastenedStack();

    const result = getSceneManager().resolveSelection(scene, {
      expression: "face().planar().onPlane('xy', 0)",
      scope: { instanceId: lidId },
    });

    expect(result.ok, result.ok === false ? result.reason : "").toBe(true);
    if (result.ok === false) {
      return;
    }
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].instanceId).toBe(lidId);
    expect(result.matches[0].pose).toEqual(scene.getPlacedPoses().get(lidId));
  });
});
