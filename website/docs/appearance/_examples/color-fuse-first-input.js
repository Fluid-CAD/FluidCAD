import { sketch, extrude, color, select, fuse } from 'fluidcad/core';
import { circle } from 'fluidcad/core';
import { face } from 'fluidcad/filters';

sketch("xy", () => {
    circle([0, 0], 80)
})
extrude(50)

select(face().cylinder())
color("red")

sketch("xy", () => {
    circle([50, 0], 40)
})
extrude(25).new()

// Explicit fuse(): the FIRST input wins. Its color (red) propagates to the
// fused result. If the first input had no color, the result would stay
// uncolored even when later inputs are colored.
fuse()
