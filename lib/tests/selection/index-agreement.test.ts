// One index space end to end: the face or edge index the renderer stamps on
// a mesh, the index the hit test returns for a ray, and the index the
// selection resolver reads a pick by all name the same entity — on a solid,
// on a surface and on a curve. Each count is explorer order, hidden edges
// keeping their slot (`Shape.getIndexedShapes`).

import { afterEach, describe, expect, it } from "vitest";
import { setupOC } from "../setup.js";
import { TestSheets } from "../helpers/sheets.js";
import { TestCurves } from "../helpers/curves.js";
import { getOC } from "../../oc/init.js";
import { DEFAULT_MESH_CONFIG } from "../../oc/mesh.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { OccHitTest } from "../../oc/hit-test.js";
import { MeshBuilder } from "../../rendering/mesh-builder.js";
import type { SceneObjectMesh } from "../../rendering/scene.js";
import { SelectionResolver } from "../../selection/resolve-selection.js";
import { Point } from "../../math/point.js";
import type { Shape } from "../../common/shape.js";
import { Face } from "../../common/face.js";
import { Edge } from "../../common/edge.js";
import { Solid } from "../../common/solid.js";
import { ShapeFactory } from "../../common/shape-factory.js";

type V3 = [number, number, number];

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
/** Close enough to name an edge, far below any distance between two of them. */
const EDGE_THRESHOLD = 0.01;

const toV3 = (p: Point): V3 => [p.x, p.y, p.z];
const unit = (v: V3): V3 => {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
};

/** A ray from 100 out along `outward` back through `target`. */
function rayTo(target: V3, outward: V3): { origin: V3; dir: V3 } {
  const d = unit(outward);
  return { origin: [target[0] + d[0] * 100, target[1] + d[1] * 100, target[2] + d[2] * 100], dir: [-d[0], -d[1], -d[2]] };
}

function boxSolid(x: number, y: number, z: number): Solid {
  const maker = new (getOC().BRepPrimAPI_MakeBox)(x, y, z);
  try {
    return ShapeFactory.adopt(maker.Shape()) as Solid;
  } finally {
    maker.delete();
  }
}

/** The triangle centres of `meshes`' face groups, by the face index each triangle maps to. */
function triangleCentres(meshes: SceneObjectMesh[]): Map<number, Point[]> {
  const byFace = new Map<number, Point[]>();
  for (const mesh of meshes.filter(m => m.label === "solid-faces")) {
    const v = mesh.vertices;
    mesh.faceMapping!.forEach((face, t) => {
      const [a, b, c] = [mesh.indices[t * 3] * 3, mesh.indices[t * 3 + 1] * 3, mesh.indices[t * 3 + 2] * 3];
      const centre = new Point((v[a] + v[b] + v[c]) / 3, (v[a + 1] + v[b + 1] + v[c + 1]) / 3, (v[a + 2] + v[b + 2] + v[c + 2]) / 3);
      byFace.set(face, [...(byFace.get(face) ?? []), centre]);
    });
  }
  return byFace;
}

function pointsOf(mesh: SceneObjectMesh): Point[] {
  const points: Point[] = [];
  for (let i = 0; i + 2 < mesh.vertices.length; i += 3) {
    points.push(new Point(mesh.vertices[i], mesh.vertices[i + 1], mesh.vertices[i + 2]));
  }
  return points;
}

/**
 * For a box-shaped body centred on `centre`: every face the resolver lists
 * at `i` is the face a ray through its centre hits as `i`, and the face its
 * rendered triangles mapped to `i` lie on; every edge at `j` is the edge a
 * ray through its midpoint hits as `j`, and the one its mesh with
 * `edgeIndex` `j` lies on.
 */
function expectBodyIndicesAgree(body: Shape, centre: V3, faceCount: number, edgeCount: number) {
  const meshes = builder.build(body)!;

  const faces = SelectionResolver.indexedShapes(body, "face");
  expect(faces).toHaveLength(faceCount);
  const centres = triangleCentres(meshes);
  faces.forEach((face, i) => {
    expect(face).toBeInstanceOf(Face);
    const mid = toV3((face as Face).center());
    const { origin, dir } = rayTo(mid, [mid[0] - centre[0], mid[1] - centre[1], mid[2] - centre[2]]);
    expect(OccHitTest.hitTest(body.getShape(), origin, dir, EDGE_THRESHOLD)).toEqual({ type: "face", index: i });

    const drawn = centres.get(i) ?? [];
    expect(drawn.length).toBeGreaterThan(0);
    for (const point of drawn) {
      expect(EdgeOps.distancePointToEdge(point, face)).toBeLessThan(1e-6);
    }
  });

  const edges = SelectionResolver.indexedShapes(body, "edge");
  expect(edges).toHaveLength(edgeCount);
  const edgeMeshes = meshes.filter(m => m.label === "solid-edges");
  expect(edgeMeshes).toHaveLength(edgeCount);
  edges.forEach((edge, j) => {
    expect(edge).toBeInstanceOf(Edge);
    const mid = toV3(EdgeOps.getEdgeMidPoint(edge as Edge));
    const { origin, dir } = rayTo(mid, [mid[0] - centre[0], mid[1] - centre[1], mid[2] - centre[2]]);
    expect(OccHitTest.hitTest(body.getShape(), origin, dir, EDGE_THRESHOLD)).toEqual({ type: "edge", index: j });

    const mesh = edgeMeshes.find(m => m.edgeIndex === j)!;
    expect(mesh).toBeDefined();
    for (const point of pointsOf(mesh)) {
      expect(EdgeOps.distancePointToEdge(point, edge)).toBeLessThan(1e-6);
    }
  });
}

describe("index agreement — renderer, hit test, resolver", () => {
  setupOC();

  it("agrees on every face and edge of a sheet", () => {
    expectBodyIndicesAgree(keep(TestSheets.openBox(10, 20, 30)), [5, 10, 15], 5, 12);
  });

  it("agrees on every face and edge of a solid", () => {
    expectBodyIndicesAgree(keep(boxSolid(10, 20, 30)), [5, 10, 15], 6, 12);
  });

  it("agrees on every edge of a three-edge wire", () => {
    const wire = keep(TestCurves.threeEdges());
    const meshes = builder.build(wire)!;
    const edges = SelectionResolver.indexedShapes(wire, "edge");
    expect(edges).toHaveLength(3);
    expect(meshes).toHaveLength(3);

    edges.forEach((edge, j) => {
      const mid = toV3(EdgeOps.getEdgeMidPoint(edge as Edge));
      const { origin, dir } = rayTo(mid, [0, 0, 1]);
      expect(OccHitTest.hitTest(wire.getShape(), origin, dir, EDGE_THRESHOLD)).toEqual({ type: "edge", index: j });

      const mesh = meshes.find(m => m.edgeIndex === j)!;
      expect(mesh).toBeDefined();
      for (const point of pointsOf(mesh)) {
        expect(EdgeOps.distancePointToEdge(point, edge)).toBeLessThan(1e-6);
      }
    });
  });
});
