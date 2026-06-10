import { sketch, circle, hMove, helix, sweep } from 'fluidcad/core';

const path = helix("z").height(60).pitch(10).radius(25).endRadius(10);

const profile = sketch("left", () => {
    hMove(25);
    circle(2);
});

sweep(path, profile);
