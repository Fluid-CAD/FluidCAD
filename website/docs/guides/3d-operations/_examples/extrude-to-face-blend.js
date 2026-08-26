// @screenshot waitForInput
import { color, extrude, plane, sketch, vMove } from 'fluidcad/core';
import { line } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

sketch(plane("xy"), () => {
    const sg1 = line([-100, -50], [100, -50]);
    const sg2 = line([100, -50], [100, 50]);
    const sg3 = line([100, 50], [-100, 50]);
    const sg4 = line([-100, 50], [-100, -50]);
    coincident(sg1.end(), sg2.start());
    coincident(sg2.end(), sg3.start());
    coincident(sg3.end(), sg4.start());
    coincident(sg4.end(), sg1.start());
    horizontal(sg1);
    vertical(sg2);
    horizontal(sg3);
    vertical(sg4);
    fix(sg1.start(), [-100, -50]);
    distance(sg1.start(), sg1.end(), 200);
    distance(sg2.start(), sg2.end(), 100);
  })

const e = extrude(20).draft(15)

// highlight-next-line
color("red", e.sideFaces(0));

sketch(plane("yz", { offset: 100 }), () => {
    const sg5 = line([-10, 10], [10, 10]);
    const sg6 = line([10, 10], [10, 30]);
    const sg7 = line([10, 30], [-10, 30]);
    const sg8 = line([-10, 30], [-10, 10]);
    coincident(sg5.end(), sg6.start());
    coincident(sg6.end(), sg7.start());
    coincident(sg7.end(), sg8.start());
    coincident(sg8.end(), sg5.start());
    horizontal(sg5);
    vertical(sg6);
    horizontal(sg7);
    vertical(sg8);
    fix(sg5.start(), [-10, 10]);
    distance(sg5.start(), sg5.end(), 20);
    distance(sg6.start(), sg6.end(), 20);
  });

// highlight-next-line
extrude(e.sideFaces(0));
