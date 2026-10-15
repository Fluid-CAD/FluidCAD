// @screenshot showAxes hideGrid view iso-ftr size 1200x800 noAutoCrop
import { sketch, line, extrude, split, xAxis, yAxis } from "fluidcad/core";
import { coincident, distance, horizontal, symmetric, vertical, fix } from "fluidcad/constraints";

// A 60 × 40 × 15 block.
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
const block = extrude(15);

// Draw a diagonal construction line on the XY plane and fix its ends.
// Return the line so the split below can reference it outside the sketch.
const s = sketch("xy", () => {
  const seed = line([-40, -25], [40, 25]).guide();
  fix(seed.start(), [-40, -25]);
  fix(seed.end(), [40, 25]);
  return { seed };
});
// The cut plane contains the line and is perpendicular to the sketch.
// Keep the side its normal points toward; discard the other piece.
// highlight-next-line
split(s.geometries.seed, { keep: "front" }, block);
