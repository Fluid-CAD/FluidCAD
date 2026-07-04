import { sketch, plane, loft, polygon, circle, bezier, mirror, local } from 'fluidcad/core';

const p1 = sketch("top", () => {
    polygon(4, 50, "circumscribed")
})

const p2 = sketch(plane("top", 80), () => {
    circle(30)
})

// One sketch, two rails: the bezier and its mirror each count as one guide
const g1 = sketch("right", () => {
    bezier([Math.sqrt(2) * 25, 0], [50, 40], [15, 80])
    mirror(local("y"))
}).reusable()

// highlight-next-line
loft(p1, p2).guides(g1)
