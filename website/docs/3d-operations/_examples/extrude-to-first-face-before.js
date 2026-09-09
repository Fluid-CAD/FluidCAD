// @screenshot view iso-ftr
import { sketch, extrude, circle, line } from 'fluidcad/core';
import { coincident, diameter, distance, fix, horizontal, vertical } from "fluidcad/constraints";

// Two upright walls, 80 mm and 180 mm in front of the origin.
sketch("xy", () => {
    const sg1 = line([-70, -100], [70, -100]);
    const sg2 = line([70, -100], [70, -80]);
    const sg3 = line([70, -80], [-70, -80]);
    const sg4 = line([-70, -80], [-70, -100]);
    coincident(sg1.end(), sg2.start());
    coincident(sg2.end(), sg3.start());
    coincident(sg3.end(), sg4.start());
    coincident(sg4.end(), sg1.start());
    horizontal(sg1);
    vertical(sg2);
    horizontal(sg3);
    vertical(sg4);
    fix(sg1.start(), [-70, -100]);
    distance(sg1.start(), sg1.end(), 140);
    distance(sg2.start(), sg2.end(), 20);
  })
extrude(110)

sketch("xy", () => {
    const sg5 = line([-70, -200], [70, -200]);
    const sg6 = line([70, -200], [70, -180]);
    const sg7 = line([70, -180], [-70, -180]);
    const sg8 = line([-70, -180], [-70, -200]);
    coincident(sg5.end(), sg6.start());
    coincident(sg6.end(), sg7.start());
    coincident(sg7.end(), sg8.start());
    coincident(sg8.end(), sg5.start());
    horizontal(sg5);
    vertical(sg6);
    horizontal(sg7);
    vertical(sg8);
    fix(sg5.start(), [-70, -200]);
    distance(sg5.start(), sg5.end(), 140);
    distance(sg6.start(), sg6.end(), 20);
  })
extrude(110)

// A Ø40 rod profile on the front plane. Its normal points along −Y, so the
// extrusion runs at both walls in turn.
sketch("front", () => {
    const c = circle([0, 55], 40);
    fix(c.center(), [0, 55]);
    diameter(c, 40);
  })
