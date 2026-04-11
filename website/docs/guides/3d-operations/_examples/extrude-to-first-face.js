// @screenshot waitForInput
import { sketch, plane, extrude } from 'fluidcad/core';
import { circle, rect } from 'fluidcad/core';

sketch(plane("xy"), () => {
    rect([0, 250], 50, 50)
})

extrude(100)

sketch(plane("front"), () => {
    circle(60)
})

// highlight-next-line
extrude('first-face');
