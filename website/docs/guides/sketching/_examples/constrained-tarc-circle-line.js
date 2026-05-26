import { sketch, aLine, circle, tArc } from 'fluidcad/core';

sketch("xy", () => {
    const l = aLine(45, 150).guide()
    const c = circle([100, 0], 40).guide()

    tArc(c, l, 50)    // radius 50, tangent to both
})
