import { sketch, extrude } from 'fluidcad/core';
import { hLine, vLine } from 'fluidcad/core';

sketch("xy", () => {
    hLine([0, 0], 80)
    vLine(40)
})

// highlight-next-line
extrude(20).thin(5).new()
