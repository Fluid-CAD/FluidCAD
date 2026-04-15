import { sketch, loft, plane } from 'fluidcad/core';
import { circle, rect } from 'fluidcad/core';

const s1 = sketch("xy", () => {
    circle(100)
})

const s2 = sketch(plane("xy", { offset: 100 }), () => {
    rect(80).centered()
})

loft(s1, s2)
