// @screenshot waitForInput
import { select, sketch, plane, extrude } from 'fluidcad/core';
import { face } from 'fluidcad/filters';
import { circle, line } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

sketch(plane("xy"), () => {
    const sg1 = line([100, 250], [150, 250]);
    const sg2 = line([150, 250], [150, 300]);
    const sg3 = line([150, 300], [100, 300]);
    const sg4 = line([100, 300], [100, 250]);
    coincident(sg1.end(), sg2.start());
    coincident(sg2.end(), sg3.start());
    coincident(sg3.end(), sg4.start());
    coincident(sg4.end(), sg1.start());
    horizontal(sg1);
    vertical(sg2);
    horizontal(sg3);
    vertical(sg4);
    fix(sg1.start(), [100, 250]);
    distance(sg1.start(), sg1.end(), 50);
    distance(sg2.start(), sg2.end(), 50);
  })

extrude(100);

// highlight-next-line
const targetFace = select(face().onPlane("-xz", 250))

sketch(plane("front"), () => {
    circle([0, 0], 60);
  })

// highlight-next-line
extrude(targetFace);
