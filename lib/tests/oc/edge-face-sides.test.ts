import { describe, it, expect } from "vitest";
import { setupOC } from "../setup.js";
import { getOC } from "../../oc/init.js";
import { Explorer } from "../../oc/explorer.js";
import { Primitives } from "../../oc/primitives.js";
import { BooleanOps } from "../../oc/boolean-ops.js";
import { Solid } from "../../common/solid.js";
import { Shape } from "../../common/shape.js";
import { renderSolid } from "../../rendering/render-solid.js";
import { transformMeshes } from "../../rendering/mesh-transform.js";
import { Matrix4 } from "../../math/matrix4.js";
import type { SceneObjectMesh } from "../../rendering/scene.js";
import { alignNodes, FaceFacets, FACE_SIDE_STRIDE, roundSide } from "../../oc/edge-face-sides.js";

type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => { const l = length(a); return [a[0] / l, a[1] / l, a[2] / l]; };

function box(dx: number, dy: number, dz: number): Solid {
  const oc = getOC();
  const maker = new oc.BRepPrimAPI_MakeBox(dx, dy, dz);
  const shape = maker.Shape();
  maker.delete();
  try {
    return Solid.fromTopoDSSolid(Explorer.toSolid(shape));
  } finally {
    shape.delete();
  }
}

function edgeMeshes(shape: Shape): SceneObjectMesh[] {
  return renderSolid(shape).filter(m => m.label === "solid-edges");
}

function vertexAt(mesh: SceneObjectMesh, i: number): V3 {
  return [mesh.vertices[i * 3], mesh.vertices[i * 3 + 1], mesh.vertices[i * 3 + 2]];
}

/** Every segment of an edge line: its ends and its two face vectors. */
function segments(mesh: SceneObjectMesh) {
  const out: { a: V3; b: V3; sideA: V3; sideB: V3 }[] = [];
  for (let k = 0; k < mesh.indices.length / 2; k++) {
    const s = mesh.faceSides!.slice(k * FACE_SIDE_STRIDE, (k + 1) * FACE_SIDE_STRIDE);
    out.push({
      a: vertexAt(mesh, mesh.indices[2 * k]),
      b: vertexAt(mesh, mesh.indices[2 * k + 1]),
      sideA: [s[0], s[1], s[2]],
      sideB: [s[3], s[4], s[5]],
    });
  }
  return out;
}

/**
 * What the viewer reads from a segment's two face vectors: whether the edge
 * is convex (their order) and each face's outward normal (square to the
 * segment and the face's vector, turned away from the other face at a convex
 * edge, toward it at a concave one) — see face-edge-line.ts.
 */
function readSegment(seg: { a: V3; b: V3; sideA: V3; sideB: V3 }) {
  const t = sub(seg.b, seg.a);
  const a = unit(seg.sideA);
  const b = unit(seg.sideB);
  const convex = dot(cross(a, b), t) > 0;
  let normalA = unit(cross(t, a));
  let normalB = unit(cross(t, b));
  if ((dot(normalA, b) < 0) !== convex) normalA = [-normalA[0], -normalA[1], -normalA[2]];
  if ((dot(normalB, a) < 0) !== convex) normalB = [-normalB[0], -normalB[1], -normalB[2]];
  return { convex, normalA, normalB };
}

const near = (a: V3, b: V3, tolerance = 1e-3) =>
  expect(Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))).toBeLessThan(tolerance);

/**
 * A solid's edge line carries, per segment, the vector from the segment into
 * the face triangle on either side of it, as long as the face runs flat
 * from there, the two in an order that gives the edge's convexity. The
 * viewer draws each half of the line on the face it covers from these.
 */
describe("edge face sides", () => {
  setupOC();

  it("gives a box edge the two faces' directions, reaches and outward normals", () => {
    const edges = edgeMeshes(box(10, 20, 30));
    // The edge along X at y = 0, z = 0: between the face y = 0 (10 × 30)
    // and the face z = 0 (10 × 20).
    const mesh = edges.find(m => {
      const v = m.vertices;
      return v.every((c, i) => (i % 3 === 0 ? true : Math.abs(c) < 1e-9)) && Math.abs(v[0] - v[3]) > 9;
    })!;
    expect(mesh).toBeDefined();
    expect(mesh.faceSides).toHaveLength(FACE_SIDE_STRIDE);

    const [seg] = segments(mesh);
    const sides = [seg.sideA, seg.sideB];
    // Into the face y = 0 (up, as far as the face runs: 30) and into the face
    // z = 0 (along +Y, 20 across).
    near(sides.find(s => s[2] > 0)!, [0, 0, 30]);
    near(sides.find(s => s[1] > 0)!, [0, 20, 0]);

    const { convex, normalA, normalB } = readSegment(seg);
    expect(convex).toBe(true);
    const normals = [normalA, normalB];
    // The normals the viewer derives are the faces' outward ones.
    near(normals[sides.findIndex(s => s[2] > 0)], [0, -1, 0]);
    near(normals[sides.findIndex(s => s[1] > 0)], [0, 0, -1]);
  });

  it("orders every box edge as convex", () => {
    for (const mesh of edgeMeshes(box(10, 20, 30))) {
      for (const seg of segments(mesh)) {
        expect(readSegment(seg).convex).toBe(true);
      }
    }
  });

  it("follows a cylinder's top rim on the cap and down the wall", () => {
    const radius = 10;
    const height = 20;
    const edges = edgeMeshes(Primitives.makeCylinder(radius, height));
    const rim = edges.find(m => m.vertices.every((c, i) => i % 3 !== 2 || Math.abs(c - height) < 1e-9))!;
    expect(rim).toBeDefined();

    const segs = segments(rim);
    expect(segs.length).toBeGreaterThan(8);
    for (const seg of segs) {
      const mid: V3 = [(seg.a[0] + seg.b[0]) / 2, (seg.a[1] + seg.b[1]) / 2, height];
      const towardAxis = unit([-mid[0], -mid[1], 0]);
      const cap = [seg.sideA, seg.sideB].find(s => Math.abs(s[2]) < 1e-6)!;
      const wall = [seg.sideA, seg.sideB].find(s => s[2] < -1e-6)!;
      // The cap's vector lies in the cap, square to the chord, toward the
      // axis, and runs on across the flat cap well past its own triangle.
      expect(dot(unit(cap), towardAxis)).toBeGreaterThan(0.9);
      expect(Math.abs(dot(unit(cap), unit(sub(seg.b, seg.a))))).toBeLessThan(1e-3);
      expect(length(cap)).toBeGreaterThan(radius);
      // The wall's runs straight down, as far as its triangle reaches.
      near(unit(wall), [0, 0, -1]);
      expect(length(wall)).toBeCloseTo(height, 3);

      const { convex, normalA, normalB } = readSegment(seg);
      expect(convex).toBe(true);
      const capNormal = seg.sideA === cap ? normalA : normalB;
      const wallNormal = seg.sideA === wall ? normalA : normalB;
      near(capNormal, [0, 0, 1]);
      expect(dot(wallNormal, unit([mid[0], mid[1], 0]))).toBeGreaterThan(0.99);
    }
  });

  it("reads a reversed face (a hole's wall) by its triangles, not its surface", () => {
    // A quarter hole cut at the box's corner: the cylinder's wall is in the
    // result reversed, its outward normal pointing at the axis.
    const holed = BooleanOps.cutShapes(box(40, 40, 10), Primitives.makeCylinder(5, 10));
    const rim = edgeMeshes(holed).find(m => {
      const v = m.vertices;
      for (let i = 0; i < v.length; i += 3) {
        if (Math.abs(v[i + 2] - 10) > 1e-9 || Math.abs(Math.hypot(v[i], v[i + 1]) - 5) > 1e-6) {
          return false;
        }
      }
      return true;
    })!;
    expect(rim).toBeDefined();

    for (const seg of segments(rim)) {
      const mid: V3 = [(seg.a[0] + seg.b[0]) / 2, (seg.a[1] + seg.b[1]) / 2, 10];
      const fromAxis = unit([mid[0], mid[1], 0]);
      const top = [seg.sideA, seg.sideB].find(s => Math.abs(s[2]) < 1e-6)!;
      const wall = [seg.sideA, seg.sideB].find(s => s[2] < -1e-6)!;
      // Into the top face, away from the hole; down the wall.
      expect(dot(unit(top), fromAxis)).toBeGreaterThan(0.9);
      near(unit(wall), [0, 0, -1]);

      // The rim of a hole is convex; the wall's outward normal faces the axis.
      const { convex, normalA, normalB } = readSegment(seg);
      expect(convex).toBe(true);
      const wallNormal = seg.sideA === wall ? normalA : normalB;
      const topNormal = seg.sideA === top ? normalA : normalB;
      expect(dot(wallNormal, fromAxis)).toBeLessThan(-0.99);
      near(topNormal, [0, 0, 1]);
    }
  });

  it("orders a concave edge as concave", () => {
    // A step: the inside corner where the lower block's top meets the upper
    // block's side.
    const oc = getOC();
    const lower = box(20, 10, 5);
    const upperMaker = new oc.BRepPrimAPI_MakeBox(10, 10, 10);
    const upperShape = upperMaker.Shape();
    upperMaker.delete();
    const upper = Solid.fromTopoDSSolid(Explorer.toSolid(upperShape));
    upperShape.delete();
    const fusion = BooleanOps.fuse([lower, upper]);
    const fused = fusion.result[0];

    // Along Y at x = 10, z = 5.
    const corner = edgeMeshes(fused).find(m => {
      const v = m.vertices;
      return Math.abs(v[0] - 10) < 1e-9 && Math.abs(v[2] - 5) < 1e-9 && Math.abs(v[3] - 10) < 1e-9 && Math.abs(v[5] - 5) < 1e-9;
    })!;
    expect(corner).toBeDefined();
    const [seg] = segments(corner);
    const { convex, normalA, normalB } = readSegment(seg);
    expect(convex).toBe(false);
    const floor = seg.sideA[0] > 0 ? normalA : normalB;
    const wall = seg.sideA[2] > 0 ? normalA : normalB;
    near(floor, [0, 0, 1]);
    near(wall, [1, 0, 0]);
  });

  it("keeps the pair's order and the segments' directions through a mirror", () => {
    const [mesh] = edgeMeshes(box(10, 20, 30));
    const mirror = Matrix4.fromScale(-1, 1, 1);
    const [moved] = transformMeshes([mesh], mirror);
    // The index pairs are not re-wound like triangles.
    expect(moved.indices).toEqual(mesh.indices);
    for (const seg of segments(moved)) {
      expect(readSegment(seg).convex).toBe(true);
    }
  });
});

describe("FaceFacets.reach", () => {
  // A 10 × 4 rectangle in z = 0, wound counter-clockwise seen from +Z:
  // nodes 0 (0,0) 1 (10,0) 2 (10,4) 3 (0,4) 4 (5,0.01).
  const flat = [0, 0, 0, 10, 0, 0, 10, 4, 0, 0, 4, 0, 5, 0.01, 0];
  const fan = [0, 4, 3, 4, 1, 2, 4, 2, 3];

  it("runs across the flat face past a sliver triangle", () => {
    // A 10 × 4 triangle over the side (0, 1), with a sliver 0.01 high
    // lining that side: nodes 0 (0,0) 1 (10,0) 2 (5,0.01) 3 (5,4).
    const sliver = new FaceFacets(
      [0, 0, 0, 10, 0, 0, 5, 0.01, 0, 5, 4, 0],
      [0, 1, 2, 0, 2, 3, 2, 1, 3],
    );
    expect(sliver.reach(0, 1, 2, 0.01)).toBeCloseTo(4, 6);
  });

  it("stops where the next triangle leaves the plane — a curved face's reach is its triangle", () => {
    const bent = new FaceFacets(
      [0, 0, 0, 10, 0, 0, 5, 0.01, 0, 5, 4, 2],
      [0, 1, 2, 0, 2, 3, 2, 1, 3],
    );
    expect(bent.reach(0, 1, 2, 0.01)).toBeLessThan(0.02);
  });

  it("reads a triangle's outward normal from its winding, whichever way the side is asked", () => {
    const facets = new FaceFacets(flat, fan);
    expect(facets.outwardNormal(4, 1, 2)[2]).toBeGreaterThan(0);
    expect(facets.outwardNormal(1, 4, 2)[2]).toBeGreaterThan(0);
  });
});

describe("edge face side helpers", () => {
  it("rounds a side vector to a ten-thousandth of its length", () => {
    expect(roundSide(1.41421356, 1.41421356, 0)).toEqual([1.4142, 1.4142, 0]);
    expect(roundSide(70.710678, 0.0001, 0)).toEqual([70.711, 0, 0]);
    expect(roundSide(0, 0, 0)).toEqual([0, 0, 0]);
  });

  it("aligns another face's polygon to the polyline, a closed one included", () => {
    // A square loop 0 → 1 → 2 → 3 → 0 read by the reference face, and the
    // same loop stored backwards by the other face.
    const ref = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
    const reference = [0, 1, 2, 3, 0];
    const other = [0, 1, 0, 1, 1, 0, 1, 0, 0, 0, 0, 0];
    // other's nodes: 0 (0,1) 1 (1,1) 2 (1,0) 3 (0,0); backwards from (0,0).
    const nodes = [3, 0, 1, 2, 3];
    expect(alignNodes(reference, ref, nodes, other)).toEqual([3, 2, 1, 0, 3]);
    expect(alignNodes(reference, ref, [3, 2, 1, 0, 3], other)).toEqual([3, 2, 1, 0, 3]);
    expect(alignNodes(reference, ref, [3, 2, 1], other)).toBeNull();
  });
});
