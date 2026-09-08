// @screenshot waitForInput
import { arc, circle, cut, extrude, line, mirror, origin, sketch, xAxis, yAxis } from "fluidcad/core";
import { coincident, concentric, diameter, distance, horizontal, midpoint, radius,
    symmetric, tangent, vertical } from "fluidcad/constraints";

sketch('xy', () => {
  const outer = circle([0, 0], 70);
  const bore = circle([0, 0], 42);
  const hole = circle([50, 0], 10);
  const upper = line([15, 30], [55, 15]);
  const lower = line([15, -30], [55, -15]);
  const cap = arc([55, -15], [55, 15], [42, 0]);
  coincident(outer.center(), origin());
  diameter(outer, 70);
  coincident(bore.center(), origin());
  diameter(bore, 42);
  coincident(hole.center(), xAxis());
  diameter(hole, 10);
  distance(hole.center(), yAxis(), 50);
  coincident(cap.start(), lower.end());
  coincident(cap.end(), upper.end());
  tangent(upper, outer);
  coincident(upper.start(), outer);
  concentric(cap, hole);
  radius(cap, 16);
  tangent(upper, cap);
  symmetric(upper.start(), lower.start(), xAxis());
  tangent(lower, cap);
  mirror(yAxis(), upper, cap, lower, hole);
});
