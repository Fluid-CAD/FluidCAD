// @screenshot showAxes
import { extrude, mirror, sketch } from 'fluidcad/core';
import { line } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

sketch("xy", () => {
    const sg1 = line([10, 0], [60, 0]);
    const sg2 = line([60, 0], [60, 30]);
    const sg3 = line([60, 30], [10, 30]);
    const sg4 = line([10, 30], [10, 0]);
    coincident(sg1.end(), sg2.start());
    coincident(sg2.end(), sg3.start());
    coincident(sg3.end(), sg4.start());
    coincident(sg4.end(), sg1.start());
    horizontal(sg1);
    vertical(sg2);
    horizontal(sg3);
    vertical(sg4);
    fix(sg1.start(), [10, 0]);
    distance(sg1.start(), sg1.end(), 50);
    distance(sg2.start(), sg2.end(), 30);
  })

extrude(20)

mirror("yz")
