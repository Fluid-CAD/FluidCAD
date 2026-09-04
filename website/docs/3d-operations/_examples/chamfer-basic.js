import { sketch, extrude, chamfer } from 'fluidcad/core';
import { line } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

sketch("xy", () => {
    // Four lines drawn at their intended positions — the coordinates are
    // guesses the constraints below turn into an exact 100 x 60 rectangle.
    const sg1 = line([-50, -30], [50, -30]);
    const sg2 = line([50, -30], [50, 30]);
    const sg3 = line([50, 30], [-50, 30]);
    const sg4 = line([-50, 30], [-50, -30]);
    // Coincident joins the corners into a closed loop
    coincident(sg1.end(), sg2.start());
    coincident(sg2.end(), sg3.start());
    coincident(sg3.end(), sg4.start());
    coincident(sg4.end(), sg1.start());
    // Horizontal / vertical square the sides up
    horizontal(sg1);
    vertical(sg2);
    horizontal(sg3);
    vertical(sg4);
    // Fix pins one corner so the profile cannot slide; the two distances
    // set the width and height. The sketch is now fully constrained.
    fix(sg1.start(), [-50, -30]);
    distance(sg1.start(), sg1.end(), 100);
    distance(sg2.start(), sg2.end(), 60);
  })

// The plate to bevel.
const e = extrude(30)
// A 3 x 3 chamfer on the four top edges.
chamfer(3, e.endEdges())
