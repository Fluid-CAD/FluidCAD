import { sketch, extrude, project, offset } from 'fluidcad/core';
import { rect } from 'fluidcad/core';

sketch("xy", () => {
    rect(100, 60).centered().radius(8)
})

const e = extrude(30)

sketch(e.endFaces(), () => {
    project(e.endFaces())
    offset(-5, true)
})
