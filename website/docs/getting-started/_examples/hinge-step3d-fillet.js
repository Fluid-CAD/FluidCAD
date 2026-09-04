// @screenshot view iso-ftr
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
  // Extrude dialog, Add tab, Distance 3: the leaf plate.
  const leaf = extrude(3);
  // One screw hole: a circle sketched on the plate's top face, then the
  // Extrude dialog's Remove tab (a cut) with Through all.
  sketch(leaf.endFaces(), () => {
    const hole = circle([18, 10], 4);
    diameter(hole, 4);
    fix(hole.center(), [18, 10]);
  });
  const hole = cut();
  // Repeat dialog: the same cut two more times, 20 mm apart along Y.
  repeat('linear', 'y', { count: 3, offset: 20 }, hole);
  // Fillet tool, radius 4, on the two corners away from the pin — the
  // vertical edges that lie on the plane x = 30.
  fillet(4, leaf.sideEdges(edge().onPlane('yz', 30)));
});
