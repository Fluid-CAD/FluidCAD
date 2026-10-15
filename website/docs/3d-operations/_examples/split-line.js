// @screenshot showAxes
import { sketch, line, extrude, split } from "fluidcad/core";
import { coincident, distance, horizontal, symmetric, vertical, fix } from "fluidcad/constraints";
import { xAxis, yAxis } from "fluidcad/core";

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
  horizontal(t);
  vertical(l);
  symmetric(b.start(), b.end(), yAxis());
  symmetric(r.start(), r.end(), xAxis());
  distance(b.start(), b.end(), 60);
  distance(r.start(), r.end(), 40);
});
const block = extrude(15);

// A diagonal construction line sketched on the XY plane. The split cuts
// along the plane this line sweeps out of its sketch — a vertical sheet
// through the block — and keeps the side the plane normal points to.
const s = sketch("xy", () => {
  const seed = line([-40, -25], [40, 25]).guide();
  fix(seed.start(), [-40, -25]);
  fix(seed.end(), [40, 25]);
  return { seed };
});
split(s.geometries.seed, { keep: "front" }, block);
