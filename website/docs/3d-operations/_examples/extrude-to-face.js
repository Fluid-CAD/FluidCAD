// @screenshot view iso-ftr
import { select, sketch, extrude, circle, line } from 'fluidcad/core';
import { face } from 'fluidcad/filters';
import { coincident, diameter, distance, fix, horizontal, vertical } from "fluidcad/constraints";

// A wall standing 100 mm in front of the origin. Its near side is the face
// the boss below has to reach.
sketch("xy", () => {
    const sg1 = line([-70, -120], [70, -120]);
    const sg2 = line([70, -120], [70, -100]);
    const sg3 = line([70, -100], [-70, -100]);
    const sg4 = line([-70, -100], [-70, -120]);
    coincident(sg1.end(), sg2.start());
    coincident(sg2.end(), sg3.start());
    coincident(sg3.end(), sg4.start());
    coincident(sg4.end(), sg1.start());
    horizontal(sg1);
    vertical(sg2);
    horizontal(sg3);
    vertical(sg4);
    fix(sg1.start(), [-70, -120]);
    distance(sg1.start(), sg1.end(), 140);
    distance(sg2.start(), sg2.end(), 20);
  })
extrude(110)

// The face to stop at — the wall side that looks back at the origin.
// highlight-next-line
const targetFace = select(face().onPlane("xz", 100))

// The boss profile, on the front plane. That plane's normal points along −Y,
// straight at the wall, so the extrusion travels toward it.
sketch("front", () => {
    const c = circle([0, 55], 40);
    fix(c.center(), [0, 55]);
    diameter(c, 40);
  })

// highlight-next-line
extrude(targetFace);
