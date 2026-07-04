import { sketch, loft, plane } from 'fluidcad/core';
import { circle, bezier } from 'fluidcad/core';

const s1 = sketch("xy", () => {
    circle(80)
})

const s2 = sketch(plane("xy", { offset: 60 }), () => {
    circle(80)
})

// A side rail bowing out to x ≈ 52 at mid-height
const rail = sketch("xz", () => {
    bezier([40, 0], [65, 30], [40, 60])
})

// highlight-next-line
loft(s1, s2).guides(rail)
