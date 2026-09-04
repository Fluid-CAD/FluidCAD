// @screenshot view iso-ftr
import { sketch, plane, extrude } from 'fluidcad/core';
import { circle } from 'fluidcad/core';

sketch(plane("xy"), () => {
    circle([0, 300], 100)
})

extrude(100)

sketch(plane("front"), () => {
    circle([0, 0], 60);
  })

// highlight-next-line
extrude('first-face');
