import { sketch, extrude, color, select, fuse } from 'fluidcad/core';
import { circle } from 'fluidcad/core';
import { face } from 'fluidcad/filters';

sketch("xy", () => {
    circle([0, 0], 80)
})
extrude(50).new()

sketch("xy", () => {
    circle([50, 0], 40)
})
extrude(25).new()

// Color the SECOND solid only.
select(face().onPlane("xy", 25))
color("red")

// First input has no color → the fused result stays uncolored, even though
// the second input is red.
fuse()
