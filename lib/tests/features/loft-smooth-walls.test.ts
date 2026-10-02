import { describe, expect, it } from "vitest";
import { setupOC, render, addToScene } from "../setup.js";
import sketch from "../../core/sketch.js";
import plane from "../../core/plane.js";
import loft from "../../core/loft.js";
import fillet from "../../core/fillet.js";
import { arc, circle, ellipse, line } from "../../core/2d/index.js";
import { Loft } from "../../features/loft.js";
import { Solid } from "../../common/solid.js";
import { Face } from "../../common/face.js";
import { Edge } from "../../common/edge.js";
import { Point } from "../../math/point.js";
import { getOC } from "../../oc/init.js";
import { ShapeValidator } from "../../oc/shape-validator.js";
import { EdgeQuery } from "../../oc/edge-query.js";
import { testRect } from "../helpers/profiles.js";

/** A w × h rectangle about the origin with every corner rounded to r. */
function roundedRect(z: number, w: number, h: number, r: number) {
  return sketch(plane("xy", z), () => {
    const [x, y] = [w / 2, h / 2];
    const bottom = line([-x, -y], [x, -y]);
    const right = line([x, -y], [x, y]);
    const top = line([x, y], [-x, y]);
    const left = line([-x, y], [-x, -y]);
    fillet(r, bottom, right, top, left);
  });
}

/** Two straights of length `length` joined by half circles of radius `r`. */
function slot(z: number, length: number, r: number) {
  return sketch(plane("xy", z), () => {
    const x = length / 2;
    line([-x, -r], [x, -r]);
    arc([x, -r], [x, r], [x, 0]);
    line([x, r], [-x, r]);
    arc([-x, r], [-x, -r], [-x, 0]);
  });
}

function square(z: number, size: number) {
  return sketch(plane("xy", z), () => {
    testRect(size, size, { at: [-size / 2, -size / 2] });
  });
}

function round(z: number, diameter: number) {
  return sketch(plane("xy", z), () => {
    circle([0, 0], diameter);
  });
}

function build(l: Loft): { solid: Solid; walls: Face[] } {
  const sides = l.sideFaces();
  addToScene(sides);
  render();
  expect(l.getError()).toBeNull();
  const solid = l.getShapes()[0] as Solid;
  expect(ShapeValidator.validate(solid.getShape()).findings).toEqual([]);
  return { solid, walls: sides.getShapes() as Face[] };
}

/** The wall edges running from one profile to the other, as [start, end] ordered bottom-up. */
function lateralEdges(solid: Solid, top: number): [Point, Point][] {
  return solid.getEdges()
    .map(edge => [(edge as Edge).getFirstVertex().toPoint(), (edge as Edge).getLastVertex().toPoint()] as [Point, Point])
    .filter(([a, b]) => Math.abs(a.z - b.z) > top / 2)
    .map(([a, b]) => a.z < b.z ? [a, b] : [b, a]);
}

/** Points of the wall at height z, `perWall` per face. */
function crossSection(walls: Face[], z: number, perWall = 24): [number, number][] {
  const oc = getOC();
  const points: [number, number][] = [];
  for (const wall of walls) {
    const adaptor = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(wall.getShape()), true);
    const [u0, u1] = [adaptor.FirstUParameter(), adaptor.LastUParameter()];
    for (let i = 0; i <= perWall; i++) {
      const u = u0 + (u1 - u0) * i / perWall;
      let low = adaptor.FirstVParameter();
      let high = adaptor.LastVParameter();
      for (let iteration = 0; iteration < 60; iteration++) {
        const middle = (low + high) / 2;
        const point = adaptor.Value(u, middle);
        if (point.Z() < z) {
          low = middle;
        } else {
          high = middle;
        }
        point.delete();
      }
      const point = adaptor.Value(u, (low + high) / 2);
      points.push([point.X(), point.Y()]);
      point.delete();
    }
    adaptor.delete();
  }
  return points;
}

function isRational(wall: Face): boolean {
  const oc = getOC();
  const adaptor = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(wall.getShape()), true);
  try {
    return adaptor.IsURational() || adaptor.IsVRational();
  } finally {
    adaptor.delete();
  }
}

/** OCC's offset (shell) refuses a face whose surface is formally C0. */
function expectSmoothSurfaces(walls: Face[]) {
  const oc = getOC();
  for (const wall of walls) {
    const adaptor = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(wall.getShape()), true);
    const surface = adaptor.BSpline();
    expect(surface.IsCNu(1)).toBe(true);
    expect(surface.IsCNv(1)).toBe(true);
    surface.delete();
    adaptor.delete();
  }
}

describe("loft walls", () => {
  setupOC();

  describe("one face per stretch of profile", () => {
    it("keeps a wall whole across the vertices of a circle drawn as arcs", () => {
      const twoArcs = sketch("xy", () => {
        arc([20, 0], [-20, 0], [0, 0]);
        arc([-20, 0], [20, 0], [0, 0]);
      });
      const { solid, walls } = build(loft(twoArcs, round(50, 30)) as Loft);

      // The arcs are one circle: their vertices leave no mark on the wall.
      expect(walls).toHaveLength(1);
      expectSmoothSurfaces(walls);
      expect(solid.getEdges().filter(edge => EdgeQuery.isCircleEdge(edge))).toHaveLength(2);
    });

    it("joins two rounded rectangles flat to flat and corner to corner", () => {
      const { solid, walls } = build(loft(roundedRect(0, 60, 30, 5), roundedRect(50, 30, 40, 8)) as Loft);

      // Four flats and four corners, each lofted to its counterpart: eight
      // walls, not the sixteen strips that parameter-matching cuts.
      expect(walls).toHaveLength(8);
      expectSmoothSurfaces(walls);
      // Lines against lines and quarter turns against quarter turns share
      // their weights, so nothing was approximated.
      expect(walls.some(isRational)).toBe(true);

      // Each wall edge runs from a junction below to the same junction above.
      const edges = lateralEdges(solid, 50);
      expect(edges).toHaveLength(8);
      const junction = (w: number, h: number, r: number) => (p: Point) =>
        Math.min(
          Math.abs(Math.abs(p.x) - (w / 2 - r)) + Math.abs(Math.abs(p.y) - h / 2),
          Math.abs(Math.abs(p.x) - w / 2) + Math.abs(Math.abs(p.y) - (h / 2 - r)),
        );
      for (const [bottom, top] of edges) {
        expect(junction(60, 30, 5)(bottom)).toBeLessThan(1e-6);
        expect(junction(30, 40, 8)(top)).toBeLessThan(1e-6);
        // …on the same side of the same corner.
        expect(Math.sign(bottom.x)).toBe(Math.sign(top.x));
        expect(Math.sign(bottom.y)).toBe(Math.sign(top.y));
        expect(Math.abs(Math.abs(bottom.x) - 30) < 1e-6).toBe(Math.abs(Math.abs(top.x) - 15) < 1e-6);
      }
    });

    it("joins two slots straight to straight and end to end", () => {
      const { solid, walls } = build(loft(slot(0, 40, 10), slot(40, 20, 15)) as Loft);

      expect(walls).toHaveLength(4);
      expectSmoothSurfaces(walls);
      const edges = lateralEdges(solid, 40);
      expect(edges).toHaveLength(4);
      for (const [bottom, top] of edges) {
        expect(Math.abs(bottom.x)).toBeCloseTo(20, 6);
        expect(Math.abs(bottom.y)).toBeCloseTo(10, 6);
        expect(Math.abs(top.x)).toBeCloseTo(10, 6);
        expect(Math.abs(top.y)).toBeCloseTo(15, 6);
        expect(Math.sign(bottom.x)).toBe(Math.sign(top.x));
        expect(Math.sign(bottom.y)).toBe(Math.sign(top.y));
      }
    });

    it.each([
      ["a square to a circle", () => loft(square(0, 40), round(50, 30))],
      ["a circle to a square", () => loft(round(0, 30), square(50, 40))],
    ])("lofts %s as four walls, the seam on a corner", (_, make) => {
      const { solid, walls } = build(make() as Loft);

      // The circle has no vertex and turns to face the square's seam corner;
      // a seam left where the circle started would cut a flat in two.
      expect(walls).toHaveLength(4);
      expectSmoothSurfaces(walls);
      const edges = lateralEdges(solid, 50);
      expect(edges).toHaveLength(4);
      for (const ends of edges) {
        const corner = ends.find(point => Math.hypot(point.x, point.y) > 20)!;
        expect(Math.abs(corner.x)).toBeCloseTo(20, 6);
        expect(Math.abs(corner.y)).toBeCloseTo(20, 6);
      }
    });

    it("puts the seam of every profile that has vertices on one of them", () => {
      const hexagon = sketch("xy", () => {
        const corners = [0, 1, 2, 3, 4, 5].map(i =>
          [20 * Math.cos(0.3 + i * Math.PI / 3), 20 * Math.sin(0.3 + i * Math.PI / 3)] as [number, number]);
        corners.forEach((corner, i) => line(corner, corners[(i + 1) % 6]));
      });
      const { solid } = build(loft(hexagon, square(50, 30)) as Loft);

      // The seam runs corner to corner; no wall edge starts mid-side on both ends.
      const isHexCorner = (p: Point) => Math.abs(Math.hypot(p.x, p.y) - 20) < 1e-6;
      const isSquareCorner = (p: Point) => Math.abs(Math.abs(p.x) - 15) < 1e-6 && Math.abs(Math.abs(p.y) - 15) < 1e-6;
      const edges = lateralEdges(solid, 50);
      expect(edges.some(([bottom, top]) => isHexCorner(bottom) && isSquareCorner(top))).toBe(true);
      for (const [bottom, top] of edges) {
        expect(isHexCorner(bottom) || isSquareCorner(top)).toBe(true);
      }
    });
  });

  describe("tangent condition", () => {
    it("bulges two circles into a barrel that is round", () => {
      const l = loft(round(0, 80), round(60, 80)).startCondition("tangent").endCondition("tangent") as Loft;
      const { walls } = build(l);

      expect(walls).toHaveLength(1);
      const radii = crossSection(walls, 30, 96).map(([x, y]) => Math.hypot(x, y));
      expect(Math.min(...radii)).toBeGreaterThan(45);
      expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(1e-6);
    });

    it("bulges two squares into a barrel that is square", () => {
      const l = loft(square(0, 80), square(60, 80)).startCondition("tangent").endCondition("tangent") as Loft;
      const { walls } = build(l);

      // Every side advances along its own normal and the corners along
      // their miter: the section is the square's offset, corners sharp.
      expect(walls).toHaveLength(4);
      const halfWidths = crossSection(walls, 30).map(([x, y]) => Math.max(Math.abs(x), Math.abs(y)));
      expect(Math.min(...halfWidths)).toBeGreaterThan(45);
      expect(Math.max(...halfWidths) - Math.min(...halfWidths)).toBeLessThan(1e-6);
    });

    it("bulges a rounded rectangle evenly along flats and corners", () => {
      const l = loft(roundedRect(0, 80, 80, 10), roundedRect(60, 80, 80, 10))
        .startCondition("tangent").endCondition("tangent") as Loft;
      const { walls } = build(l);

      // Distance from the profile itself (40 × 40 half-extents, r = 10).
      const distance = ([x, y]: [number, number]) => {
        const [qx, qy] = [Math.abs(x) - 30, Math.abs(y) - 30];
        return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - 10;
      };
      const offsets = crossSection(walls, 30).map(distance);
      expect(Math.min(...offsets)).toBeGreaterThan(5);
      expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThan(1e-6);
    });

    it("bulges a teardrop evenly, its point running out along its flanks", () => {
      // A circle of radius 15 with two tangents meeting at a point 40 out.
      const angle = Math.acos(15 / 40);
      const [tx, ty] = [15 * Math.cos(angle), 15 * Math.sin(angle)];
      const teardrop = (z: number) => sketch(plane("xy", z), () => {
        line([40, 0], [tx, ty]);
        arc([tx, ty], [tx, -ty], [0, 0]);
        line([tx, -ty], [40, 0]);
      });
      const l = loft(teardrop(0), teardrop(60)).startCondition("tangent").endCondition("tangent") as Loft;
      const { walls } = build(l);

      // Half-way up the round end has grown by 15. So has everything else:
      // the flanks moved out by 15 and the point to where they now meet. The
      // point's sideways motion fades along the flanks and never reaches the
      // round end, which would be pulled out of round by it.
      expect(walls).toHaveLength(3);
      const section = crossSection(walls, 30, 96);
      const grown = -Math.min(...section.map(([x]) => x)) - 15;
      expect(grown).toBeCloseTo(15, 6);
      const flank = Math.hypot(ty, 40 - tx);
      for (const [x, y] of section) {
        const alongFlank = ((x - tx) * (40 - tx) - (Math.abs(y) - ty) * ty) / flank;
        const offset = alongFlank < 0
          ? Math.hypot(x, y) - 15
          : ((x - 40) * ty + Math.abs(y) * (40 - tx)) / flank;
        expect(offset).toBeCloseTo(grown, 6);
      }
      expect(Math.max(...section.map(([x]) => x))).toBeCloseTo(40 + grown / Math.sin(Math.PI / 2 - angle), 6);
    });

    it("bulges an ellipse evenly all round", () => {
      const lower = sketch("xy", () => {
        ellipse([0, 0], 40, 20);
      });
      const upper = sketch(plane("xy", 60), () => {
        ellipse([0, 0], 40, 20);
      });
      const l = loft(lower, upper).startCondition("tangent").endCondition("tangent") as Loft;
      const { walls } = build(l);

      expect(walls).toHaveLength(1);
      const distance = ([x, y]: [number, number]) => {
        let nearest = Infinity;
        for (let i = 0; i < 20000; i++) {
          const angle = 2 * Math.PI * i / 20000;
          nearest = Math.min(nearest, Math.hypot(x - 40 * Math.cos(angle), y - 20 * Math.sin(angle)));
        }
        return nearest;
      };
      const offsets = crossSection(walls, 30, 64).map(distance);
      expect(Math.min(...offsets)).toBeGreaterThan(5);
      expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThan(0.02);
    });
  });
});
