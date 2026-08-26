import { sketch } from 'fluidcad/core';
import { circle } from 'fluidcad/core';

sketch("xy", () => {
    circle([0, 0], 50);
    circle([30, 20], 40)
  })
