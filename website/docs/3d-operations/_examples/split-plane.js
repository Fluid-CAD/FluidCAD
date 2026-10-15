// @screenshot showAxes hideGrid view iso-ftr size 1200x800 noAutoCrop
import { sketch, line, extrude, split } from "fluidcad/core";
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

const width = 80;
const depth = 60;
const height = 20;
const cutOffset = 10;

// Draw a centred rectangle. Constraints join its corners, square its
// sides, and fix its position and size.
sketch("xy", () => {
  const b = line([-width / 2, -depth / 2], [width / 2, -depth / 2]);
  const r = line([width / 2, -depth / 2], [width / 2, depth / 2]);
  const t = line([width / 2, depth / 2], [-width / 2, depth / 2]);
  const l = line([-width / 2, depth / 2], [-width / 2, -depth / 2]);
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(b);
  vertical(r);
  horizontal(t);
  vertical(l);
  fix(b.start(), [-width / 2, -depth / 2]);
  distance(b.start(), b.end(), width);
  distance(r.start(), r.end(), depth);
});
const block = extrude(height);

// Cut at x = 10: the YZ plane's normal points along +X.
// The default is to keep both pieces. They remain in their original
// positions, touching at the cut; Split does not move them apart.
// highlight-next-line
const pieces = split("yz", { offset: cutOffset }, block);
