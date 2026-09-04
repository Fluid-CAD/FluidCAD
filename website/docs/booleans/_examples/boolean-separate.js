import { sketch, extrude } from 'fluidcad/core';
import { circle, line } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

sketch("xy", () => {
    const sg1 = line([-30, -30], [30, -30]);
    const sg2 = line([30, -30], [30, 30]);
    const sg3 = line([30, 30], [-30, 30]);
    const sg4 = line([-30, 30], [-30, -30]);
    coincident(sg1.end(), sg2.start());
    coincident(sg2.end(), sg3.start());
    coincident(sg3.end(), sg4.start());
    coincident(sg4.end(), sg1.start());
    horizontal(sg1);
    vertical(sg2);
    horizontal(sg3);
    vertical(sg4);
    fix(sg1.start(), [-30, -30]);
    distance(sg1.start(), sg1.end(), 60);
    distance(sg2.start(), sg2.end(), 60);
  })

// The box.
const box = extrude(30)

sketch("xy", () => {
    circle([80, 0], 40)
})

// highlight-start
// .new() — the dialog's New tab — keeps the cylinder a separate solid even
// though it touches the box. Two rows in the Shapes panel.
const cyl = extrude(30).new()
// highlight-end
