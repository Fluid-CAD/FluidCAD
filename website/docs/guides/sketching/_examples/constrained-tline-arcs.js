import { sketch, arc, move, tLine } from 'fluidcad/core';

sketch("xz", () => {
    move([-20, 0])
    const a1 = arc(100, 0, 180)
    move([50, -150])
    const a2 = arc(50, 270, 0)

    tLine(a1, a2)         // line tangent to both arcs
})
