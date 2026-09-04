// @screenshot view iso-ftr
import { sketch, extrude, shell, rib, fillet, line } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

// The housing: a 100 x 50 rectangle, extruded 30, shelled from the top and
// rounded inside — the cavity the rib will fit.
sketch("top", () => {
    const sg1 = line([-50, -25], [50, -25]);
    const sg2 = line([50, -25], [50, 25]);
    const sg3 = line([50, 25], [-50, 25]);
    const sg4 = line([-50, 25], [-50, -25]);
    coincident(sg1.end(), sg2.start());
    coincident(sg2.end(), sg3.start());
    coincident(sg3.end(), sg4.start());
    coincident(sg4.end(), sg1.start());
    horizontal(sg1);
    vertical(sg2);
    horizontal(sg3);
    vertical(sg4);
    fix(sg1.start(), [-50, -25]);
    distance(sg1.start(), sg1.end(), 100);
    distance(sg2.start(), sg2.end(), 50);
  })

const box = extrude(30)
const s = shell(-4, box.endFaces())
fillet(2, s.internalEdges())

// The spine: one open line on the top face, from the wall inward.
sketch(box.endFaces(), () => {
    const sg5 = line([-46, 0], [-16, 0]);
    horizontal(sg5);
  });

// A 5-thick wall centred on the spine, grown down into the cavity until
// it meets the floor and the side walls, with a 2° draft.
rib(5).draft(2);
