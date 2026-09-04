import { sketch, extrude, cut, repeat, line } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

sketch("xy", () => {
    const sg1 = line([-150, -52], [150, -52]);
    const sg2 = line([150, -52], [150, 52]);
    const sg3 = line([150, 52], [-150, 52]);
    const sg4 = line([-150, 52], [-150, -52]);
    coincident(sg1.end(), sg2.start());
    coincident(sg2.end(), sg3.start());
    coincident(sg3.end(), sg4.start());
    coincident(sg4.end(), sg1.start());
    horizontal(sg1);
    vertical(sg2);
    horizontal(sg3);
    vertical(sg4);
    fix(sg1.start(), [-150, -52]);
    distance(sg1.start(), sg1.end(), 300);
    distance(sg2.start(), sg2.end(), 104);
  })

const tray = extrude(50)

// One pocket
sketch(tray.endFaces(), () => {
    const sg5 = line([-143, -45], [-113, -45]);
    const sg6 = line([-113, -45], [-113, -5]);
    const sg7 = line([-113, -5], [-143, -5]);
    const sg8 = line([-143, -5], [-143, -45]);
    coincident(sg5.end(), sg6.start());
    coincident(sg6.end(), sg7.start());
    coincident(sg7.end(), sg8.start());
    coincident(sg8.end(), sg5.start());
    horizontal(sg5);
    vertical(sg6);
    horizontal(sg7);
    vertical(sg8);
    fix(sg5.start(), [-143, -45]);
    distance(sg5.start(), sg5.end(), 30);
    distance(sg6.start(), sg6.end(), 40);
  })

const pocket = cut(30).draft(-10)

// Repeat the pocket in a 7x2 grid
repeat("linear", ["x", "y"], {
    count: [7, 2],
    length: [255, 50]
}, pocket)
