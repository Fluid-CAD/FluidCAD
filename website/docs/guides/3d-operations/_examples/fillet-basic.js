import { sketch, extrude, fillet } from 'fluidcad/core';
import { rect } from 'fluidcad/core';

sketch("xy", () => {
    rect(100, 60).center()
})

const e = extrude(30)
fillet(5, e.endEdges())
fillet(3, e.startEdges())
