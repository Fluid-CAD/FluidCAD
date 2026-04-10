import { sketch, extrude, copy } from 'fluidcad/core';
import { circle } from 'fluidcad/core';

sketch("xy", () => {
    circle([80, 0], 30)
})

extrude(25)

copy("circular", "z", {
    count: 6,
    angle: 360
})
