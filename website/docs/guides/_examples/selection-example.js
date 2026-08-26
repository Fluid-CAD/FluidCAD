import { sketch, extrude, fillet, select, color } from 'fluidcad/core';
import { line } from 'fluidcad/core';
import { edge, face } from 'fluidcad/filters';
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

sketch("xy", () => {
    const sg1 = line([-40, -30], [40, -30]);
    const sg2 = line([40, -30], [40, 30]);
    const sg3 = line([40, 30], [-40, 30]);
    const sg4 = line([-40, 30], [-40, -30]);
    coincident(sg1.end(), sg2.start());
    coincident(sg2.end(), sg3.start());
    coincident(sg3.end(), sg4.start());
    coincident(sg4.end(), sg1.start());
    horizontal(sg1);
    vertical(sg2);
    horizontal(sg3);
    vertical(sg4);
    fix(sg1.start(), [-40, -30]);
    distance(sg1.start(), sg1.end(), 80);
    distance(sg2.start(), sg2.end(), 60);
  })

const e = extrude(40)

// Round only the vertical edges
select(edge().verticalTo("xy"))
fillet(8)

// Color the top face
select(face().onPlane("xy", 40))
color("steelblue")
