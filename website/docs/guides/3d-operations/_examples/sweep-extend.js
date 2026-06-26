import { sketch, sweep } from 'fluidcad/core';
import { circle, vLine, tArc } from 'fluidcad/core';

const profile = sketch("top", () => {
    circle(40)
})

const spine = sketch("front", () => {
    vLine(100)
    tArc(60, 90)
})

// highlight-next-line
sweep(spine, profile).extend("end", 80)
