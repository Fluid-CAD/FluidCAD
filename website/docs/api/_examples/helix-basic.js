import { sketch, circle, hMove, helix, sweep } from 'fluidcad/core';

const path = helix("z").radius(15).pitch(10).turns(5);

const profile = sketch("left", () => {
    hMove(15);
    circle(2);
});

sweep(path, profile);
