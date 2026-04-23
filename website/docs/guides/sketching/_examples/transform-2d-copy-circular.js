import { circle, copy, extrude, sketch } from 'fluidcad/core';

sketch("xy", () => {
    const c = circle([80, 0], 15)
    copy("circular", [0, 0], { count: 8, angle: 360 }, c)
})

extrude(10)
