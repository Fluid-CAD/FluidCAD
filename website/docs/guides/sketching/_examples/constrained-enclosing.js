import { sketch } from 'fluidcad/core';
import { circle, tArc } from 'fluidcad/core';
import { enclosing } from 'fluidcad/constraints';

sketch("xy", () => {
    const c1 = circle(100).guide()
    const c2 = circle([200, 0], 80).guide()

    tArc(enclosing(c1), enclosing(c2), 60).guide()
})
