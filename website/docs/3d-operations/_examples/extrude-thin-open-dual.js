import { sketch, extrude } from 'fluidcad/core';
import { line } from 'fluidcad/core';
import { coincident, horizontal, vertical } from "fluidcad/constraints";

sketch("xy", () => {
    const sg1 = line([0, 0], [80, 0]);
    const sg2 = line([80, 0], [80, 40]);
    horizontal(sg1);
    coincident(sg1.end(), sg2.start());
    vertical(sg2);
  })

// highlight-next-line
extrude(20).thin(5, -3).new()
