import { sketch, circle, tCircle } from 'fluidcad/core';
import { outside, enclosing } from 'fluidcad/constraints';

sketch("xy", () => {
    const c1 = circle(160).guide()
    const c2 = circle([200, 0], 60).guide()

    tCircle(c1, enclosing(c2), 160)         // tangent to c1, enclosing c2
    tCircle(outside(c1), outside(c2), 160)  // outside both
})
