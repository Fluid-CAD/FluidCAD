import { sketch, tArc } from 'fluidcad/core';

sketch("xy", () => {
    tArc([-50, 0], [50, 0], 150)   // arc through two points, radius 150
})
