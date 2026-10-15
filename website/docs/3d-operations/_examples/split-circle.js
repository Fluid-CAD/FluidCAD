import { sketch, line, circle, extrude, split, xAxis, yAxis } from "fluidcad/core";
import { coincident, distance, horizontal, symmetric, vertical, fix } from "fluidcad/constraints";

// A 60 × 40 × 15 plate.
sketch("xy", () => {
  const b = line([-30, -20], [30, -20]);
  const r = line([30, -20], [30, 20]);
  const t = line([30, 20], [-30, 20]);
  const l = line([-30, 20], [-30, -20]);
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(b);
  vertical(r);
  horizontal(t);
  vertical(l);
  symmetric(b.start(), b.end(), yAxis());
  symmetric(r.start(), r.end(), xAxis());
  distance(b.start(), b.end(), 60);
  distance(r.start(), r.end(), 40);
});
const plate = extrude(15);

// A construction circle on the XY plane, 20 across, at the plate's centre.
// Return it so the split below can reference it outside the sketch.
const s = sketch("xy", () => {
  const ring = circle([0, 0], 20).guide();
  fix(ring.center(), [0, 0]);
  return { ring };
});
// The circle sweeps a cylinder out of its sketch. A circle is drawn
// counter-clockwise, so Front is its outside: keep the plate, drop the core.
// highlight-next-line
split(s.geometries.ring, { keep: "front" }, plate);
