import { sketch, extrude, color, select } from 'fluidcad/core';
import { rect } from 'fluidcad/core';
import { face } from 'fluidcad/filters';

sketch("xy", () => {
    rect(100, 60).centered()
})

const e = extrude(30)

select(face().circle())
color("red")

color("orange", e.endFaces())
