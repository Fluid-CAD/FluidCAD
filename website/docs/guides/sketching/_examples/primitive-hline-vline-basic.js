import { sketch, hLine, vLine } from 'fluidcad/core';

sketch("xy", () => {
    hLine(100)     // 100 units to the right
    vLine(60)      // 60 units up
    hLine(-100)    // 100 units left (negative)
    vLine(-60)     // 60 units down (negative) — closes the rectangle
})
