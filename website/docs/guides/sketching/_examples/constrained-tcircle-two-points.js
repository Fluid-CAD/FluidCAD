import { sketch, tCircle } from 'fluidcad/core';

sketch("xy", () => {
    tCircle([-50, 0], [50, 0], 300)    // diameter 300, through both points
})
