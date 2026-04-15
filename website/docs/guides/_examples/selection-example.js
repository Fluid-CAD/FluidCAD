import { sketch, extrude, fillet, select, color } from 'fluidcad/core';
import { rect } from 'fluidcad/core';
import { edge, face } from 'fluidcad/filters';

sketch("xy", () => {
    rect(80, 60).centered()
})

const e = extrude(40)

// Round only the vertical edges
select(edge().verticalTo("xy"))
fillet(8)

// Color the top face
select(face().onPlane("xy", 40))
color("steelblue")
