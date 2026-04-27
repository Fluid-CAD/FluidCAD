import { hLine, vLine, move, sketch } from 'fluidcad/core';

sketch("xy", () => {
    hLine(100).centered()
    move([0, 0])
    vLine(60).centered()
})
