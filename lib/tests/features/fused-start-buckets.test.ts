import { describe, it, expect } from "vitest";
import { setupOC, render, addToScene } from "../setup.js";
import { sketch, line, circle, ellipse, extrude, loft, sweep, fillet, plane } from "../../core/index.js";
import { Extrude } from "../../features/extrude.js";
import { Loft } from "../../features/loft.js";
import { Sweep } from "../../features/sweep.js";
import { Fillet } from "../../features/fillet.js";
import { Edge } from "../../common/edge.js";
import { Face } from "../../common/face.js";
import { SceneObject } from "../../common/scene-object.js";
import { SelectionResolver } from "../../selection/resolve-selection.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { testRect } from "../helpers/profiles.js";

/**
 * A feature fused onto an existing face loses its start face to the fusion
 * (a boss's start disc merges into the plate). Its start edges live on as
 * the junction with the plate, so `startEdges()` must name those junction
 * edges in the final solid — a fillet on them builds, and the MCP resolver
 * finds them — and `startFaces()` re-homes onto the plate face it grew from.
 */
describe("start buckets of a feature fused onto an existing face", () => {
  setupOC();

  const plateT = 10;

  function plate() {
    sketch("xy", () => {
      testRect(100, 60);
    });
    return extrude(plateT) as Extrude;
  }

  function bossOnDatumPlane() {
    plate();
    sketch(plane("xy", plateT), () => {
      circle([50, 30], 20);
    });
    return extrude(15) as Extrude;
  }

  function bossOnPlateFace() {
    const base = plate();
    sketch(base.endFaces(), () => {
      circle([50, 30], 20);
    });
    return extrude(15) as Extrude;
  }

  function footOnPlate() {
    plate();
    const foot = sketch(plane("xy", plateT), () => {
      const b = line([40, 22], [60, 22]);
      const r = line([60, 22], [60, 38]);
      const t = line([60, 38], [40, 38]);
      const l = line([40, 38], [40, 22]);
      fillet(4, b, r, t, l);
    });
    const top = sketch(plane("xy", plateT + 12), () => {
      ellipse([50, 30], 5, 7);
    });
    return loft(foot, top).startCondition("normal") as Loft;
  }

  function stemOnPlate() {
    plate();
    const path = sketch("xz", () => {
      line([50, plateT], [50, 40]);
    }).reusable();
    sketch(plane("xy", plateT), () => {
      circle([50, 30], 12);
    });
    return sweep(path) as Sweep;
  }

  type Feature = Extrude | Loft | Sweep;
  const cases: [string, () => Feature, number][] = [
    ["extrude boss on a datum plane", bossOnDatumPlane, 1],
    ["extrude boss sketched on the plate's top face", bossOnPlateFace, 1],
    ["constrained loft foot on the plate", footOnPlate, 8],
    ["swept stem starting on the plate", stemOnPlate, 1],
  ];

  function resolvedCount(scene: any, object: SceneObject, accessor: string): number {
    const result = SelectionResolver.resolve(scene, { expression: `$obj["${object.id}"].${accessor}()` });
    expect(result.ok).toBe(true);
    return result.ok ? result.count : -1;
  }

  function expectJunctionEdges(edges: Edge[], count: number) {
    expect(edges).toHaveLength(count);
    for (const e of edges) {
      expect(EdgeOps.getEdgeMidPoint(e).z).toBeCloseTo(plateT, 6);
    }
  }

  describe("startEdges() names the junction edges of the final solid", () => {
    for (const [label, build, junctionCount] of cases) {
      it(label, () => {
        const feature = build();
        const startEdges = feature.startEdges();
        const startFaces = feature.startFaces();
        addToScene(startEdges);
        addToScene(startFaces);

        const scene = render();

        expectJunctionEdges(startEdges.getShapes() as Edge[], junctionCount);
        expect(resolvedCount(scene, feature as unknown as SceneObject, "startEdges")).toBe(junctionCount);

        // The start face merged into the plate: the bucket re-homes onto the
        // plate's top face, which the final solid carries.
        const homes = startFaces.getShapes() as Face[];
        expect(homes).toHaveLength(1);
        expect(homes[0].center().z).toBeCloseTo(plateT, 6);
        expect(resolvedCount(scene, feature as unknown as SceneObject, "startFaces")).toBe(1);
      });
    }
  });

  describe("a fillet on startEdges() builds", () => {
    for (const [label, build] of cases) {
      it(label, () => {
        const feature = build();
        const rounded = fillet(1.5, feature.startEdges()) as Fillet;

        render();

        expect(rounded.getError()).toBeNull();
        expect(rounded.getShapes()).toHaveLength(1);
      });
    }
  });

  it("a standalone extrude keeps its own start face and edges", () => {
    sketch("xy", () => {
      circle([0, 0], 20);
    });
    const e = extrude(15) as Extrude;
    const startFaces = e.startFaces();
    const startEdges = e.startEdges();
    addToScene(startFaces);
    addToScene(startEdges);

    const scene = render();

    expect(startFaces.getShapes()).toHaveLength(1);
    expect(startEdges.getShapes()).toHaveLength(1);
    expect(resolvedCount(scene, e, "startFaces")).toBe(1);
    expect(resolvedCount(scene, e, "startEdges")).toBe(1);
  });

  it("a boss overhanging the plate edge keeps the overhanging part of its start face", () => {
    plate();
    sketch(plane("xy", plateT), () => {
      circle([100, 30], 20);
    });
    const boss = extrude(15) as Extrude;
    const startFaces = boss.startFaces();
    const startEdges = boss.startEdges();
    addToScene(startFaces);
    addToScene(startEdges);

    const scene = render();

    // The half outside the plate is a real face of the boss; the half on the
    // plate merged into it. Every start edge is a rim or junction edge at z = plateT.
    const faces = startFaces.getShapes() as Face[];
    expect(faces.length).toBeGreaterThanOrEqual(1);
    const edges = startEdges.getShapes() as Edge[];
    expect(edges.length).toBeGreaterThanOrEqual(2);
    for (const e of edges) {
      expect(EdgeOps.getEdgeMidPoint(e).z).toBeCloseTo(plateT, 6);
    }
    expect(resolvedCount(scene, boss, "startEdges")).toBe(edges.length);
    expect(resolvedCount(scene, boss, "startFaces")).toBe(faces.length);
  });

  it("the resolver says when a selection's members are gone from the final model", () => {
    const boss = bossOnDatumPlane();
    fillet(1.5, boss.startEdges());

    const scene = render();

    // The fillet consumed the junction edges; the accessor still names them.
    const result = SelectionResolver.resolve(scene, { expression: `$obj["${boss.id}"].startEdges()` });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.count).toBe(0);
      expect(result.warning).toMatch(/1 of 1 selected shape\(s\) belong to no solid/);
    }
  });
});
