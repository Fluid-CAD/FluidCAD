import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { part, sketch, extrude, cut, fillet, origin, yAxis, xAxis } from "../../core/index.js";
import { line, arc, circle, project } from "../../core/2d/index.js";
import { coincident, tangent, radius, distance, angle, horizontal, diameter, equal, symmetric, fix } from "../../core/constraints/index.js";
import { face } from "../../filters/index.js";
import { Explorer } from "../../oc/explorer.js";
import { getOC } from "../../oc/init.js";

function buildRod(stage: number) {
  part('Part 1', () => {
    sketch('xz', () => {
      const a1 = arc([100.86, 0], [-100.17, 11.75], [0, 0]);
      const a2 = arc([74.97, 0], [-74.26, 10.27], [0, 0]);
      const l1 = line([25.5, -7.81], [34.53, -7.81]);
      const l2 = line([-36.92, -6.75], [-28.51, -6.75]);
      const c1 = circle([0, 201.86], 45);
      const c2 = circle([0, 201.86], 33.8);
      coincident(a1.center(), origin());
      coincident(a1.start(), xAxis());
      coincident(xAxis(), a1.end());
      coincident(a2.center(), origin());
      coincident(a2.start(), xAxis());
      coincident(xAxis(), a2.end());
      radius(a1, 36);
      radius(a2, 27);
      horizontal(l1);
      horizontal(l2);
      coincident(l2.end(), a2.end());
      coincident(l2.start(), a1.end());
      coincident(l1.start(), a2.start());
      coincident(a1.start(), l1.end());
      coincident(c1.center(), yAxis());
      diameter(c1, 45);
      coincident(c2.center(), c1.center());
      diameter(c2, 33.8);
      distance(c1.center(), a1.center(), 201.2);
    });
    const e = extrude(38).symmetric();
    sketch('xz', () => {
      const prj1 = (project(e.startEdges(3, 4)) as any).guide();
      const l4 = line([-20, 170], [-53.86, 60.15]);
      const l3 = line([14.69, 159.89], [56.61, 49.09]);
      const a3 = arc([-17.85, 31.26], [17.85, 31.26], [0, 0]).cw();
      const a4 = arc([-10, 181.04], [10, 181.04], [0, 174.57]);
      horizontal(l3.start(), l4.start());
      distance(l3.start(), l4.start(), 20);
      coincident(l4.start(), prj1.ref(1));
      coincident(l3.start(), prj1.ref(1));
      coincident(l4.end(), prj1.ref(0));
      coincident(l3.end(), prj1.ref(0));
      angle(l4, l3, 6);
      horizontal(l3.end(), l4.end());
      coincident(a3.start(), l4.end());
      coincident(a3.end(), l3.end());
      fix(a3.center());
      coincident(a4.start(), l4.start());
      coincident(a4.end(), l3.start());
      coincident(prj1.ref(1).center(), a4.center());
    });
    const e2 = extrude(18).symmetric();
    if (stage < 2) { return; }
    fillet(40, e2.sideEdges(9, 10));
    if (stage < 3) { return; }
    fillet(22.5, e2.sideEdges(8, 11));
    if (stage < 4) { return; }
    sketch(e.sideFaces(0), () => {
      const l5 = line([-57.56, -9], [18.44, -9]);
      const a5 = arc([18.44, -9], [18.44, 9], [18.44, 0]);
      const l6 = line([18.44, 9], [-57.56, 9]);
      const a6 = arc([-57.56, 9], [-57.56, -9], [-57.56, 0]);
      coincident(l5.end(), a5.start());
      coincident(a5.end(), l6.start());
      coincident(l6.end(), a6.start());
      coincident(a6.end(), l5.start());
      tangent(l5, a5);
      tangent(a5, l6);
      tangent(l6, a6);
      tangent(a6, l5);
      equal(a5, a6);
      distance(a6.center(), a5.center(), 76);
      radius(a5, 9);
      symmetric(a5.center(), a6.center(), yAxis());
    });
    const e3 = extrude(-30);
    if (stage < 5) { return; }
    sketch(e3.sideFaces(4), () => {
      project(e3.sideFaces(face().above('xz').edgeCount(2)));
    });
    cut();
    if (stage < 6) { return; }
    sketch(e3.endFaces(1), () => {
      const c3 = circle([-64.87, 0], 22.25);
      const c4 = circle([82.38, 0], 25.14);
      coincident(c3.center(), xAxis());
      equal(c4, c3);
      diameter(c4, 9);
      distance(c4.center(), c3.center(), 76);
      symmetric(c4.center(), c3.center(), yAxis());
    });
    cut();
  });
}

function saddleArcSpans(): number[] {
  const oc = getOC();
  const scene = render();
  const lastSolid = scene.getAllSceneObjects().flatMap(o => o.getShapes({}, 'solid')).pop();
  const spans: number[] = [];
  for (const e of Explorer.findEdgesWrapped(lastSolid)) {
    const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(e.getShape()));
    if (curve.GetType() === oc.GeomAbs_CurveType.GeomAbs_Circle) {
      const circ = curve.Circle();
      const loc = circ.Location();
      if (Math.abs(circ.Radius() - 36) < 1e-6 && Math.abs(loc.Y() - 9) < 1e-6) {
        spans.push((curve.LastParameter() - curve.FirstParameter()) * 180 / Math.PI);
      }
      loc.delete();
      circ.delete();
    }
    curve.delete();
  }
  return spans.sort((a, b) => a - b);
}

describe("scene fusion edge cleanup", () => {
  setupOC();

  // Connecting-rod pattern: the tower's saddle contact arc on the arch's r36
  // cylinder used to accumulate splits across features — the fillet feet
  // introduce legitimate boundaries, and once a later fuse/cut cleanup merges
  // the coplanar flank/boss faces into one, those vertices become redundant
  // residue (same face pair on both sides of every piece). The unifyEdges
  // cleanup in the scene-fusion paths must collapse them.
  it("keeps legitimate fillet-foot boundaries before the faces merge", () => {
    buildRod(3);
    const spans = saddleArcSpans();
    expect(spans).toHaveLength(3);
  });

  it("collapses the saddle contact to one arc once its faces are unified", () => {
    buildRod(6);
    const spans = saddleArcSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toBeCloseTo(180, 1);
  });
});
