// @screenshot skip
import { part, sketch, line, extrude } from "fluidcad/core";
import { coincident, horizontal, vertical, distance, fix } from "fluidcad/constraints";
import { fastener } from "./fastener.feature.js";

// A 60 × 40 × 8 cover plate with a counterbored M4 hole at its centre.
export const cover = part("Cover plate", () => {
  sketch("xy", () => {
    const b = line([-31, -21], [29, -19]);
    const r = line([29, -19], [31, 21]);
    const t = line([31, 21], [-29, 19]);
    const l = line([-29, 19], [-31, -21]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [-30, -20]);
    distance(b.start(), b.end(), 60);
    distance(r.start(), r.end(), 40);
  });
  const plate = extrude(8);

  // At the centre of the top face; 12 deep cuts right through the 8 mm plate.
  fastener(plate.endFaces().center(), { size: "m4", head: "counterbore", depth: 12 });
});
