import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import plane from "../../core/plane.js";
import loft from "../../core/loft.js";
import fillet from "../../core/fillet.js";
import { edge } from "../../filters/index.js";
import { Loft } from "../../features/loft.js";
import { EdgeProps } from "../../oc/edge-props.js";
import { EdgeQuery } from "../../oc/edge-query.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { Explorer } from "../../oc/explorer.js";
import { synthesizeApplyFeature } from "../../selection/explain.js";
import { testRect } from "../helpers/profiles.js";
import { edgeRefsWhere, findSolid, setLocation } from "./pick-helpers.js";

// A twisted, thin-walled loft with both corner families filleted. The rim of
// the top face is made of B-spline edges: the trimmed section lines (degree
// 1) and the fillet traces (degree 6), which are circular arcs the kernel
// never stores as circles. The probe must classify them the way the
// line()/arc() predicates do, or the synthesizer never proposes the atom
// that separates them.
function twistedVase() {
  const s = sketch("xy", () => testRect(50, 50, { at: [-25, -25] }));
  const s2 = sketch(plane("xy", { offset: 80 }), () => testRect(30, 30, { at: [-15, -15] }));
  const lf = loft(s, s2).connect(s.geometries.b.end(), s2.geometries.b.start())
    .startCondition("normal").endCondition("normal").thin(-4) as Loft;
  setLocation(lf, 45);
  const outer = fillet(6, lf.sideEdges(edge().convex()));
  setLocation(outer, 46);
  const inner = fillet(4, lf.sideEdges(edge().concave()));
  setLocation(inner, 47);
  return render();
}

const onTop = (m: { z: number }) => Math.abs(m.z - 80) < 1e-6;
const outerRing = (m: { x: number; y: number; z: number }) => onTop(m) && Math.max(Math.abs(m.x), Math.abs(m.y)) > 12.5;
const cornerArc = (m: { x: number; y: number; z: number }) => onTop(m) && Math.abs(Math.abs(m.x) - Math.abs(m.y)) < 1e-3;

describe("B-spline rim edges probe by the geometry they stand for", () => {
  setupOC();

  it("classifies fillet traces as arcs with their radius and section lines as lines", () => {
    const scene = twistedVase();
    const solid = findSolid(scene);
    const tally = { arc6: 0, arc4: 0, line: 0, other: 0 };
    for (const e of Explorer.findEdgesWrapped(solid)) {
      const mid = EdgeOps.getEdgeMidPoint(e);
      if (!onTop(mid)) {
        continue;
      }
      const props = EdgeProps.getProperties(e.getShape());
      if (props.curveType === "line") {
        tally.line++;
      } else if (props.curveType === "arc" && Math.abs(props.radius! - 6) < 1e-6) {
        tally.arc6++;
      } else if (props.curveType === "arc" && Math.abs(props.radius! - 4) < 1e-6) {
        tally.arc4++;
      } else {
        tally.other++;
      }
    }
    expect(tally).toEqual({ arc6: 4, arc4: 4, line: 8, other: 0 });
  });

  it("reads the recovered circle's center off a B-spline arc", () => {
    const scene = twistedVase();
    const solid = findSolid(scene);
    const arcs = Explorer.findEdgesWrapped(solid).filter(e => {
      const mid = EdgeOps.getEdgeMidPoint(e);
      return cornerArc(mid) && outerRing(mid);
    });
    expect(arcs).toHaveLength(4);
    for (const arc of arcs) {
      const data = EdgeQuery.getCircleDataFromEdge(arc);
      expect(data.radius).toBeCloseTo(6, 6);
      // A 6 mm fillet on a 30×30 profile centers 9 mm from the axis.
      expect(Math.abs(data.center.x)).toBeCloseTo(9, 4);
      expect(Math.abs(data.center.y)).toBeCloseTo(9, 4);
      expect(data.center.z).toBeCloseTo(80, 6);
      expect(Math.abs(data.axisDirection.z)).toBeCloseTo(1, 6);
    }
  });

  it("synthesizes the four outer fillet arcs of the rim with a positive class atom", () => {
    const scene = twistedVase();
    const solid = findSolid(scene);
    const refs = edgeRefsWhere(solid, m => cornerArc(m) && outerRing(m));
    expect(refs).toHaveLength(4);
    const result = synthesizeApplyFeature(scene, refs, "chamfer", 1);
    expect(result.ok, result.ok === false ? result.reason : "").toBe(true);
    if (result.ok) {
      // The loop isolates more than the plane (the inner rim's arcs share
      // it), so it opens; `.arc()` closes without a rank predicate.
      expect(result.preview).toBe("chamfer(1, select(edge().outerOf(lf.endFaces()).arc()))");
    }
  });
});
