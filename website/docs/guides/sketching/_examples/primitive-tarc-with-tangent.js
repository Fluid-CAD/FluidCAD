import { sketch, tArc, move } from 'fluidcad/core';

sketch("xy", () => {
    tArc(60, 180)                  // default tangent (+X): chord is vertical, arc bulges right
    move([200, 0])
    tArc(60, 180, [0, 1])          // explicit +Y tangent: chord is horizontal, arc bulges up
})
