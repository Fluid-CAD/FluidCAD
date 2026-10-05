// @screenshot skip
import { sketch, circle, extrude, origin, region } from 'fluidcad/core';
import { coincident, concentric, diameter } from 'fluidcad/constraints';

const s = sketch("xy", () => {
    const outer = circle([0, 0], 100);
    const inner = circle([0, 0], 50);
    coincident(outer.center(), origin());
    concentric(inner, outer);
    diameter(outer, 100);
    diameter(inner, 50);
    region("ring", outer);
    region("disc", inner);
});

extrude(10, s).region("ring");
extrude(50, s).region("disc");
