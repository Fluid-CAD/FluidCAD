// A curve draws one line mesh per edge, each carrying the edge's explorer
// index, so the viewport can pick, hover and highlight every edge of a
// multi-edge curve on its own. A lone edge draws as it always has: one
// unindexed line (the UI gives a bare edge its index itself).

import { afterEach, describe, expect, it } from "vitest";
import { setupOC } from "../setup.js";
import { TestCurves } from "../helpers/curves.js";
import { DEFAULT_MESH_CONFIG } from "../../oc/mesh.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { MeshBuilder } from "../../rendering/mesh-builder.js";
import type { SceneObjectMesh } from "../../rendering/scene.js";
import { Point } from "../../math/point.js";
import type { Shape } from "../../common/shape.js";

const owned: Shape[] = [];
function keep<T extends Shape>(shape: T): T {
  owned.push(shape);
  return shape;
}
afterEach(() => {
  for (const shape of owned.reverse()) shape.dispose();
  owned.length = 0;
});

const builder = new MeshBuilder(DEFAULT_MESH_CONFIG);

function pointsOf(mesh: SceneObjectMesh): Point[] {
  const points: Point[] = [];
  for (let i = 0; i + 2 < mesh.vertices.length; i += 3) {
    points.push(new Point(mesh.vertices[i], mesh.vertices[i + 1], mesh.vertices[i + 2]));
  }
  return points;
}

describe("wire rendering", () => {
  setupOC();

  it("draws a three-edge wire as three meshes indexed in getIndexedShapes order", () => {
    const wire = keep(TestCurves.threeEdges());
    const meshes = builder.build(wire)!;

    expect(meshes).toHaveLength(3);
    expect(meshes.map(m => m.edgeIndex)).toEqual([0, 1, 2]);
    expect(meshes.every(m => m.label === undefined)).toBe(true);

    const edges = wire.getIndexedShapes("edge");
    expect(edges).toHaveLength(3);
    for (const mesh of meshes) {
      const points = pointsOf(mesh);
      expect(points.length).toBeGreaterThanOrEqual(2);
      for (const point of points) {
        expect(EdgeOps.distancePointToEdge(point, edges[mesh.edgeIndex!])).toBeLessThan(1e-6);
      }
    }
  });

  it("draws a lone edge as one unindexed line, unchanged", () => {
    const line = keep(EdgeOps.makeLineEdge(new Point(0, 0, 0), new Point(10, 0, 0)));
    expect(builder.build(line)).toEqual([{ vertices: [0, 0, 0, 10, 0, 0], normals: [], indices: [0, 1] }]);
  });
});
