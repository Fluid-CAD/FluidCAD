import { describe, expect, it } from "vitest";
import { setupOC } from "../setup.js";
import { Point } from "../../math/point.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { WireOps } from "../../oc/wire-ops.js";
import { SectionCompatibility } from "../../oc/loft/section-compatibility.js";
import { evaluateBSplinePoint } from "../../oc/loft/curve-eval.js";
import { SectionCurve } from "../../oc/loft/section-curve.js";
import { ConnectionResolver } from "../../oc/loft/connection-resolver.js";
import { LoftOps } from "../../oc/loft-ops.js";
import { ShapeValidator } from "../../oc/shape-validator.js";
import { Solid } from "../../common/solid.js";
import { Wire } from "../../common/wire.js";
import { Explorer } from "../../oc/explorer.js";
import { Geometry } from "../../oc/geometry.js";
import { getOC } from "../../oc/init.js";
import { Vector3d } from "../../math/vector3d.js";
import { Face } from "../../common/face.js";
import { FaceOps } from "../../oc/face-ops.js";
import { ExtrudeOps } from "../../oc/extrude-ops.js";
import { ThinFaceMaker } from "../../oc/thin-face-maker.js";
import { Plane } from "../../math/plane.js";
import type { ThinLoftWalls } from "../../oc/loft-ops.js";

function polygon(points: Point[]) {
  return WireOps.makeWireFromEdges(points.map((point, i) =>
    EdgeOps.makeLineEdge(point, points[(i + 1) % points.length]),
  ));
}

function square(z: number): Point[] {
  return [[-40, -40], [40, -40], [40, 40], [-40, 40]].map(([x, y]) => new Point(x, y, z));
}

function roundPoint(angle: number, z: number, radius = 40): Point {
  return new Point(radius * Math.cos(angle), radius * Math.sin(angle), z);
}

function splitCircle(z: number, angles = [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
  const points = angles.map(angle => roundPoint(angle, z));
  const edges = angles.map((_, i) => {
    const curve = Geometry.makeArc(new Point(0, 0, z), 40, new Vector3d(0, 0, 1), points[i], points[(i + 1) % points.length]);
    try {
      return Geometry.makeEdgeFromCurve(curve);
    } finally {
      curve.delete();
    }
  });
  return { wire: WireOps.makeWireFromEdges(edges), points };
}

/** One single topological edge must pass through ALL points of each connection. */
function expectConnections(solid: Solid, connections: Point[][], faces?: number): number {
  const validation = ShapeValidator.validate(solid.getShape());
  expect(validation.findings).toEqual([]);
  expect(validation.solids).toBe(1);
  if (faces !== undefined) {
    expect(validation.faces).toBe(faces);
  }
  const edges = Explorer.findEdgesWrapped(solid);
  for (const connection of connections) {
    const gap = Math.min(...edges.map(edge => Math.max(
      ...connection.map(point => EdgeOps.distancePointToEdge(point, edge)),
    )));
    expect(gap).toBeLessThan(1e-6);
  }
  return validation.solidVolumes[0];
}

describe("loft section compatibility", () => {
  setupOC();

  it("moves an automatic seam onto a polygon corner without sliver spans", () => {
    const bottom = square(0);
    const top = square(50);
    const a = polygon(bottom);
    const b = polygon([...top.slice(1), top[0]]);
    const compatible = SectionCompatibility.build([a.getShape(), b.getShape()]);

    expect(compatible.degree).toBe(1);
    expect(compatible.knots).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(compatible.creases).toEqual([0.25, 0.5, 0.75]);
    for (const [i, section] of compatible.sections.entries()) {
      expect(section.poles).toHaveLength(5);
      for (let corner = 0; corner < 4; corner++) {
        const actual = evaluateBSplinePoint({ ...compatible, poles: section.poles }, corner / 4);
        expect(Point.fromArray(actual as [number, number, number]).distanceTo([bottom, top][i][corner]))
          .toBeLessThan(1e-8);
      }
    }
  });

  it("leaves a seam within the snap band where it is instead of splitting off a sliver", () => {
    const oc = getOC();
    // The second circle's seam sits 5e-7 of a turn before the first one's, so
    // the nearest-seam search lands 5e-7 past the existing seam.
    const circle = (z: number, turn: number) => {
      const angle = 2 * Math.PI * turn;
      const origin = new oc.gp_Pnt(0, 0, z);
      const normal = new oc.gp_Dir(0, 0, 1);
      const xDirection = new oc.gp_Dir(Math.cos(angle), Math.sin(angle), 0);
      const axes = new oc.gp_Ax2(origin, normal, xDirection);
      const circ = new oc.gp_Circ(axes, 40);
      const edgeMaker = new oc.BRepBuilderAPI_MakeEdge(circ);
      const wireMaker = new oc.BRepBuilderAPI_MakeWire(edgeMaker.Edge());
      try {
        return wireMaker.Wire();
      } finally {
        wireMaker.delete();
        edgeMaker.delete();
        circ.delete();
        axes.delete();
        xDirection.delete();
        normal.delete();
        origin.delete();
      }
    };

    const compatible = SectionCompatibility.build([circle(0, 0), circle(50, -5e-7)]);

    // Untouched rational circles: no split, no polynomial fallback.
    expect(compatible.weights).not.toBeNull();
    expect(compatible.knots).toHaveLength(4);
    expect(compatible.sections[0].poles).toHaveLength(7);
    expect(compatible.creases).toEqual([]);
  });

  it("records exact topology junction knots independently of internal curve knots", () => {
    const { wire, points } = splitCircle(30, [0, Math.PI / 2]);
    for (const polynomial of [false, true]) {
      const section = SectionCurve.fromWireWithVertices(wire.getShape(), polynomial);
      try {
        expect(section.vertices).toHaveLength(2);
        expect(section.curve.NbKnots()).toBeGreaterThan(3);
        for (const [i, vertex] of section.vertices.entries()) {
          expect(vertex.point.distanceTo(points[i])).toBeLessThan(1e-10);
          const knots = Array.from({ length: section.curve.NbKnots() }, (_, k) => section.curve.Knot(k + 1));
          expect(knots).toContain(vertex.parameter);
          const point = section.curve.Value(vertex.parameter);
          expect(new Point(point.X(), point.Y(), point.Z()).distanceTo(points[i])).toBeLessThan(1e-8);
          point.delete();
        }
      } finally {
        section.curve.delete();
      }
    }
  });
});

describe("loft kernel connections", () => {
  setupOC();

  it.each([0, -1])("honours four corners with twist offset %i and preserves the plain loft volume", offset => {
    const a = square(0);
    const b = a.map(p => new Point((p.x - p.y) / Math.SQRT2, (p.x + p.y) / Math.SQRT2, 100));
    const wires = [polygon(a), polygon(b)];
    const connections = a.map((point, i) => [point, b[(i + offset + 4) % 4]]);
    const [connected] = LoftOps.makeLoft(wires, { connections });
    const volume = expectConnections(connected, connections, 6);
    const [plain] = LoftOps.makeLoft(wires);
    const plainVolume = ShapeValidator.signedVolume(plain.getShape());
    expect(Math.abs(volume - plainVolume) / plainVolume).toBeLessThan(1e-8);
  });

  it("matches square and hexagon spans with two connections", () => {
    const a = square(0);
    const b = Array.from({ length: 6 }, (_, i) => roundPoint(5 * Math.PI / 4 + i * Math.PI / 3, 80));
    const connections = [[a[0], b[0]], [a[2], b[3]]];
    const [solid] = LoftOps.makeLoft([polygon(a), polygon(b)], { connections });
    expectConnections(solid, connections, 10);
  });

  it("puts a single connected edge through four sections, including intermediate vertices", () => {
    const profiles = [0, 25, 60, 100].map((z, k) => square(z).map(point =>
      new Point(point.x * (1 + k * 0.1) + k * 4, point.y, z),
    ));
    const connections = [profiles.map(profile => profile[2])];
    const [solid] = LoftOps.makeLoft(profiles.map(polygon), { connections });
    expectConnections(solid, connections);
  });

  it.each([0, 1, 2])("preserves vertex identity when profile %i has reversed winding", reversed => {
    const profiles = [square(0), square(40), square(80)];
    const wires = profiles.map((points, i) => polygon(i === reversed ? [...points].reverse() : points));
    // Connection order need not be the order around the profile, and the
    // first pin deliberately moves every seam to an interior knot.
    const connections = [2, 0, 3, 1].map(i => profiles.map(profile => profile[i]));
    const [solid] = LoftOps.makeLoft(wires, { connections });
    expectConnections(solid, connections, 6);
  });

  it("retries rational alignment as polynomial without dropping smooth-junction connections", () => {
    const a = splitCircle(0);
    const b = splitCircle(80);
    const wires = [a.wire, b.wire];
    const rawWires = wires.map(wire => wire.getShape());
    // These circles share rational weights until the connection changes
    // their relative span lengths (90 degrees on A, 180 degrees on B).
    expect(SectionCompatibility.build(rawWires).weights).not.toBeNull();
    const connections = [[a.points[0], b.points[0]], [a.points[1], b.points[2]]];
    const compatible = SectionCompatibility.build(rawWires, ConnectionResolver.resolve(wires, connections));
    expect(compatible.weights).toBeNull();
    expect(compatible.creases).toHaveLength(1);
    expect(compatible.creases[0]).toBeCloseTo(0.375, 8);
    const [solid] = LoftOps.makeLoft(wires, { connections });
    expectConnections(solid, connections, 4);
  });

  it("aligns mixed polygon and rational sections on the polynomial pass", () => {
    const a = square(0);
    const b = splitCircle(80);
    const connections = [[a[2], b.points[1]], [a[0], b.points[2]]];
    const [solid] = LoftOps.makeLoft([polygon(a), b.wire], { connections });
    expectConnections(solid, connections);
  });

  it("composes connections with both end conditions", () => {
    const a = square(0);
    const b = square(80).map(point => new Point(point.x / 2, point.y / 2, point.z));
    const wires = [polygon(a), polygon(b)];
    const connections = a.map((point, i) => [point, b[i]]);
    const [plain] = LoftOps.makeLoft(wires, { connections });
    const [conditioned] = LoftOps.makeLoft(wires, {
      connections,
      startCondition: { kind: "normal", magnitude: 1 },
      endCondition: { kind: "normal", magnitude: 1 },
    });
    const volume = expectConnections(conditioned, connections, 6);
    expect(volume).toBeGreaterThan(ShapeValidator.signedVolume(plain.getShape()) * 1.01);
    const oc = getOC();
    for (const connection of connections) {
      const edge = Explorer.findEdgesWrapped(conditioned).find(edge =>
        connection.every(point => EdgeOps.distancePointToEdge(point, edge) < 1e-6),
      )!;
      const curve = new oc.BRepAdaptor_Curve(edge.getShape());
      const point = new oc.gp_Pnt();
      const tangent = new oc.gp_Vec();
      try {
        for (const parameter of [curve.FirstParameter(), curve.LastParameter()]) {
          curve.D1(parameter, point, tangent);
          expect(Math.hypot(tangent.X(), tangent.Y())).toBeLessThan(1e-6);
          expect(Math.abs(tangent.Z())).toBeGreaterThan(1);
        }
      } finally {
        curve.delete();
        point.delete();
        tangent.delete();
      }
    }
  });

  it("connects two-edge profiles, twisting a pair of arcs a quarter turn", () => {
    const a = splitCircle(0, [0, Math.PI]);
    const b = splitCircle(60, [Math.PI / 2, 3 * Math.PI / 2]);
    const connections = [[a.points[0], b.points[0]], [a.points[1], b.points[1]]];
    const solid = LoftOps.makeLoft([a.wire, b.wire], { connections })[0];
    expectConnections(solid, connections, 4);
  });

  it("reads vertices off face boundary wires whose edges are stored reversed", () => {
    const oc = getOC();
    const outline = [[-37, -42], [44, -34], [51, 13], [14, 47], [-30, 31]].map(([x, y]) => new Point(x, y, 0));
    const base = Face.fromTopoDSFace(FaceOps.makeFace(polygon(outline).getShape()));
    const prism = ExtrudeOps.makePrism(base, new Vector3d(0, 0, 1), 70);
    const caps = Explorer.findFacesWrapped(prism).filter(face => {
      const heights = face.getWires()[0].getVertices().map(vertex => vertex.toPoint().z);
      return heights.every(z => Math.abs(z - heights[0]) < 1e-9);
    }) as Face[];
    expect(caps).toHaveLength(2);
    const wires = caps
      .map(face => face.getWires()[0])
      .sort((w1, w2) => w1.getVertices()[0].toPoint().z - w2.getVertices()[0].toPoint().z);

    // The case under test: a solid's face wires carry reversed edges.
    let reversed = 0;
    for (const wire of wires) {
      const explorer = new oc.BRepTools_WireExplorer(wire.getShape());
      while (explorer.More()) {
        if (explorer.Current().Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED) {
          reversed++;
        }
        explorer.Next();
      }
      explorer.delete();
    }
    expect(reversed).toBeGreaterThan(0);

    // One corner step of twist, so the connections are what decides the result.
    const top = outline.map(point => point.translateZ(70));
    const connections = [[outline[0], top[1]], [outline[2], top[3]], [outline[3], top[4]]];
    const solid = LoftOps.makeLoft(wires, { connections })[0];
    // 3 connection lines + the 4 unconnected corners, whose arc-length
    // positions differ between the twisted profiles: 7 walls + 2 caps.
    expectConnections(solid, connections, 9);
  });

  it("accepts a point within contact tolerance and snaps it to the actual vertex", () => {
    const a = square(0);
    const b = square(80);
    const [solid] = LoftOps.makeLoft([polygon(a), polygon(b)], {
      connections: [[a[1].translate(0.0005, 0), b[2].translate(0, 0.0005)]],
    });
    expectConnections(solid, [[a[1], b[2]]]);
  });

  it("names crossed connections and the consecutive profiles where their order changes", () => {
    const [a, b, c] = [square(0), square(40), square(80)];
    expect(() => LoftOps.makeLoft([polygon(a), polygon(b), polygon(c)], {
      connections: [[a[0], b[0], c[0]], [a[1], b[1], c[2]], [a[2], b[2], c[1]]],
    })).toThrow("Loft connections 2 and 3 cross between profile 2 and profile 3.");
  });

  it("rejects the same vertex in two connections", () => {
    const a = square(0);
    const b = square(80);
    expect(() => LoftOps.makeLoft([polygon(a), polygon(b)], {
      connections: [[a[0], b[0]], [a[1], b[0].translate(0.0001, 0)]],
    })).toThrow("Loft connections 1 and 2 use the same vertex on profile 2.");
  });

  it("rejects a missing profile point", () => {
    const a = square(0);
    expect(() => LoftOps.makeLoft([polygon(a), polygon(square(80))], { connections: [[a[0]]] }))
      .toThrow("connect expects 2 points, one per profile, got 1");
  });

  it("distinguishes a point on an edge from a point off its profile", () => {
    const a = square(0);
    const b = square(80);
    const wires = [polygon(a), polygon(b)];
    expect(() => LoftOps.makeLoft(wires, { connections: [[a[0], new Point(0, -40, 80)]] }))
      .toThrow(/connection 1: the point for profile 2 lies on an edge, not on a vertex/);
    expect(() => LoftOps.makeLoft(wires, { connections: [[a[0], new Point(0, -45, 80)]] }))
      .toThrow(/profile 2 is off its profile \(gap 5\.00000 mm\)/);
  });

  it("rejects non-finite coordinates before kernel point queries", () => {
    const a = square(0);
    expect(() => LoftOps.makeLoft([polygon(a), polygon(square(80))], {
      connections: [[a[0], new Point(NaN, 0, 80)]],
    })).toThrow(/profile 2 must have finite coordinates/);
  });

  it("rejects the artificial seam of an unsplit circle", () => {
    const oc = getOC();
    const curve = Geometry.makeCircle(new Point(0, 0, 80), 40, new Vector3d(0, 0, 1));
    const maker = new oc.BRepBuilderAPI_MakeEdge(curve);
    const wireMaker = new oc.BRepBuilderAPI_MakeWire(maker.Edge());
    const a = square(0);
    try {
      const b = Wire.fromTopoDSWire(wireMaker.Wire());
      expect(() => LoftOps.makeLoft([polygon(a), b], { connections: [[a[0], new Point(40, 0, 80)]] }))
        .toThrow(/lies on an edge, not on a vertex/);
    } finally {
      wireMaker.delete();
      maker.delete();
      curve.delete();
    }
  });

  it("rejects open and non-planar profiles", () => {
    const a = square(0);
    const b = square(80);
    const open = WireOps.makeWireFromEdges([EdgeOps.makeLineEdge(b[0], b[1])]);
    expect(() => LoftOps.makeLoft([polygon(a), open], { connections: [[a[0], b[0]]] }))
      .toThrow(/closed profiles; profile 2 is open/);
    b[2] = b[2].translateZ(10);
    expect(() => LoftOps.makeLoft([polygon(a), polygon(b)], { connections: [[a[0], b[0]]] }))
      .toThrow(/planar profiles; profile 2 is not planar/);
  });

});

describe("loft kernel connections with thin walls", () => {
  setupOC();

  /** The walls `Loft.buildThinLoft` hands the kernel for one square profile. */
  function walls(points: Point[], thin: [number] | [number, number]): ThinLoftWalls {
    const ring = ThinFaceMaker.make([polygon(points)], Plane.XY().translate(0, 0, points[0].z), thin[0], thin[1]);
    const [outer, inner] = ring.faces[0].getWires();
    const { source, outerDistance, innerDistance } = ring.walls[0];
    return { outer, inner, source, outerDistance, innerDistance: innerDistance! };
  }

  /**
   * Where a corner of an origin-centred square lands on each wall, along the
   * corner's bisector: the crest of the outward rounding arc sits `distance`
   * out, the sharp inward corner `distance · √2` in.
   */
  function images(corner: Point, distance: number, outward: boolean): Point {
    const radius = Math.hypot(corner.x, corner.y);
    const along = outward ? distance : -distance * Math.SQRT2;
    return new Point(corner.x * (1 + along / radius), corner.y * (1 + along / radius), corner.z);
  }

  it.each([[[3]], [[-3]], [[2, 3]]] as [[number] | [number, number]][])("carries a twisted square's corners onto both walls of thin %j", thin => {
    const a = square(0);
    const b = a.map(p => new Point((p.x - p.y) / Math.SQRT2, (p.x + p.y) / Math.SQRT2, 100));
    const connections = a.map((point, i) => [point, b[(i + 1) % 4]]);
    const sections = [walls(a, thin), walls(b, thin)];
    const [solid] = LoftOps.makeThinLoft(sections, { connections });
    const validation = ShapeValidator.validate(solid.getShape());
    expect(validation.findings).toEqual([]);
    expect(validation.solids).toBe(1);
    const { outerDistance, innerDistance } = sections[0];
    // Every connection has an edge on the outer wall and one on the inner wall.
    const outer = connections.map(row => row.map(point => images(point, outerDistance, true)));
    const inner = connections.map(row => row.map(point => images(point, innerDistance, false)));
    expectConnections(solid, outerDistance > 0 ? outer : connections);
    expectConnections(solid, innerDistance > 0 ? inner : connections);
  });

  it("reproduces the boolean thin loft's volume when connections agree with the automatic matching", () => {
    const a = square(0);
    const b = square(100);
    const connections = a.map((point, i) => [point, b[i]]);
    const [connected] = LoftOps.makeThinLoft([walls(a, [3]), walls(b, [3])], { connections });
    // Outer 86 × 86 with 3 mm rounded corners, inner 80 × 80, 100 tall.
    const expected = (86 * 86 - (4 - Math.PI) * 9 - 80 * 80) * 100;
    const volume = ShapeValidator.signedVolume(connected.getShape());
    expect(Math.abs(volume - expected) / expected).toBeLessThan(1e-6);
  });

  it("composes thin walls, connections and an end condition", () => {
    const a = square(0);
    const b = a.map(p => new Point((p.x - p.y) / Math.SQRT2, (p.x + p.y) / Math.SQRT2, 100));
    const connections = a.map((point, i) => [point, b[i]]);
    const [solid] = LoftOps.makeThinLoft([walls(a, [-3]), walls(b, [-3])], {
      connections, endCondition: { kind: "normal", magnitude: 1 },
    });
    expectConnections(solid, connections);
    expectConnections(solid, connections.map(row => row.map(point => images(point, 3, false))));
  });

  it("refuses a smooth junction that the wall offset merges away", () => {
    const a = splitCircle(0);
    const b = splitCircle(100);
    const connections = [[a.points[0], b.points[1]]];
    const ring = (wire: Wire, z: number) => ThinFaceMaker.make([wire], Plane.XY().translate(0, 0, z), 3);
    const sections = [ring(a.wire, 0), ring(b.wire, 100)].map(result => {
      const [outer, inner] = result.faces[0].getWires();
      return { outer, inner, ...result.walls[0], innerDistance: result.walls[0].innerDistance! };
    });
    expect(() => LoftOps.makeThinLoft(sections, { connections }))
      .toThrow(/connection 1: the point for profile 1 is not a corner of the profile — thin walls merge smooth junctions/);
  });
});

describe("loft kernel connections with guides", () => {
  setupOC();

  /** A straight rail between two points, as one wire. */
  function rail(from: Point, to: Point): Wire {
    return WireOps.makeWireFromEdges([EdgeOps.makeLineEdge(from, to)]);
  }

  /** The twisted square stack: the top turned by 45° and shifted. */
  function twisted() {
    const a = square(0);
    const b = a.map(p => new Point((p.x - p.y) / Math.SQRT2 + 10, (p.x + p.y) / Math.SQRT2, 100));
    return { a, b, wires: [polygon(a), polygon(b)] };
  }

  /** Every sample of the rail must lie on the solid's boundary. */
  function expectOnRail(solid: Solid, from: Point, to: Point): void {
    const faces = Explorer.findFacesWrapped(solid) as Face[];
    for (let i = 1; i < 8; i++) {
      const t = i / 8;
      const point = new Point(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, from.z + (to.z - from.z) * t);
      const gap = Math.min(...faces.map(face => EdgeOps.distancePointToEdge(point, face)));
      expect(gap).toBeLessThan(1e-3);
    }
  }

  it("keeps every connection while a rail rides a connected corner", () => {
    const { a, b, wires } = twisted();
    const connections = a.map((point, i) => [point, b[(i + 1) % 4]]);
    const guide = rail(a[1], b[2]);
    const [solid] = LoftOps.makeLoft(wires, { connections, guides: [guide] });
    expectConnections(solid, connections, 6);
    expectOnRail(solid, a[1], b[2]);
  });

  it("aligns a mid-edge rail between two connections without moving them", () => {
    const a = square(0);
    const b = square(100).map(p => new Point(p.x * 1.5, p.y * 0.5, 100));
    const wires = [polygon(a), polygon(b)];
    const connections = [[a[0], b[0]], [a[2], b[2]]];
    // The rail leaves the bottom edge at 1/4 of its length and arrives at
    // the top edge at 3/4: a real re-proportioning between the two pins.
    const from = new Point(-20, -40, 0);
    const to = new Point(30, -20, 100);
    const [solid] = LoftOps.makeLoft(wires, { connections, guides: [rail(from, to)] });
    expectConnections(solid, connections);
    expectOnRail(solid, from, to);
  });

  it("composes connections, a rail and an end condition", () => {
    const { a, b, wires } = twisted();
    const connections = a.map((point, i) => [point, b[i]]);
    const guide = rail(a[3], b[3]);
    const [solid] = LoftOps.makeLoft(wires, {
      connections, guides: [guide], startCondition: { kind: "normal", magnitude: 1 },
    });
    expectConnections(solid, connections, 6);
    expectOnRail(solid, a[3], b[3]);
  });

  it("names a rail that crosses a connection", () => {
    const { a, b, wires } = twisted();
    // Corner 0 is pinned to corner 0, but the rail runs from the edge after
    // corner 0 on the bottom to the edge before corner 0 on the top.
    const connections = [[a[0], b[0]], [a[2], b[2]]];
    const from = new Point(0, -40, 0);
    const to = new Point((b[3].x + b[0].x) / 2, (b[3].y + b[0].y) / 2, 100);
    expect(() => LoftOps.makeLoft(wires, { connections, guides: [rail(from, to)] }))
      .toThrow(/Loft guide 1 crosses connection 2 between profile 1 and profile 2/);
  });

  it("keeps automatically matched corners aligned around a mid-edge rail", () => {
    const a = square(0);
    const b = square(100).map(p => new Point(p.x * 1.5, p.y * 0.5, 100));
    const wires = [polygon(a), polygon(b)];
    const from = new Point(-20, -40, 0);
    const to = new Point(30, -20, 100);
    const [solid] = LoftOps.makeLoft(wires, { guides: [rail(from, to)] });
    const corners = a.map((point, i) => [point, b[i]]);
    expectConnections(solid, corners);
    expectOnRail(solid, from, to);
  });
});
