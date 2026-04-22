import { circle, copy, extrude, sketch } from 'fluidcad/core';

sketch("xy", () => {
    const c = circle([0, 0], 20)
    copy("linear", "x", { count: 5, offset: 40 }, c)
})

extrude(10)
