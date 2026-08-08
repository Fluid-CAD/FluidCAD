import { sketch, plane, loft, polygon, circle } from 'fluidcad/core';

const p1 = sketch("top", () => {
    polygon(4, 50, "circumscribed")
})

const p2 = sketch(plane("top", 80), () => {
    circle(30)
})

// The surface leaves the square and arrives at the circle perpendicular
// to their planes, swelling the transition outward
loft(p1, p2)
    // highlight-start
    .startCondition('normal', 1)
    .endCondition('normal', 1)
    // highlight-end
