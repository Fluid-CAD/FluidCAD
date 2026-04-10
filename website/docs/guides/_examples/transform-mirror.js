// @screenshot showAxes
import { extrude, mirror, sketch } from 'fluidcad/core';
import { rect, move } from 'fluidcad/core';

sketch("xy", () => {
    move([10, 0])
    rect(50, 30)
})

extrude(20)

mirror("yz")
