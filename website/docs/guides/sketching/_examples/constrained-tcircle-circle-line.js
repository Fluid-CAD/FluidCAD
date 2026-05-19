import { sketch, aLine, circle, tCircle } from 'fluidcad/core';

sketch("xy", () => {
    const l = aLine(45, 150).guide()
    const c = circle([100, 0], 60).guide()

    tCircle(c, l, 100)
})
