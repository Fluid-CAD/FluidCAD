import { sketch, extrude } from 'fluidcad/core';
import { rect } from 'fluidcad/core';

sketch("xy", () => {
    rect(100, 60).center()
})

// highlight-next-line
extrude(30).draft(5)
