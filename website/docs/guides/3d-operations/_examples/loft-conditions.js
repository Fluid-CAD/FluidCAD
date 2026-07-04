import { sketch, loft, plane } from 'fluidcad/core';
import { circle } from 'fluidcad/core';

const s1 = sketch("xy", () => {
    circle(80)
})

const s2 = sketch(plane("xy", { offset: 60 }), () => {
    circle(80)
})

// Tangent takeoff at both ends turns the straight loft into a barrel
// highlight-next-line
loft(s1, s2).startCondition('tangent').endCondition('tangent')
