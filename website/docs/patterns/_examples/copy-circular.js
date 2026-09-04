import { sketch, extrude, copy } from 'fluidcad/core';
import { circle } from 'fluidcad/core';

sketch("xy", () => {
    circle([80, 0], 30)
})

// One cylinder, 80 from the Z axis.
extrude(25)

// highlight-start
// Six instances spread evenly over a full turn around world Z.
copy("circular", "z", {
    count: 6,
    angle: 360
})
// highlight-end
