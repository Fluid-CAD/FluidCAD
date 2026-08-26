import { sketch, plane, select, wrap, cylinder, line } from 'fluidcad/core';
import { face } from 'fluidcad/filters';
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

cylinder(25, 60);
const target = select(face().cylinder());

const decal = sketch(plane("front", 25), () => {
    const sg1 = line([2, 20], [38, 20]);
    const sg2 = line([38, 20], [38, 40]);
    const sg3 = line([38, 40], [2, 40]);
    const sg4 = line([2, 40], [2, 20]);
    const sg5 = line([7, 25], [33, 25]);
    const sg6 = line([33, 25], [33, 35]);
    const sg7 = line([33, 35], [7, 35]);
    const sg8 = line([7, 35], [7, 25]);
    coincident(sg1.end(), sg2.start());
    coincident(sg2.end(), sg3.start());
    coincident(sg3.end(), sg4.start());
    coincident(sg4.end(), sg1.start());
    horizontal(sg1);
    vertical(sg2);
    horizontal(sg3);
    vertical(sg4);
    fix(sg1.start(), [2, 20]);
    distance(sg1.start(), sg1.end(), 36);
    distance(sg2.start(), sg2.end(), 20);
    coincident(sg5.end(), sg6.start());
    coincident(sg6.end(), sg7.start());
    coincident(sg7.end(), sg8.start());
    coincident(sg8.end(), sg5.start());
    horizontal(sg5);
    vertical(sg6);
    horizontal(sg7);
    vertical(sg8);
    fix(sg5.start(), [7, 25]);
    distance(sg5.start(), sg5.end(), 26);
    distance(sg6.start(), sg6.end(), 10);
  });

wrap(2, decal, target);
