// @screenshot skip
import { part, sketch, line, extrude, chamfer } from "fluidcad/core";
import { coincident, horizontal, vertical, distance, fix } from "fluidcad/constraints";
import { ventGrid } from "./vent-grid.feature.js";

// A 120 × 80 × 3 enclosure lid with a staggered vent grid in the middle.
export const lid = part("Lid", () => {
  sketch("xy", () => {
    const b = line([-61, -41], [59, -39]);
    const r = line([59, -39], [61, 41]);
    const t = line([61, 41], [-59, 39]);
    const l = line([-59, 39], [-61, -41]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [-60, -40]);
    distance(b.start(), b.end(), 120);
    distance(r.start(), r.end(), 80);
  });
  const panel = extrude(3);

  // 5 rows of 9 holes, every other row shifted half a pitch.
  const grid = ventGrid(panel.endFaces(), { pattern: "staggered", rows: 5, columns: 9, pitch: 9 });
  // The rims the holes left on the top face: the feature's start edges.
  chamfer(0.5, grid.startEdges());
});
