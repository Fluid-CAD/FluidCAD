import { sketch } from 'fluidcad/core';
import { line, vLine, hLine } from 'fluidcad/core';

sketch("xy", () => {
    line([0, 0], [50, 0])
    vLine(40)
    hLine(-50)
    line([0, 0])
})
