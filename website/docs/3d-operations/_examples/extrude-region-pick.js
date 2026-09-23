import { sketch, extrude } from 'fluidcad/core';
import { circle } from 'fluidcad/core';

sketch("xy", () => {
    const outer = circle([0, 0], 60);
    const inner = circle([0, 0], 30);
})

extrude(20).region('outer')   // written by the pick: the ring, whose outer loop is `outer`
