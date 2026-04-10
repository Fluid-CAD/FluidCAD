import { sketch, extrude } from 'fluidcad/core';
import { circle } from 'fluidcad/core';

sketch("xy", () => {
    circle(60)
    circle(30)
})

extrude(20).pick([20, 0])
