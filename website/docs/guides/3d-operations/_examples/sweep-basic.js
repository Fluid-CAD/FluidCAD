import { sketch, sweep } from 'fluidcad/core';
import { circle, vLine, tArc } from 'fluidcad/core';

const profile = sketch("top", () => {
    circle(40)
    circle(20)
})

const spine = sketch("front", () => {
    vLine(100)
    tArc(50, 180)
    tArc(80, -270)
})

sweep(spine, profile)
