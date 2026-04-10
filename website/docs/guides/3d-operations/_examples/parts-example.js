import { part, sketch, extrude } from 'fluidcad/core';
import { rect, circle } from 'fluidcad/core';

part("base", () => {
    sketch("xy", () => {
        rect(120, 80).center()
    })
    extrude(10)
})

part("pillar", () => {
    sketch("xy", () => {
        circle(30)
    })
    extrude(60)
})
