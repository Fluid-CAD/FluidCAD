// @screenshot waitForInput
import { select, sketch, plane, extrude } from 'fluidcad/core';
import { face } from 'fluidcad/filters';
import { circle, rect } from 'fluidcad/core';

sketch(plane("xy"), () => {
    rect([100, 250], 50, 50)
})

extrude(100);

// highlight-next-line
const targetFace = select(face().onPlane("-xz", 250))

sketch(plane("front"), () => {
    circle(60)
})

// highlight-next-line
extrude(targetFace);
