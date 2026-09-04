import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { part, sketch, extrude, plane, mirror, rotate, fuse, select, origin, yAxis } from "../../core/index.js";
import { line, arc, circle } from "../../core/2d/index.js";
import { face } from "../../filters/index.js";
import { coincident, tangent, radius, distance, angle, horizontal, diameter } from "../../core/constraints/index.js";
import { Explorer } from "../../oc/explorer.js";
import { VertexOps } from "../../oc/vertex-ops.js";
import { Shape } from "../../common/shape.js";
import { getOC } from "../../oc/init.js";
import { testRect } from "../helpers/profiles.js";

type CircularEdge = { radius: number; center: { x: number; y: number; z: number }; closed: boolean };

function circularEdges(solid: Shape): CircularEdge[] {
  const oc = getOC();
  const result: CircularEdge[] = [];
  for (const e of Explorer.findEdgesWrapped(solid)) {
    const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(e.getShape()));
    if (curve.GetType() === oc.GeomAbs_CurveType.GeomAbs_Circle) {
      const span = curve.LastParameter() - curve.FirstParameter();
      const circ = curve.Circle();
      const loc = circ.Location();
      result.push({
        radius: circ.Radius(),
        center: { x: loc.X(), y: loc.Y(), z: loc.Z() },
        closed: Math.abs(span - 2 * Math.PI) < 1e-9,
      });
      loc.delete();
      circ.delete();
    }
    curve.delete();
  }
  return result;
}

function fuseSolids(scene: ReturnType<typeof render>): Shape[] {
  return scene.getAllSceneObjects()
    .filter(o => o.getType() === 'fuse')
    .flatMap(o => o.getAddedShapes())
    .filter(s => s.getType() === 'solid');
}

describe("fuse edge cleanup", () => {
  setupOC();

  it("junction circles of coaxial bosses with rotated seams stay full circles", () => {
    // Crank-web pattern: two identical plate+boss solids whose bosses land
    // coaxially on each other, one rotated 180° — so the two circles' closure
    // vertices sit on opposite sides. Before the cleanup, the fuse imprinted
    // both vertices onto each junction circle, leaving two 180° arcs.
    part('Part 1', () => {
      sketch('xz', () => {
        const l1 = line([35.51, 23.28], [24.01, -29.23]);
        const a1 = arc([24.01, -29.23], [-20, -30], [1.95, -26.33]).cw();
        const l2 = line([-20, -30], [-29.53, 27]);
        const a2 = arc([-29.53, 27], [35.51, 23.28], [3.05, 26.26]).cw();
        coincident(a1.start(), l1.end());
        coincident(l2.start(), a1.end());
        tangent(a1, l2);
        coincident(a2.start(), l2.end());
        coincident(a2.end(), l1.start());
        radius(a1, 36);
        radius(a2, 80);
        tangent(a1, l1);
        distance(a1.center(), origin(), 44, 'y');
        coincident(a1.center(), yAxis());
        coincident(a2.center(), yAxis());
        angle(l1.start(), l2, 33);
        horizontal(a2.end(), l2.end());
        coincident(a2.center(), origin());
      });
      const e = extrude(15);
      sketch(e.startFaces(), () => {
        const c1 = circle([0, -1], 54);
        coincident(c1.center(), yAxis());
        diameter(c1, 54);
        distance(c1.center(), origin(), 44)
      });

      const e2 = extrude(46);
      sketch(e.endFaces(), () => {
        const c2 = circle([0, 0], 0);
        coincident(c2.center(), origin());
        diameter(c2, 72);
      });

      const f = extrude(38);
      const p = plane(plane(e.startFaces()), plane(e2.endFaces()));
      const f2 = mirror(p, f);
      const p2 = plane(plane(select(face().onPlane('xz', -61))), plane(select(face().onPlane('xz', -99))));
      // No cast: `mirror(plane, shape)` must type as IMirror (with `.new()`),
      // not the 2D overload — regression for the editor's
      // "Property 'new' does not exist on type 'IMirror2D'".
      const f3 = mirror(p2, f2).new();
      const f4 = rotate('y', 180, f3);
      fuse(f4, f2);
    });

    const scene = render();
    const solids = fuseSolids(scene);
    expect(solids).toHaveLength(1);

    // The bosses overlap along y ∈ [61, 99]; the junction circles at those
    // heights must each be a single closed edge, not a pair of arcs.
    for (const junctionY of [61, 99]) {
      const junction = circularEdges(solids[0]).filter(c =>
        Math.abs(c.radius - 36) < 1e-6
        && Math.abs(c.center.x) < 1e-6
        && Math.abs(c.center.y - junctionY) < 1e-6
        && Math.abs(c.center.z) < 1e-6
      );
      expect(junction).toHaveLength(1);
      expect(junction[0].closed).toBe(true);
    }
  });

  it("keeps user-modeled colinear splits when a fuse touches elsewhere", () => {
    // Bottom side of the rectangle is deliberately two colinear segments
    // meeting at (50, 0) — a structural vertex the cleanup must not merge,
    // even though the fuse with the overlapping box creates new vertices.
    sketch('xy', () => {
      const l1 = line([0, 0], [50, 0]);
      const l2 = line([50, 0], [100, 0]);
      const l3 = line([100, 0], [100, 60]);
      const l4 = line([100, 60], [0, 60]);
      const l5 = line([0, 60], [0, 0]);
      coincident(l1.end(), l2.start());
      coincident(l2.end(), l3.start());
      coincident(l3.end(), l4.start());
      coincident(l4.end(), l5.start());
      coincident(l5.end(), l1.start());
    });
    const a = extrude(10).new();

    sketch('xy', () => {
      testRect(40, 40, { at: [90, 50] });
    });
    const b = extrude(10).new();

    fuse(a, b);

    const scene = render();
    const solids = fuseSolids(scene);
    expect(solids).toHaveLength(1);

    const splitVertices = Explorer.findVerticesWrapped(solids[0]).filter(v => {
      const pt = VertexOps.toPoint(v);
      return Math.abs(pt.x - 50) < 1e-6 && Math.abs(pt.y) < 1e-6;
    });
    expect(splitVertices.length).toBeGreaterThanOrEqual(2);
  });
});
