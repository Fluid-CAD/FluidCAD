// @screenshot skip
import { part, sketch, line, circle, extrude, fillet, chamfer } from "fluidcad/core";
import { coincident, horizontal, vertical, distance, diameter, fix } from "fluidcad/constraints";
import { gear } from "./gear.feature.js";

// A gear pair on a 120 × 70 × 6 base plate: an 18-tooth pinion and a 31-tooth
// wheel, module 2, on round seats 50 mm apart (the sum of their pitch radii,
// 49, and 1 mm of backlash).
export const gearPair = part("Gear pair", () => {
  sketch("xy", () => {
    const b = line([-61, -36], [59, -34]);
    const r = line([59, -34], [61, 36]);
    const t = line([61, 36], [-59, 34]);
    const l = line([-59, 34], [-61, -36]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [-60, -35]);
    distance(b.start(), b.end(), 120);
    distance(r.start(), r.end(), 70);
  });
  extrude(6);

  // The two seats, 2 mm proud of the plate.
  sketch("xy", () => {
    const s = circle([-25, 0], 9);
    fix(s.center(), [-25, 0]);
    diameter(s, 20);
  });
  const pinionSeat = extrude(8);
  sketch("xy", () => {
    const s = circle([25, 0], 14);
    fix(s.center(), [25, 0]);
    diameter(s, 30);
  });
  const wheelSeat = extrude(8);

  // Each gear a body of its own on its seat (the New tab of the Gear dialog).
  const pinion = gear(pinionSeat.endFaces(), { teeth: 18 }).new();
  // Every tooth tip of the pinion: the gear's own Tip Edges, picked from the
  // right-click menu. A name the gear declares, read like endEdges().
  // highlight-next-line
  fillet(0.3, pinion.tipEdges());
  const wheel = gear(wheelSeat.endFaces(), { teeth: 31 }).new();
  // highlight-next-line
  fillet(0.3, wheel.tipEdges());
  // The top and bottom rims of the wheel's bore: the gear's Bore Rims.
  chamfer(0.5, wheel.boreEdges());
});
