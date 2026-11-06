// @screenshot skip
import { part, sketch, line, circle, extrude, fillet, repeat } from "fluidcad/core";
import { coincident, horizontal, vertical, distance, diameter, fix } from "fluidcad/constraints";
import { standoff } from "./standoff.feature.js";

// An 80 × 50 × 3 PCB mounting plate with a standoff on a pad at each corner.
export const pcbPlate = part("PCB plate", () => {
  sketch("xy", () => {
    const b = line([-41, -26], [39, -24]);
    const r = line([39, -24], [41, 26]);
    const t = line([41, 26], [-39, 24]);
    const l = line([-39, 24], [-41, -26]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [-40, -25]);
    distance(b.start(), b.end(), 80);
    distance(r.start(), r.end(), 50);
  });
  extrude(3);

  // The front-left pad, 6 mm in from both edges, 1 mm proud of the plate.
  sketch("xy", () => {
    const p = circle([-34, -19], 9);
    fix(p.center(), [-34, -19]);
    diameter(p, 10);
  });
  const pad = extrude(4);

  // An M3 standoff, its height the feature's default (10).
  const post = standoff(pad.endFaces(), { outer: 6, hole: 3.2 });
  const rim = fillet(0.5, post.endEdges());

  // The other three corners: the pad, its standoff and the rounded rim.
  repeat("linear", ["x", "y"], { count: [2, 2], offset: [68, 38] }, pad, post, rim);
});
