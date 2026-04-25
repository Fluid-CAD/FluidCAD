import { sketch, extrude, color, select, fillet } from 'fluidcad/core';
import { circle } from 'fluidcad/core';
import { face } from 'fluidcad/filters';

sketch("xy", () => {
    circle(40)
})

const e = extrude(50)

select(face().onPlane("xy", 50))
color("orange")

// Coloring before the fillet still works — the orange survives the
// modification, and the new arc face inherits the color from its neighbor.
fillet(5, e.endEdges())
