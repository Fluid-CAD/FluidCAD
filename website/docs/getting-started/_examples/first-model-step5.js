import { sketch, extrude, fillet } from 'fluidcad/core';
import { rect } from 'fluidcad/core';

sketch("xy", () => {
    rect(100, 60).center().radius(8)
})

const box = extrude(30)

fillet(3, box.startEdges())
