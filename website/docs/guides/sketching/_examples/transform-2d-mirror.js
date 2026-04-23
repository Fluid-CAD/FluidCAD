import { bezier, extrude, line, mirror, move, sketch } from 'fluidcad/core';

sketch("xy", () => {
    move([0, 0])
    const profile = bezier([0, 0], [60, 0], [40, 80], [120, 100])
    line([120, 0])
    line([0, 0])

    mirror("y", profile)
})

extrude(20)
