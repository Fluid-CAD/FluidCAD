import { sketch, extrude } from 'fluidcad/core';
import { rect } from 'fluidcad/core';

sketch("xy", () => {
    rect(100, 60).centered()
})

// highlight-next-line
extrude(40).symmetric()
