import { sketch } from 'fluidcad/core';
import { circle, tCircle } from 'fluidcad/core';
import { enclosed } from 'fluidcad/constraints';

sketch("xy", () => {
    const c1 = circle(200).guide()
    const c2 = circle([200, 0], 160).guide()

    tCircle(enclosed(c1), enclosed(c2), 80).guide()
})
