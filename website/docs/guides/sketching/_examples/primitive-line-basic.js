import { sketch, line } from 'fluidcad/core';
import { coincident } from "fluidcad/constraints";

sketch("xy", () => {
    const sg1 = line([0, 0], [100, 0]);
    const sg2 = line([100, 0], [120, 60]);
    const sg3 = line([120, 60], [20, 80]);
    const sg4 = line([20, 80], [0, 0]);
    coincident(sg1.end(), sg2.start());
    coincident(sg2.end(), sg3.start());
    coincident(sg3.end(), sg4.start());
    coincident(sg4.end(), sg1.start());
  })
