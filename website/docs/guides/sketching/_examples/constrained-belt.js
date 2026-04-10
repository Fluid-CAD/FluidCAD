import { sketch, move } from 'fluidcad/core';
import { circle, tLine, tArc } from 'fluidcad/core';
import { outside, enclosing } from 'fluidcad/constraints';

sketch("xy", () => {
    const c1 = circle(100).guide()
    const c2 = circle([200, 0], 60).guide()

    const t1 = tLine(outside(c1), outside(c2))
    const t2 = tLine(enclosing(c1), enclosing(c2))
    tArc(t1.end(), t2.end(), t1.tangent())
    move(t1.start())
    tArc(t2.start(), t1.start(), t1.tangent().reverse())
})
