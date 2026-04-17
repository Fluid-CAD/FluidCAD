import { sketch, sweep } from 'fluidcad/core';
import { line, vLine, tArc } from 'fluidcad/core';

const profile = sketch("top", () => {
    line([-30, 0], [30, 0])
})

const spine = sketch("front", () => {
    vLine(100)
    tArc(50, 180)
})

// highlight-next-line
sweep(spine, profile).thin(5).new()
