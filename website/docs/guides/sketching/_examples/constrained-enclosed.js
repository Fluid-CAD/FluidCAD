import { sketch, circle, tCircle } from 'fluidcad/core';
import { enclosed } from 'fluidcad/constraints';

sketch("xy", () => {
    const c1 = circle(300).guide()
    const c2 = circle([60, 0], 240).guide()

    tCircle(enclosed(c1), enclosed(c2), 100)
})
