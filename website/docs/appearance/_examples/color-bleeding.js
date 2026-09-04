import { sketch, extrude, color, select } from 'fluidcad/core';
import { circle } from 'fluidcad/core';
import { face } from 'fluidcad/filters';

sketch("xy", () => {
    circle([0, 0], 80)
})
extrude(50)

select(face().cylinder())
color("red")

// A second extrude fuses into the colored solid. Faces that came from the
// new extrude inherit the red color via "color bleeding" — colors spread
// across edges to adjacent uncolored new faces.
sketch("xy", () => {
    circle([50, 0], 40)
})
extrude(25)
