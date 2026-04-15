import { sketch, extrude, cut } from 'fluidcad/core';
import { rect, circle } from 'fluidcad/core';

sketch("xy", () => {
    rect(100, 60).centered()
})

const box = extrude(30)

sketch(box.endFaces(), () => {
    circle(40)
})

cut(15)
