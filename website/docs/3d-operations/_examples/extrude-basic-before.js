// @screenshot view top
import { sketch, line } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

// The starting point of every extrude: a closed, fully constrained profile.
// This one is a 100 x 60 rectangle on the top plane.
sketch("xy", () => {
    const sg1 = line([-50, -30], [50, -30]);
    const sg2 = line([50, -30], [50, 30]);
    const sg3 = line([50, 30], [-50, 30]);
    const sg4 = line([-50, 30], [-50, -30]);
    coincident(sg1.end(), sg2.start());
    coincident(sg2.end(), sg3.start());
    coincident(sg3.end(), sg4.start());
    coincident(sg4.end(), sg1.start());
    horizontal(sg1);
    vertical(sg2);
    horizontal(sg3);
    vertical(sg4);
    fix(sg1.start(), [-50, -30]);
    distance(sg1.start(), sg1.end(), 100);
    distance(sg2.start(), sg2.end(), 60);
  })
