import { sketch, circle, move, tArc } from 'fluidcad/core';
import { outside } from 'fluidcad/constraints';

sketch("xy", () => {
    const c = circle([100, 0], 40).guide()
    const p = [100, 50]
    move(p)

    tArc(outside(c), p, 100)   // arc from circle to point, radius 100
})
