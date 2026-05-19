import { sketch, hLine, tArc } from 'fluidcad/core';

sketch("xy", () => {
    hLine(80)             // pen ends at [80, 0], tangent +X
    tArc([160, 80])       // arc that leaves tangent to +X and lands on [160, 80]
})
