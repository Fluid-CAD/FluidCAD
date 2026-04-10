import { sketch, extrude, chamfer } from 'fluidcad/core';
import { rect } from 'fluidcad/core';

sketch("xy", () => {
    rect(100, 60).center()
})

const e = extrude(30)
chamfer(3, e.endEdges())
