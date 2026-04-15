import { sketch, extrude } from 'fluidcad/core';
import { rect, circle } from 'fluidcad/core';

sketch("xy", () => {
    rect(60, 60).centered()
})

extrude(30)

sketch("xy", () => {
    circle([0, 0], 40)
})

extrude(50)
