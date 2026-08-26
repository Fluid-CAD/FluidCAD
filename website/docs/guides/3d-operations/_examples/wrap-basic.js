import { sketch, plane, select, wrap, cylinder, line } from 'fluidcad/core';
import { face } from 'fluidcad/filters';
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

cylinder(25, 60);
const target = select(face().cylinder());

const decal = sketch(plane("front", 25), () => {
    const sg1 = line([5, 23], [35, 23]);
    const sg2 = line([35, 23], [35, 37]);
    const sg3 = line([35, 37], [5, 37]);
    const sg4 = line([5, 37], [5, 23]);
    coincident(sg1.end(), sg2.start());
    coincident(sg2.end(), sg3.start());
    coincident(sg3.end(), sg4.start());
    coincident(sg4.end(), sg1.start());
    horizontal(sg1);
    vertical(sg2);
    horizontal(sg3);
    vertical(sg4);
    fix(sg1.start(), [5, 23]);
    distance(sg1.start(), sg1.end(), 30);
    distance(sg2.start(), sg2.end(), 14);
  });

wrap(2, decal, target);
