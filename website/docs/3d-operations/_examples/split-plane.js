// @screenshot showAxes
import { sketch, line, extrude, split, translate, xAxis, yAxis } from "fluidcad/core";
import { coincident, distance, horizontal, symmetric, vertical } from "fluidcad/constraints";

// An 80 × 60 × 20 block centred on the origin.
sketch("xy", () => {
  const b = line([-40, -30], [40, -30]);
  const r = line([40, -30], [40, 30]);
  const t = line([40, 30], [-40, 30]);
  const l = line([-40, 30], [-40, -30]);
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(t);
  vertical(l);
  symmetric(b.start(), b.end(), yAxis());
  symmetric(r.start(), r.end(), xAxis());
  distance(b.start(), b.end(), 80);
  distance(r.start(), r.end(), 60);
});
const block = extrude(20);

// Part the block at the YZ plane, 10 towards +x: two bodies, 50 and 30 wide.
const halves = split("yz", { offset: 10 }, block);

// Both pieces are the split's shapes — move them apart to see the cut.
translate([15, 0, 0], halves);
