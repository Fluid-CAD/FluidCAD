import { sketch, extrude } from 'fluidcad/core';
import { rect, circle } from 'fluidcad/core';

sketch("xy", () => {
    rect(60, 60).centered()
})

const box = extrude(30)

sketch("xy", () => {
    circle([80, 0], 40)
})

const cyl = extrude(30).new()
