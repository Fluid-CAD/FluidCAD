// @screenshot skip
import { sketch, circle, extrude, origin } from 'fluidcad/core';
import { coincident, diameter } from 'fluidcad/constraints';

const s = sketch("xy", () => {
    const c = circle([0, 0], 60);
    coincident(c.center(), origin());
    diameter(c, 60);
});

extrude(20, s);
extrude(-50, s);
