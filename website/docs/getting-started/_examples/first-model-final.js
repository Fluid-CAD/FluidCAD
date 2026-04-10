import { sketch, extrude, cut, fillet } from 'fluidcad/core';
import { rect, circle } from 'fluidcad/core';

sketch("xy", () => {
    rect(100, 60).center().radius(8)
})

const box = extrude(30)

sketch(box.endFaces(), () => {
    circle(40)
})

cut(15)

fillet(3, box.startEdges())
