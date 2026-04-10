import { sketch } from 'fluidcad/core';
import { vLine, tArc } from 'fluidcad/core';

sketch("front", () => {
    vLine(100)
    tArc(50, 180)
    tArc(80, -270)
})
