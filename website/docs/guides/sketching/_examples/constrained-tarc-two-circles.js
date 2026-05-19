import { sketch, circle, tArc } from 'fluidcad/core';
import { outside } from 'fluidcad/constraints';

sketch("xy", () => {
    const c1 = circle(160).guide()
    const c2 = circle([200, 0], 60).guide()

    tArc(outside(c1), outside(c2), 80)     // radius 80, outside both
})
