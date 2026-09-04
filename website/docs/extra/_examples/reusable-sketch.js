import { sketch, circle, extrude } from 'fluidcad/core';

sketch("xy", () => {
    circle([0, 0], 60);
  }).reusable();

extrude(20);

extrude(50);
