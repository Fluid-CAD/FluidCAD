import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import select from "../../core/select.js";
import { circle } from "../../core/2d/index.js";
import { Edge } from "../../common/edge.js";
import { Face } from "../../common/face.js";
import { edge, face } from "../../filters/index.js";
import { Extrude } from "../../features/extrude.js";
import { SelectSceneObject } from "../../features/select.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { testRect } from "../helpers/profiles.js";

/** A 100 × 50 × 10 plate with a Ø20 boss fused on top, reaching z = 30. */
function plateWithBoss() {
  sketch("xy", () => {
      testRect(100, 50);
    });
  const plate = extrude(10) as Extrude;
  sketch("xy", () => {
      circle([50, 25], 20);
    });
  extrude(30);
  return plate;
}

describe("feature-group references in filters", () => {
  setupOC();

  it("above()/below() take a face group as the reference plane", () => {
    const plate = plateWithBoss();
    const aboveTop = select(edge().above(plate.endFaces())) as SelectSceneObject;
    const belowTop = select(face().below(plate.endFaces(), { partial: true })) as SelectSceneObject;
    const offsetAbove = select(edge().above(plate.endFaces(), 15)) as SelectSceneObject;
    render();

    // Strictly above the plate's top: the boss rim (z=30) only — the seam
    // starts on the plane and the plate's own edges lie on or below it.
    const rim = aboveTop.getShapes() as Edge[];
    expect(rim).toHaveLength(1);
    expect(EdgeOps.getEdgeMidPoint(rim[0]).z).toBeCloseTo(30, 6);

    // Partially below: every plate face (all touch z ≤ 10) but not the boss's.
    const lower = belowTop.getShapes() as Face[];
    expect(lower.length).toBeGreaterThanOrEqual(5);
    expect(lower.every(f => f.center().z <= 10 + 1e-6)).toBe(true);

    // The offset rides the reference: z > 25 keeps only the rim.
    expect(offsetAbove.getShapes()).toHaveLength(1);
  });

  it("belongsToFace() resolves a bare accessor lazily", () => {
    const plate = plateWithBoss();
    const onTop = select(edge().belongsToFace(plate.endFaces())) as SelectSceneObject;
    const junction = select(edge().belongsToFace(plate.endFaces()).circle()) as SelectSceneObject;
    render();

    // The group is the plate's top face as built — its four rect edges,
    // which the fusion kept. The boss junction rim was born in the fusion,
    // so the as-built face does not bound it.
    const top = onTop.getShapes() as Edge[];
    expect(top).toHaveLength(4);
    expect(top.every(e => Math.abs(EdgeOps.getEdgeMidPoint(e).z - 10) < 1e-6)).toBe(true);
    expect(junction.getShapes()).toHaveLength(0);
  });
});
