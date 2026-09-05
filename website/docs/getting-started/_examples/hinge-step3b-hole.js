// @screenshot view iso-ftr
import { origin, xAxis, yAxis, part, sketch, line, circle, extrude, cut, repeat, fillet, connector } from 'fluidcad/core';
import { coincident, horizontal, vertical, midpoint, distance, diameter, fix } from 'fluidcad/constraints';
import { edge } from 'fluidcad/filters';

// The part container: everything inside the callback belongs to the
// "Fixed leaf". Exporting it is what lets an assembly insert() it later.
export const fixedLeaf = part('Fixed leaf', () => {
  // Leaf outline, drawn with the Rectangle tool on the XY plane: 30 mm wide,
  // 60 mm along the pin axis (Y). The four lines are guesses; the constraints
  // below are what the tool wrote to pin the rectangle down.
  sketch('xy', () => {
    const b = line([0, -28.96], [30, -28.96]);
    const r = line([30, -28.96], [30, 31.04]);
    const t = line([30, 31.04], [0, 31.04]);
    const l = line([0, 31.04], [0, -28.96]);
    // corners: each line ends where the next one starts
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    // square it up
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    // the two dimensions (double-click a label in the viewport to change them)
    distance(b.start(), b.end(), 30);
    distance(r.start(), r.end(), 60);
    // centre the left edge on the origin: the pin axis runs through the
    // middle of the leaf, and the outline cannot slide
    midpoint(origin(), t.end(), b.start());
  });
  // Extrude dialog, Add tab, Distance 3: the leaf plate.
  const leaf = extrude(3);
  // One screw hole: a circle sketched on the plate's top face, then the
  // Extrude dialog's Remove tab (a cut) with Through all. The circle is a
  // guess; the two dimensions to the sketch axes place it 20 mm from the
  // pin edge and 10 mm from the end of the plate.
  sketch(leaf.endFaces(), () => {
    const hole = circle([22.92, -25.08], 4);
    diameter(hole, 4);
    distance(hole.center(), xAxis(), 20);
    distance(hole.center(), yAxis(), 20);
  });
  const hole = cut();
});
