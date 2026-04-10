import { circle, copy, extrude, sketch } from 'fluidcad/core';

sketch("xy", () => {
    circle([150, 150], 100)
})

extrude()

copy("linear", "x", {
    count: 4,
    offset: 150
})
