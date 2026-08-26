import { cylinder, sketch, circle, helix, sweep } from 'fluidcad/core';

cylinder(15, 50);

const path = helix("z").height(50).radius(15).pitch(5)
    .startOffset(-5).endOffset(5);

const profile = sketch("left", () => {
    circle([15, 0], 3);
  });

sweep(path, profile);
