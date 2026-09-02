// Mesh density is a quality (relative + mm floor/ceiling + angle), resolved
// per shape from its size and unit — not one absolute deflection for every
// shape in every document.

import { describe, it, expect } from "vitest";
import { setupOC } from "../setup.js";
import { getOC } from "../../oc/init.js";
import { Explorer } from "../../oc/explorer.js";
import {
  Mesh, MESH_PRESETS, DEFAULT_MESH_CONFIG, resolveLinearDeflection, resolveMeshConfigFor,
  resolveRenderMeshConfig, meshSizeBucket, bucketDiagonal, bboxDiagonal, meshQualityFromConfig, toMeshQuality,
} from "../../oc/mesh.js";
import { MM_PER_UNIT } from "../../units/units.js";
import { withUnit } from "../../units/registry.js";
import { SceneRenderer } from "../../rendering/render.js";
import { getCurrentScene, getSceneManager } from "../../scene-manager.js";
import type { SceneObject } from "../../common/scene-object.js";
import sphere from "../../core/sphere.js";
import extrude from "../../core/extrude.js";
import sketch from "../../core/sketch.js";
import { testRect } from "../helpers/profiles.js";
import type { TopoDS_Shape } from "ocjs-fluidcad";

function triangleCount(shape: TopoDS_Shape): number {
  const oc = getOC();
  let count = 0;
  for (const face of Explorer.findShapes(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE)) {
    const data = Mesh.extractFaceTriangulationRaw(oc.TopoDS.Face(face), 0);
    count += data ? data.indices.length / 3 : 0;
  }
  return count;
}

function sphereShape(radius: number): TopoDS_Shape {
  const oc = getOC();
  return new oc.BRepPrimAPI_MakeSphere(radius).Shape();
}

describe("mesh quality presets", () => {
  setupOC();

  it("clamp the relative deflection between the mm floor and ceiling", () => {
    const standard = MESH_PRESETS.standard;
    expect(resolveLinearDeflection(2, standard, "mm")).toBe(0.005);
    expect(resolveLinearDeflection(150, standard, "mm")).toBeCloseTo(0.075, 12);
    expect(resolveLinearDeflection(5000, standard, "mm")).toBe(0.5);
    expect(resolveLinearDeflection(0, standard, "mm")).toBe(0.005);
    expect(resolveLinearDeflection(NaN, standard, "mm")).toBe(0.005);

    expect(resolveLinearDeflection(150, MESH_PRESETS.draft, "mm")).toBeCloseTo(0.3, 12);
    expect(resolveLinearDeflection(150, MESH_PRESETS.fine, "mm")).toBeCloseTo(0.015, 12);
    for (const preset of Object.values(MESH_PRESETS)) {
      expect(preset.minMm).toBeLessThan(preset.maxMm);
      expect(preset.angularRad).toBeGreaterThan(0);
    }
  });

  it("resolve to the same physical deflection in every unit", () => {
    const standard = MESH_PRESETS.standard;
    const mm = resolveLinearDeflection(150, standard, "mm");
    expect(resolveLinearDeflection(150 / 25.4, standard, "in") * 25.4).toBeCloseTo(mm, 12);
    expect(resolveLinearDeflection(0.15, standard, "m") * 1000).toBeCloseTo(mm, 12);
    // The floor is a millimetre floor: a 2 mm part in inches still gets 0.005 mm.
    expect(resolveLinearDeflection(2 / 25.4, standard, "in") * 25.4).toBeCloseTo(0.005, 12);
  });

  it("keep the legacy default config in the standard preset's family", () => {
    expect(DEFAULT_MESH_CONFIG.linDefl).toBeCloseTo(resolveLinearDeflection(150, MESH_PRESETS.standard, "mm"), 12);
    expect(DEFAULT_MESH_CONFIG.angDefl).toBe(MESH_PRESETS.standard.angularRad);
  });

  it("pin a bare MeshConfig as a custom quality with the same physical density everywhere", () => {
    const pinned = meshQualityFromConfig({ linDefl: 0.02, angDefl: 0.4 }, "in");
    expect(pinned.preset).toBe("custom");
    expect(pinned.relative).toBe(0);
    expect(pinned.minMm).toBeCloseTo(0.508, 12);
    expect(pinned.maxMm).toBeCloseTo(0.508, 12);
    expect(resolveLinearDeflection(1e6, pinned, "in")).toBeCloseTo(0.02, 12);
    expect(resolveLinearDeflection(1e-6, pinned, "mm")).toBeCloseTo(0.508, 12);
    expect(toMeshQuality(MESH_PRESETS.fine)).toBe(MESH_PRESETS.fine);
    expect(withUnit("in", () => toMeshQuality({ linDefl: 1, angDefl: 0.5 })).minMm).toBeCloseTo(25.4, 12);
  });
});

describe("size-aware deflection", () => {
  setupOC();

  it("meshes a 2 mm sphere with more triangles under standard than today's 0.1 mm absolute", () => {
    const small = sphereShape(1);
    const config = resolveMeshConfigFor(small, MESH_PRESETS.standard, "mm");
    expect(config.linDefl).toBe(0.005);
    Mesh.ensureTriangulated(small, config);
    const standardTriangles = triangleCount(small);

    const legacy = sphereShape(1);
    Mesh.ensureTriangulated(legacy, { linDefl: 0.1, angDefl: 0.5 });
    const legacyTriangles = triangleCount(legacy);

    expect(standardTriangles).toBeGreaterThan(legacyTriangles);
  });

  it("scales the deflection with the shape's size", () => {
    const small = resolveMeshConfigFor(sphereShape(1), MESH_PRESETS.standard, "mm");
    const large = resolveMeshConfigFor(sphereShape(100), MESH_PRESETS.standard, "mm");
    expect(large.linDefl).toBeGreaterThan(small.linDefl);
    expect(large.linDefl).toBeCloseTo(resolveLinearDeflection(bboxDiagonal(sphereShape(100)), MESH_PRESETS.standard, "mm"), 12);
    expect(bboxDiagonal(sphereShape(100))).toBeCloseTo(Math.hypot(200, 200, 200), 6);
  });

  it("reports a void box as a zero diagonal", () => {
    const oc = getOC();
    const builder = new oc.BRep_Builder();
    const empty = new oc.TopoDS_Compound();
    builder.MakeCompound(empty);
    expect(bboxDiagonal(empty)).toBe(0);
    expect(meshSizeBucket(0)).toBe(0);
  });
});

describe("size buckets", () => {
  setupOC();

  it("group diagonals by rounded log10", () => {
    expect(meshSizeBucket(2)).toBe(0);
    expect(meshSizeBucket(0.05)).toBe(-1);
    expect(meshSizeBucket(150)).toBe(2);
    expect(meshSizeBucket(250)).toBe(2);
    expect(meshSizeBucket(1500)).toBe(3);
    expect(bucketDiagonal(2)).toBe(100);
    expect(bucketDiagonal(-1)).toBeCloseTo(0.1, 12);
  });

  it("resolve a shape's render config from its bucket, not its exact diagonal", () => {
    const shape = sphereShape(100);
    const bucket = meshSizeBucket(bboxDiagonal(shape));
    expect(bucket).toBe(3);
    const render = resolveRenderMeshConfig(shape, MESH_PRESETS.standard, "mm");
    expect(render.linDefl).toBeCloseTo(resolveLinearDeflection(bucketDiagonal(bucket), MESH_PRESETS.standard, "mm"), 12);
    expect(render.linDefl).not.toBeCloseTo(resolveMeshConfigFor(shape, MESH_PRESETS.standard, "mm").linDefl, 12);
  });

  it("keep a small shape's own density when it is meshed alongside a big one", () => {
    const renderer = new SceneRenderer(MESH_PRESETS.standard);

    const smallAlone = sphere(1) as unknown as SceneObject;
    let scene = getCurrentScene();
    scene.materializeLeftoverDefinitions();
    renderer.render(scene);
    const aloneTriangles = triangleCount(smallAlone.getShapes()[0].getShape());

    // A fresh scene with a 400 mm plate and the same 2 mm sphere.
    getSceneManager().startScene();
    sketch("xy", () => {
      testRect(400, 300);
    });
    extrude(20);
    const smallWithPlate = sphere(1) as unknown as SceneObject;
    scene = getCurrentScene();
    scene.materializeLeftoverDefinitions();
    renderer.render(scene);
    const withPlateTriangles = triangleCount(smallWithPlate.getShapes()[0].getShape());

    expect(withPlateTriangles).toBe(aloneTriangles);

    // Meshed at the plate's deflection instead, the sphere would be far coarser.
    const plateBucketConfig = { linDefl: resolveLinearDeflection(bucketDiagonal(2), MESH_PRESETS.standard, "mm"), angDefl: MESH_PRESETS.standard.angularRad };
    const coarse = sphereShape(1);
    Mesh.ensureTriangulated(coarse, plateBucketConfig);
    expect(triangleCount(coarse)).toBeLessThan(aloneTriangles);
  });
});
