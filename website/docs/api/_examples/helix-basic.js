import { sketch, circle, helix, sweep } from 'fluidcad/core';

const path = helix("z").radius(15).pitch(10).turns(5);

const profile = sketch("left", () => {
    circle([15, 0], 2);
});

sweep(path, profile);
