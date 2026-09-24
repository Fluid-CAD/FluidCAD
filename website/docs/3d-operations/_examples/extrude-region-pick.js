import { sketch, circle, region, extrude } from 'fluidcad/core';

const s = sketch("xy", () => {
    const outer = circle([0, 0], 60);
    const inner = circle([0, 0], 30);
    region('r1', outer);         // written by the pick: the ring, whose outer loop is `outer`
})

extrude(20, s).region('r1')
