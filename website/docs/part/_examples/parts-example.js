import { part, sketch, extrude } from 'fluidcad/core';
import { circle, line } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

// Two parts in one file. Each part() is an isolation boundary: the pillar
// stands on the base but never fuses with it, so the scene keeps two solids.
part("base", () => {
    sketch("xy", () => {
        const sg1 = line([-60, -40], [60, -40]);
        const sg2 = line([60, -40], [60, 40]);
        const sg3 = line([60, 40], [-60, 40]);
        const sg4 = line([-60, 40], [-60, -40]);
        coincident(sg1.end(), sg2.start());
        coincident(sg2.end(), sg3.start());
        coincident(sg3.end(), sg4.start());
        coincident(sg4.end(), sg1.start());
        horizontal(sg1);
        vertical(sg2);
        horizontal(sg3);
        vertical(sg4);
        fix(sg1.start(), [-60, -40]);
        distance(sg1.start(), sg1.end(), 120);
        distance(sg2.start(), sg2.end(), 80);
      })
    extrude(10)
})

// A second boundary — inside it, the cylinder would fuse with anything else
// drawn in THIS part, and with nothing outside it.
part("pillar", () => {
    sketch("xy", () => {
        circle([0, 0], 30);
      })
    extrude(60)
})
