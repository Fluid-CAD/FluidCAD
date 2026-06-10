import { cylinder, sketch, move, circle, helix, sweep } from 'fluidcad/core';

cylinder(15, 50);

const path = helix("z").height(50).radius(15).pitch(5)
    .startOffset(-5).endOffset(5);

const profile = sketch("left", () => {
    move([15, 0]);
    circle(3);
});

sweep(path, profile);
