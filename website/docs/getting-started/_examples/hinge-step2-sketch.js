// @screenshot view top
import { part, sketch, line, circle, extrude, cut, repeat, fillet, connector } from 'fluidcad/core';
import { coincident, horizontal, vertical, distance, diameter, fix, concentric } from 'fluidcad/constraints';
import { edge } from 'fluidcad/filters';

// The part container: everything inside the callback belongs to the
// "Fixed leaf". Exporting it is what lets an assembly insert() it later.
export const fixedLeaf = part('Fixed leaf', () => {
  // Leaf outline, drawn with the Rectangle tool on the XY plane: 30 mm wide,
  // 60 mm along the pin axis (Y). The four lines are guesses; the constraints
  // below are what the tool wrote to pin the rectangle down.
  sketch('xy', () => {
    const b = line([0, 0], [30, 0]);
    const r = line([30, 0], [30, 60]);
    const t = line([30, 60], [0, 60]);
    const l = line([0, 60], [0, 0]);
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
    // anchor one corner on the origin so the outline cannot slide
    fix(b.start(), [0, 0]);
    // the two dimensions (double-click a label in the viewport to change them)
    distance(b.start(), b.end(), 30);
    distance(r.start(), r.end(), 60);
  });
});
