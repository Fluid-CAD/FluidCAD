// @screenshot showAxes
import { axis, extrude, rotate, sketch, line } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

sketch("xy", () => {
    const sg1 = line([100, 100], [300, 100]);
    const sg2 = line([300, 100], [300, 200]);
    const sg3 = line([300, 200], [100, 200]);
    const sg4 = line([100, 200], [100, 100]);
    coincident(sg1.end(), sg2.start());
    coincident(sg2.end(), sg3.start());
    coincident(sg3.end(), sg4.start());
    coincident(sg4.end(), sg1.start());
    horizontal(sg1);
    vertical(sg2);
    horizontal(sg3);
    vertical(sg4);
    fix(sg1.start(), [100, 100]);
    distance(sg1.start(), sg1.end(), 200);
    distance(sg2.start(), sg2.end(), 100);
  })

extrude(20)

const a = axis("z", { offsetX: 90, offsetY: 90 })

rotate(a, 90, true)
rotate(a, 180, true)
