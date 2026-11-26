// A body — a solid or a surface — renders through one path: its faces as
// `solid-faces` meshes with a per-triangle face mapping, its edges as one
// `solid-edges` mesh each with its explorer index. A surface's open rim is
// flagged `boundary` so the UI can mark it; a solid has no rim, and its
// output is exactly what it was before surfaces shared the renderer.

import { afterEach, describe, expect, it } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import select from "../../core/select.js";
import fillet from "../../core/fillet.js";
import { } from "../../core/2d/index.js";
import { edge } from "../../filters/index.js";
import { testRect } from "../helpers/profiles.js";
import { TestSheets, cylinderWall } from "../helpers/sheets.js";
import { getOC } from "../../oc/init.js";
import { DEFAULT_MESH_CONFIG } from "../../oc/mesh.js";
import { MeshBuilder } from "../../rendering/mesh-builder.js";
import { MeshKeys } from "../../rendering/mesh-keys.js";
import { MeshPieces } from "../../rendering/mesh-pieces.js";
import { renderBody } from "../../rendering/render-body.js";
import type { SceneObjectMesh } from "../../rendering/scene.js";
import { FaceColorView } from "../../common/face-color-view.js";
import type { SceneObject } from "../../common/scene-object.js";
import type { Shape } from "../../common/shape.js";
import { Solid } from "../../common/solid.js";
import { ShapeFactory } from "../../common/shape-factory.js";

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

function meshesOf(shape: Shape): SceneObjectMesh[] {
  const meshes = builder.build(shape);
  if (!meshes) {
    throw new Error(`no meshes for a ${shape.getType()}`);
  }
  return meshes;
}

const faceMeshes = (meshes: SceneObjectMesh[]) => meshes.filter(m => m.label === "solid-faces");
const edgeMeshes = (meshes: SceneObjectMesh[]) => meshes.filter(m => m.label === "solid-edges");

function boxSolid(x: number, y: number, z: number): Solid {
  const maker = new (getOC().BRepPrimAPI_MakeBox)(x, y, z);
  try {
    return ShapeFactory.adopt(maker.Shape()) as Solid;
  } finally {
    maker.delete();
  }
}

/** Every vertex of `mesh` as [x, y, z]. */
function pointsOf(mesh: SceneObjectMesh): [number, number, number][] {
  const points: [number, number, number][] = [];
  for (let i = 0; i + 2 < mesh.vertices.length; i += 3) {
    points.push([mesh.vertices[i], mesh.vertices[i + 1], mesh.vertices[i + 2]]);
  }
  return points;
}

describe("body rendering — surfaces", () => {
  setupOC();

  it("renders a sheet as a body: one face group mapping every face, one line per edge", () => {
    const sheet = keep(TestSheets.openBox(10, 20, 30));
    const meshes = meshesOf(sheet);

    const faces = faceMeshes(meshes);
    expect(faces).toHaveLength(1);
    expect([...new Set(faces[0].faceMapping)].sort()).toEqual([0, 1, 2, 3, 4]);
    expect(faces[0].faceMapping).toHaveLength(faces[0].indices.length / 3);

    const edges = edgeMeshes(meshes);
    expect(edges).toHaveLength(12);
    expect(new Set(edges.map(m => m.edgeIndex)).size).toBe(12);
    expect(edges.every(m => m.faceSides && m.faceSides.length > 0)).toBe(true);
  });

  it("flags exactly the open rim as boundary", () => {
    const open = keep(TestSheets.openBox(10, 20, 30));
    const rim = edgeMeshes(meshesOf(open)).filter(m => m.boundary);
    expect(rim).toHaveLength(4);
    // The rim is where the top face was left out.
    expect(rim.every(m => pointsOf(m).every(([, , z]) => Math.abs(z - 30) < 1e-9))).toBe(true);
    // Every rim edge is one the sheet itself calls boundary.
    const indexed = open.getIndexedShapes("edge");
    expect(rim.every(m => open.isBoundaryEdge(indexed[m.edgeIndex!].getShape()))).toBe(true);

    const closed = keep(TestSheets.closedBox(10, 20, 30));
    expect(edgeMeshes(meshesOf(closed)).some(m => m.boundary !== undefined)).toBe(false);

    const solid = keep(boxSolid(10, 20, 30));
    expect(edgeMeshes(meshesOf(solid)).some(m => m.boundary !== undefined)).toBe(false);
  });

  it("marks the tangent junction of a sheet smooth, not boundary", () => {
    const sheet = keep(TestSheets.tangentStrip(5));
    expect(sheet.getFaces()).toHaveLength(2);
    const edges = edgeMeshes(meshesOf(sheet));
    expect(edges).toHaveLength(7);

    const smooth = edges.filter(m => m.smooth);
    expect(smooth).toHaveLength(1);
    expect(smooth[0].boundary).toBeUndefined();
    // The junction runs up from (10, 0).
    expect(pointsOf(smooth[0]).every(([x, y]) => Math.abs(x - 10) < 1e-9 && Math.abs(y) < 1e-9)).toBe(true);
    expect(edges.filter(m => m.boundary)).toHaveLength(6);
  });

  it("draws no seam on a full cylinder wall, and keeps the other edges' explorer indices", () => {
    const wall = keep(cylinderWall(5, 10, 2 * Math.PI));
    const indexed = wall.getIndexedShapes("edge");
    const seamIndices = indexed.flatMap((e, i) => wall.isHiddenEdge(e.getShape()) ? [i] : []);
    expect(seamIndices).toHaveLength(1);

    const edges = edgeMeshes(meshesOf(wall));
    const drawn = edges.map(m => m.edgeIndex!).sort();
    // The two circles, each at its own slot: the seam's slot stays empty.
    expect(drawn).toEqual(indexed.map((_, i) => i).filter(i => !seamIndices.includes(i)));
    expect(drawn).not.toContain(seamIndices[0]);
    expect(edges.every(m => m.boundary)).toBe(true);
  });

  it("gives a sheet another mesh key when a rim edge's flag changes", () => {
    const sheet = keep(TestSheets.openBox(10, 20, 30));
    const pieces = builder.buildPieces(sheet)!;
    const rimAt = pieces.meshes.findIndex(m => m.boundary);
    expect(rimAt).toBeGreaterThanOrEqual(0);

    const { boundary: _, ...unmarked } = pieces.meshes[rimAt];
    const without = { faces: pieces.faces, meshes: pieces.meshes.map((m, i) => i === rimAt ? unmarked : m) };
    expect(MeshKeys.of(without, { faceColors: null })).not.toBe(MeshKeys.of(pieces, { faceColors: null }));
  });

  it("puts a painted face of a sheet in its own face group", () => {
    const sheet = keep(TestSheets.openBox(10, 20, 30));
    const author = { getOrder: () => 0 } as unknown as SceneObject;
    const colors = new FaceColorView([{ face: sheet.getFaces()[2], color: "#ff0000", setBy: author }]);
    try {
      const groups = faceMeshes(MeshPieces.group(builder.buildPieces(sheet)!, colors, sheet));
      expect(groups).toHaveLength(2);
      const painted = groups.find(m => m.color === "#ff0000")!;
      expect(new Set(painted.faceMapping)).toEqual(new Set([2]));
      const plain = groups.find(m => m.color === undefined)!;
      expect([...new Set(plain.faceMapping)].sort()).toEqual([0, 1, 3, 4]);
    } finally {
      colors.delete();
    }
  });
});

/**
 * A solid's render, reduced to what the UI reads from it: per mesh its
 * label, edge index, flags, sizes, the faces a group maps, and a coordinate
 * sum standing for where its vertices are.
 */
function summaryOf(solid: Solid) {
  return renderBody(solid).map(m => [
    m.label,
    m.edgeIndex ?? null,
    m.smooth ? 1 : 0,
    m.boundary ? 1 : 0,
    m.vertices.length,
    m.indices.length,
    m.faceSides?.length ?? null,
    m.faceMapping ? [...new Set(m.faceMapping)] : null,
    Math.round(m.vertices.reduce((a, b) => a + b, 0) * 1000) / 1000,
  ]);
}

/** One edge line of a summary: index, smooth, vertex count, index count, face-side count, coordinate sum. */
function edgeRow(index: number, smooth: 0 | 1, vertices: number, indices: number, faceSides: number, sum: number) {
  return ["solid-edges", index, smooth, 0, vertices, indices, faceSides, null, sum];
}

/** Which body a fluid statement left: its one shape. */
function solidOf(object: unknown): Solid {
  const [shape] = (object as SceneObject).getShapes();
  expect(shape).toBeInstanceOf(Solid);
  return shape as Solid;
}

describe("body rendering — solid output unchanged", () => {
  setupOC();

  it("renders a box as it always has", () => {
    sketch("xy", () => { testRect(100, 50); });
    const box = extrude(30);
    render();

    const straight = (index: number, sum: number) => edgeRow(index, 0, 6, 2, 6, sum);
    expect(summaryOf(solidOf(box))).toEqual([
      ["solid-faces", null, 0, 0, 72, 36, null, [0, 1, 2, 3, 4, 5], 2160],
      straight(0, 130), straight(1, 30), straight(2, 50), straight(3, 110),
      straight(4, 330), straight(5, 200), straight(6, 260), straight(7, 230),
      straight(8, 250), straight(9, 310), straight(10, 100), straight(11, 160),
    ]);
  });

  it("renders a filleted box as it always has", () => {
    sketch("xy", () => { testRect(100, 50); });
    extrude(30);
    const rounded = fillet(5, select(edge().verticalTo("xy")));
    render();

    const line = (index: number, smooth: 0 | 1, sum: number) => edgeRow(index, smooth, 6, 2, 6, sum);
    const arc = (index: number, sum: number) => edgeRow(index, 0, 30, 18, 54, sum);
    expect(summaryOf(solidOf(rounded))).toEqual([
      ["solid-faces", null, 0, 0, 528, 468, null, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 15840],
      line(0, 0, 50), line(1, 1, 120), line(2, 1, 40), line(3, 0, 110),
      arc(4, 500), arc(5, 37.85), line(6, 0, 200), line(7, 0, 100),
      arc(8, 1462.15), arc(9, 1000), line(10, 0, 250), line(11, 1, 140),
      arc(12, 800), line(13, 1, 40), arc(14, 337.85), line(15, 0, 260),
      line(16, 0, 160), arc(17, 1762.15), arc(18, 1300), line(19, 0, 310),
      line(20, 1, 320), line(21, 1, 220), line(22, 1, 320), line(23, 1, 240),
    ]);
  });
});
