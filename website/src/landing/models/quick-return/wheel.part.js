import { part, sketch, extrude, cut, plane, repeat, color, connector, fillet, arc } from "fluidcad/core";
import { fix, radius, distance } from "fluidcad/constraints";
import { disk } from "./profiles.js";
import { D } from "./dimensions.js";

// Local origin is the rear pivot bearing seat, axis +Z.
export const wheel = part("Arc-slot crank wheel", () => {
  sketch("xy", () => {
    disk(0, 0, D.crankDiameter);
    disk(0, 0, D.pivotClearance);
    disk(D.crankRadius, 0, D.jointClearance);
  });
  extrude(D.crankThickness);
  // Four rounded annular slots leave continuous radial webs and a solid hub.
  sketch("xy", () => {
    const polar = (r, degrees) => [r * Math.cos(degrees * Math.PI / 180), r * Math.sin(degrees * Math.PI / 180)];
    const inner = 29, outer = 47, mid = 38;
    const start = 25, end = 65;
    const constrainedArc = (p, q, center, r, clockwise = false) => {
      const a = arc(p, q, center);
      if (clockwise) a.cw();
      fix(a.center(), center);
      radius(a, r);
      distance(a.center(), a.start(), Math.abs(p[0] - center[0]), "x");
      distance(a.center(), a.end(), Math.abs(q[0] - center[0]), "x");
      return a;
    };
    constrainedArc(polar(outer, start), polar(outer, end), [0, 0], outer);
    constrainedArc(polar(outer, end), polar(inner, end), polar(mid, end), 9);
    constrainedArc(polar(inner, end), polar(inner, start), [0, 0], inner, true);
    constrainedArc(polar(inner, start), polar(outer, start), polar(mid, start), 9);
  });
  const window = cut(-D.crankThickness);
  repeat("circular", "z", { count: 4, angle: 360 }, window).name("Four curved slots");
  sketch(plane("xy", D.crankThickness), () => {
    disk(0, 0, D.crankDiameter);
    disk(0, 0, D.crankDiameter - 10);
  });
  const rim = extrude(1).name("Raised wheel rim");
  fillet(D.edgeBreak, rim.sideEdges()).name("Wheel rim edge breaks");
  color(D.wheelColor);
  connector("axis", plane("xy"));
  connector("pin", plane("xy", D.crankThickness)).offset(D.crankRadius, 0);
});
