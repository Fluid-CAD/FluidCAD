import { sketch, aLine, vLine, move, tCircle } from 'fluidcad/core';

sketch("xy", () => {
    const l1 = aLine(45, 300).guide()
    move([-50, 0])
    const l2 = vLine(300).guide()

    tCircle(l1, l2, 200, true)   // diameter 200, tangent to both lines
})
