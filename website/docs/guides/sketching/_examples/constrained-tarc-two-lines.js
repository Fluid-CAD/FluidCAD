import { sketch, aLine, vLine, move, tArc } from 'fluidcad/core';

sketch("xy", () => {
    const l1 = aLine(45, 150).guide()
    move([-50, 0])
    const l2 = vLine(100).guide()

    tArc(l1, l2, 50)  // fillet-like arc between two lines
})
