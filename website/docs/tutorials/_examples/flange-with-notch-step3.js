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

const flange = extrude(12);

sketch(flange.endFaces(), () => {
  const wall = circle([0, 0], 70);
  const inner = circle([0, 0], 42);
  coincident(wall.center(), origin());
  diameter(wall, 70);
  coincident(inner.center(), origin());
  diameter(inner, 42);
});

const pipe = extrude(34);

sketch(pipe.endFaces(), () => {
  const bottom = line([-15, -35], [15, -35]);
  const right = line([15, -35], [15, 35]);
  const top = line([15, 35], [-15, 35]);
  const left = line([-15, 35], [-15, -35]);
  coincident(bottom.end(), right.start());
  coincident(right.end(), top.start());
  coincident(top.end(), left.start());
  coincident(left.end(), bottom.start());
  horizontal(bottom);
  horizontal(top);
  vertical(right);
  vertical(left);
  distance(bottom.start(), bottom.end(), 30);
  distance(right.start(), right.end(), 70);
  midpoint(origin(), bottom.start(), top.start());
});

cut(8);
